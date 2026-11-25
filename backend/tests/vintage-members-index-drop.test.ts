// Migration 0135 drops analytics_vintage_members_vintage_idx (issue 1717).
//
// The vintages freeze inserts every member row of every vintage, and each row
// writes every index on the table. The (vintage_id) index repeats the leading
// column of the UNIQUE (vintage_id, source_value_version_id) index, so it cost
// one index write per row and served nothing the unique index cannot.
//
//   * 0135 on a database that still has the index drops it, and a second run
//     changes nothing (IF EXISTS); the remaining indexes are the snapshot's;
//   * the header declares compat additive, and the file sets lock_timeout and
//     only drops that one index IF EXISTS;
//   * every registered statement that reads analytics_vintage_members by
//     vintage_id plans on an index, never a sequential scan and never the
//     dropped one. Both remaining indexes lead with vintage_id: the UNIQUE
//     (vintage_id, source_value_version_id) and (vintage_id, id) from 0134;
//     the planner may take either (the second is narrower). The table is loaded with 300 vintages of 1,000 members each
//     and ANALYZEd, so a sequential scan is a real option the planner rejects.
//     The plans before and after the drop are printed for the PR.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { parseMigrationHeader } from "../src/db/schema-compat.ts";
import { registeredSites } from "../src/db/registry.ts";
import "../src/analytics/store/run-ledger-store.ts";
import "../src/analytics/store/public-archive-store.ts";
import "../src/api/routes/public-analytics.ts";
import { flatten, type ExplainResult } from "../../scripts/release/jobs-query-plans.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { vacuumAnalyzeAsOwner } from "./support/vacuum-as-owner.ts";

useCleanDatabase(import.meta.file);

const FILE = "0135_drop_vintage_members_vintage_idx.sql";
const M0135 = readFileSync(join(import.meta.dir, "..", "migrations", FILE), "utf8");
const DROPPED = "analytics_vintage_members_vintage_idx";
const RECREATE = `CREATE INDEX ${DROPPED} ON analytics_vintage_members (vintage_id)`;
const UNIQUE = "analytics_vintage_members_vintage_id_source_value_version_i_key";
const VINTAGE_ID_ID = "analytics_vintage_members_vintage_id_idx";
const VINTAGES = 300;
const MEMBERS = 1_000;

async function asOwner(text: string): Promise<void> {
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(text);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

const indexes = () =>
  fixtureDb<{ name: string; def: string; oid: number }[]>`
    SELECT c.relname AS name, pg_get_indexdef(c.oid) AS def, c.oid::int AS oid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'analytics_vintage_members'::regclass
     ORDER BY 1`;

function probe(site: string): string {
  const declaration = registeredSites().find((d) => d.site === site);
  if (!declaration?.probe) throw new Error(`no registered probe for ${site}`);
  return declaration.probe.statement;
}

class Rollback extends Error {}

/** EXPLAIN ANALYZE of a statement with its params, after `before`, never committed. */
async function explain(statement: string, params: readonly (string | number)[], before = ""): Promise<{ json: ExplainResult; text: string }> {
  let json: ExplainResult | undefined;
  let text = "";
  await fixtureDb
    .begin(async (tx) => {
      if (before) await tx.unsafe(before);
      const rows = (await tx.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`, params as never[])) as unknown as {
        "QUERY PLAN": ExplainResult[];
      }[];
      json = rows[0]!["QUERY PLAN"][0]!;
      const lines = (await tx.unsafe(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${statement}`, params as never[])) as unknown as {
        "QUERY PLAN": string;
      }[];
      text = lines.map((l) => l["QUERY PLAN"]).join("\n");
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return { json: json!, text };
}

/** The indexes the plan reads analytics_vintage_members through; "Seq Scan" for a sequential read. */
function memberReads(result: ExplainResult): string[] {
  return flatten(result.Plan)
    .filter((n) => n["Relation Name"] === "analytics_vintage_members" || (n["Index Name"] ?? "").startsWith("analytics_vintage_members"))
    .map((n) => (n["Node Type"] === "Seq Scan" ? "Seq Scan" : String(n["Index Name"])));
}

let vintageId = "";
const LOOKUPS = () => [
  { site: "src/analytics/store/run-ledger-store:resolveVintageMembers.runs", params: [vintageId], allowed: [UNIQUE, VINTAGE_ID_ID] },
  { site: "src/api/routes/public-analytics:listVintageMembers", params: [0, vintageId, 0, 100], allowed: [UNIQUE, VINTAGE_ID_ID] },
  {
    site: "src/analytics/store/public-archive-store:analytics_vintage_members.step",
    params: [0, String(Number(vintageId) - 1), vintageId, 0, 0],
    allowed: [UNIQUE, VINTAGE_ID_ID, "analytics_vintage_members_pkey"],
  },
];

describe("migration 0135 (issue 1717)", () => {
  test("on a database that still has the index: 0135 drops it, leaves the snapshot's indexes, and a second run changes nothing", async () => {
    const snapshot = await indexes();
    expect(snapshot.map((i) => i.name)).not.toContain(DROPPED);

    await asOwner(RECREATE);
    expect((await indexes()).map((i) => i.name)).toContain(DROPPED);

    await asOwner(M0135);
    const migrated = await indexes();
    expect(migrated.map(({ name, def }) => ({ name, def }))).toEqual(snapshot.map(({ name, def }) => ({ name, def })));

    await asOwner(M0135);
    expect(await indexes()).toEqual(migrated);
  });

  test("0135's header declares compat additive; the file sets lock_timeout and only drops the one index IF EXISTS", () => {
    expect(parseMigrationHeader(FILE, M0135)).toMatchObject({ filename: FILE, compat: "additive", metadataVersion: 1 });
    const statements = M0135.split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(["SET LOCAL lock_timeout = '2s'", `DROP INDEX IF EXISTS ${DROPPED}`]);
  });
});

describe("lookups by vintage_id after the drop", () => {
  beforeAll(async () => {
    await fixtureDb.unsafe(`
      INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
      VALUES (md5('acq-1717')::uuid, 'fixture', 'test:1', 'members-1717', '2026-09-21'::timestamptz)`);
    await fixtureDb.unsafe(`
      INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, knowledge_time)
      SELECT md5('acq-1717')::uuid, 'series:k' || (d % 20), '2020-01-01'::date + d, d, 'initial', '2026-09-21'::timestamptz
        FROM generate_series(0, ${2 * MEMBERS - 1}) d`);
    await fixtureDb.unsafe(`
      INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
      VALUES ('members-1717', 'v1', '{}'::jsonb, repeat('a', 64))`);
    await fixtureDb.unsafe(`
      INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
      SELECT '00000000-0000-4000-8000-000000001717', '2026-11-20', 'members-1717', 'fixture', id, 'test'
        FROM analytics_ledger_methodology_versions WHERE tool_id = 'members-1717'`);
    await fixtureDb.unsafe(`
      INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
                                           build_identity, manifest, manifest_digest, member_count)
      SELECT r.id, 'members-1717-' || t, '2026-11-20'::timestamptz, '2026-11-20', r.methodology_version_id, 'test', '{}'::jsonb, repeat('b', 64), ${MEMBERS}
        FROM analytics_ledger_runs r, generate_series(1, ${VINTAGES}) t
       WHERE r.run_key = '00000000-0000-4000-8000-000000001717'
       ORDER BY t`);
    // Every other ledger id, so no two members of a vintage form a run: one member row each.
    await fixtureDb.unsafe(`
      INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
      SELECT v.id, s.id, s.source_key
        FROM analytics_data_vintages v
        JOIN LATERAL (SELECT id, source_key FROM source_value_versions WHERE acquisition_id = md5('acq-1717')::uuid
                       AND (id + v.id) % 2 = 0 ORDER BY id LIMIT ${MEMBERS}) s ON true
       WHERE v.tool_id LIKE 'members-1717-%'
       ORDER BY v.id, s.id`);
    const [row] = await fixtureDb<{ id: string; n: number }[]>`
      SELECT (SELECT id::text FROM analytics_data_vintages WHERE tool_id = ${`members-1717-${VINTAGES / 2}`}) AS id,
             (SELECT count(*)::int FROM analytics_vintage_members) AS n`;
    vintageId = row!.id;
    expect(row!.n).toBe(VINTAGES * MEMBERS);
    await vacuumAnalyzeAsOwner("analytics_vintage_members", "analytics_data_vintages", "source_value_versions");
  }, 300_000);

  test("every registered vintage_id lookup plans on a remaining index, never a Seq Scan and never the dropped index", async () => {
    const printed: string[] = [];
    for (const { site, params, allowed } of LOOKUPS()) {
      const statement = probe(site);
      const beforeDrop = await explain(statement, params, RECREATE);
      const after = await explain(statement, params);
      printed.push(`### ${site}\n-- before 0135 (with ${DROPPED})\n${beforeDrop.text}\n-- after 0135\n${after.text}`);
      const reads = memberReads(after.json);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((r) => !allowed.includes(r))).toEqual([]);
    }
    if (process.env.RM_PRINT_PLANS) console.log(printed.join("\n\n"));
  });
});

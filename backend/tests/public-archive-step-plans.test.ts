// The public archive's day step reads indexes only at production size
// (issue 1690, migration 0134).
//
// A format 1 backup.json is built from a chain of day steps, one per table per
// day since the first row (src/analytics/store/public-archive-store.ts,
// dayMarks), and after an api restart the chain is rebuilt from the first day.
// A step finds the first id at or after a day boundary. Through the primary key
// that read each row's time from the heap (about 2 KB a row on
// analytics_overwrite_events), and the members step's max(id) read every
// member of the day's vintages from the heap. Migration 0134 adds
// (id) INCLUDE (time) indexes and (vintage_id, id) on the members.
//
// The three wide tables are loaded to production's shape over 60 days
// (source_value_versions 552k rows over 74 keys, analytics_overwrite_events
// 200k rows of about 2 KB, analytics_vintage_members 1M rows over 60
// vintages), then VACUUMed and ANALYZEd. Then:
//   * each table's step, in the generic plan the api's prepared statement runs
//     after five days and in the plan for one day's values, has no Seq Scan,
//     its next-id read (the members' max(id)) is an Index Only Scan on the new
//     index, EXPLAIN ANALYZE reports 0 heap fetches, and no node but a one-row
//     probe (the table's first row, for first_time) reads the heap;
//   * red control: without the new indexes the same judge fails;
//   * one cold backup.json build over the 60 days runs no statement for 1 s
//     or more (pg_stat_statements' max_exec_time);
//   * every backup.json and archive body built with the indexes is
//     byte-identical, with the same ETag, to the one built without them.
// The step statements did not change; the indexes change their plans only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { registeredSites } from "../src/db/registry.ts";
import {
  _resetArchiveForTests,
  _setArchiveClockForTests,
  _setArchiveJunctionForTests,
  archiveBodyStream,
  fileIn,
  listBackupIds,
  recordFor,
  type BuiltRecord,
} from "../src/analytics/store/public-archive-store.ts";
import { flatten, type ExplainResult, type PlanNode } from "../../scripts/release/jobs-query-plans.ts";
import { adminExec } from "./support/cluster.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { vacuumAnalyzeAsOwner } from "./support/vacuum-as-owner.ts";

useCleanDatabase(import.meta.file);

const DAYS = 60;
const FIRST_DAY = "2002-01-01";
// 02:00 the day after the last row: every day boundary is sealed.
const NOW = Date.parse("2002-03-02T02:00:00Z");
const NEW_INDEXES = ["source_value_versions_id_time_idx", "analytics_overwrite_events_id_time_idx", "analytics_vintage_members_vintage_id_idx"];

interface WideTable {
  readonly table: string;
  readonly index: string;
  /** The step's params for the day `day` (0-based), from the seed's own rows. */
  params(day: number): Promise<unknown[]>;
}

const dayStart = (day: number) => new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + day * 86_400_000).toISOString();

async function lastIdBefore(table: string, time: string, column: string): Promise<string> {
  const [r] = await fixtureDb.unsafe(`SELECT coalesce(max(id), 0)::text AS id FROM ${table} WHERE ${column} < $1::timestamptz`, [time]);
  return String(r!.id);
}

const WIDE: readonly WideTable[] = [
  {
    table: "source_value_versions",
    index: "source_value_versions_id_time_idx",
    params: async (day) => {
      const a = await lastIdBefore("source_value_versions", dayStart(day - 1), "knowledge_time");
      return [a, dayStart(day), a, a, a];
    },
  },
  {
    table: "analytics_overwrite_events",
    index: "analytics_overwrite_events_id_time_idx",
    params: async (day) => {
      const a = await lastIdBefore("analytics_overwrite_events", dayStart(day - 1), "recorded_at");
      return [a, dayStart(day), a, a, a];
    },
  },
  {
    table: "analytics_vintage_members",
    index: "analytics_vintage_members_vintage_id_idx",
    params: async (day) => {
      const prevVin = await lastIdBefore("analytics_data_vintages", dayStart(day - 1), "created_at");
      const vin = await lastIdBefore("analytics_data_vintages", dayStart(day), "created_at");
      const [r] = await fixtureDb.unsafe(`SELECT coalesce(max(id), 0)::text AS id FROM analytics_vintage_members WHERE vintage_id <= $1`, [prevVin]);
      const a = String(r!.id);
      return [a, prevVin, vin, a, a];
    },
  },
];

function stepOf(table: string): string {
  const declaration = registeredSites().find((d) => d.site === `src/analytics/store/public-archive-store:${table}.step`);
  if (!declaration?.probe) throw new Error(`no registered step probe for ${table}`);
  return declaration.probe.statement;
}

class Rollback extends Error {}

/** EXPLAIN (ANALYZE, BUFFERS) of a step, generic or for these values, after `before`, never committed. */
async function explain(statement: string, params: readonly unknown[], generic: boolean, before = ""): Promise<ExplainResult> {
  let result: ExplainResult | undefined;
  await fixtureDb
    .begin(async (tx) => {
      if (before) await tx.unsafe(before);
      await tx.unsafe(`SET LOCAL plan_cache_mode = ${generic ? "force_generic_plan" : "force_custom_plan"}`);
      const types = params.map((p) => (typeof p === "string" && p.includes("T") ? "timestamptz" : "bigint"));
      await tx.unsafe(`PREPARE archive_step (${types.join(", ")}) AS ${statement}`);
      const literals = params.map((p) => `'${String(p)}'`).join(", ");
      const rows = (await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE archive_step(${literals})`)) as unknown as {
        "QUERY PLAN": ExplainResult[];
      }[];
      result = rows[0]!["QUERY PLAN"][0]!;
      await tx.unsafe("DEALLOCATE archive_step");
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result!;
}

/** What is wrong with one wide table's step: a Seq Scan, a heap fetch, or a next-id read that is not index-only on `index`. */
function judge(table: string, index: string, result: ExplainResult): string[] {
  const nodes = flatten(result.Plan).filter((n) => n["Relation Name"] === table);
  const problems: string[] = [];
  if (nodes.some((n) => n["Node Type"] === "Seq Scan")) problems.push(`Seq Scan on ${table}`);
  const fetches = nodes.reduce((sum, n) => sum + ((n as PlanNode & { "Heap Fetches"?: number })["Heap Fetches"] ?? 0), 0);
  if (fetches > 0) problems.push(`${fetches} heap fetches`);
  // A one-row probe (the table's first row, for first_time) may read its row; nothing larger may.
  const heapReads = nodes.filter((n) => (n["Node Type"] === "Index Scan" || n["Node Type"] === "Bitmap Heap Scan") && ((n as PlanNode & { "Actual Rows"?: number })["Actual Rows"] ?? 0) > 1);
  if (heapReads.length > 0) problems.push(`${table} read from the heap by ${heapReads.map((n) => n["Index Name"] ?? n["Node Type"]).join(", ")}`);
  if (!nodes.some((n) => n["Node Type"] === "Index Only Scan" && n["Index Name"] === index)) problems.push(`no Index Only Scan on ${index}`);
  return problems;
}

async function body(built: BuiltRecord, path: string): Promise<Buffer> {
  const hit = fileIn(built, path)!;
  const chunks: Uint8Array[] = [];
  const reader = archiveBodyStream(hit.table, hit.file).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return gunzipSync(Buffer.concat(chunks));
}

/** Every sealed backup's backup.json bytes and ETag, and the archive bodies of the last two, from a cold chain. */
async function buildAll(): Promise<{ records: Map<string, { sha256: string; bytes: string }>; bodies: Map<string, string> }> {
  _resetArchiveForTests();
  const ids = await listBackupIds();
  const records = new Map<string, { sha256: string; bytes: string }>();
  const bodies = new Map<string, string>();
  // The newest first: one cold build walks the whole chain.
  for (const id of [...ids].reverse()) {
    const built = await recordFor(id);
    records.set(id, { sha256: built.sha256, bytes: Buffer.from(built.bytes).toString("base64") });
    if (records.size <= 2) {
      for (const t of Object.values(built.record.append_only)) {
        for (const f of t.files) bodies.set(`${id}/${f.path}`, (await body(built, f.path)).toString("base64"));
      }
    }
  }
  return { records, bodies };
}

const asOwner = (statement: string) => fixtureDb.unsafe(statement);

beforeAll(async () => {
  _setArchiveClockForTests(() => NOW);
  _setArchiveJunctionForTests(null);
  // One methodology; per day one acquisition, one run and one vintage.
  await fixtureDb.unsafe(`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('regime', 'v1', '{}', repeat('a', 64), '${FIRST_DAY} 00:30:00+00');
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    SELECT md5('arch-1690-' || d)::uuid, 'fixture', 'test:1', 'arch-1690:' || d, '${FIRST_DAY}'::timestamptz + make_interval(days => d)
      FROM generate_series(0, ${DAYS - 1}) d;
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    SELECT gen_random_uuid()::text, '${FIRST_DAY}'::date + d, 'regime', 'live',
           (SELECT id FROM analytics_ledger_methodology_versions WHERE tool_id = 'regime'), 'b', '${FIRST_DAY} 01:00:00+00'::timestamptz + make_interval(days => d)
      FROM generate_series(0, ${DAYS - 1}) d`);
  // source_value_versions: 9,200 a day over 74 keys, in time order.
  await fixtureDb.unsafe(`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, knowledge_time)
    SELECT md5('arch-1690-' || d)::uuid, 'series:k' || (i % 74), '1950-01-01'::date + d * 200 + i / 74, i * 0.5, 'initial',
           '${FIRST_DAY} 00:10:00+00'::timestamptz + make_interval(days => d, secs => i * 9)
      FROM generate_series(0, ${DAYS - 1}) d, generate_series(0, 9199) i
     ORDER BY d, i`);
  // One vintage a day, its ~16.7k members: 1M over the 60 days.
  await fixtureDb.unsafe(`
    INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
      build_identity, manifest, manifest_digest, member_count, created_at)
    SELECT r.id, 'regime', r.created_at, r.asof, r.methodology_version_id, 'b', '{}', repeat('b', 64), 16667, r.created_at + interval '5 hours'
      FROM analytics_ledger_runs r ORDER BY r.id`);
  await fixtureDb.unsafe(`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
    SELECT v.id, s.lo + j * 33, 'series:k' || (j % 74)
      FROM analytics_data_vintages v, (SELECT min(id) AS lo FROM source_value_versions) s, generate_series(0, 16666) j
     ORDER BY v.id, j`);
  // analytics_overwrite_events: 200k rows of about 2 KB (stored inline, below the TOAST threshold).
  await fixtureDb.unsafe(`
    INSERT INTO analytics_overwrite_events (table_name, operation, natural_key, previous_row, replacement_row, recorded_at)
    SELECT 'raw_indicator_history', 'update', jsonb_build_object('indicator', 'I' || (g % 50), 'date', '2001-01-01'::date + g % 365),
           jsonb_build_object('pad', repeat(md5(g::text), 54)), '{"value": 2}',
           '${FIRST_DAY} 00:20:00+00'::timestamptz + make_interval(secs => g * 25.92)
      FROM generate_series(0, 199999) g ORDER BY g`);
  const visible = await vacuumAnalyzeAsOwner("source_value_versions", "analytics_overwrite_events", "analytics_vintage_members", "analytics_data_vintages");
  expect(visible.every((v) => v.allVisible === 1)).toBe(true);
  const [counts] = await fixtureDb<{ svv: number; ovw: number; mem: number; vin: number; ovw_bytes: number }[]>`
    SELECT (SELECT count(*) FROM source_value_versions)::int AS svv, (SELECT count(*) FROM analytics_overwrite_events)::int AS ovw,
           (SELECT count(*) FROM analytics_vintage_members)::int AS mem, (SELECT count(*) FROM analytics_data_vintages)::int AS vin,
           (SELECT pg_relation_size('analytics_overwrite_events') / count(*) FROM analytics_overwrite_events)::int AS ovw_bytes`;
  expect(counts!.svv).toBeGreaterThanOrEqual(550_000);
  expect(counts!.ovw).toBe(200_000);
  expect(counts!.mem).toBeGreaterThanOrEqual(1_000_000);
  expect(counts!.vin).toBe(DAYS);
  expect(counts!.ovw_bytes).toBeGreaterThanOrEqual(1_800);
}, 900_000);

afterAll(() => {
  _setArchiveClockForTests(null);
  _setArchiveJunctionForTests(null);
});

describe("the archive day step at production size (issue 1690)", () => {
  for (const w of WIDE) {
    for (const generic of [true, false]) {
      const form = generic ? "the generic plan" : "the plan for one day";
      test(`${w.table}, ${form}: no Seq Scan, an Index Only Scan on ${w.index}, 0 heap fetches`, async () => {
        const result = await explain(stepOf(w.table), await w.params(40), generic);
        expect(judge(w.table, w.index, result)).toEqual([]);
      });
    }

    test(`RED CONTROL: ${w.table} without ${w.index} fails the same judge`, async () => {
      const result = await explain(stepOf(w.table), await w.params(40), false, `DROP INDEX ${w.index}`);
      expect(judge(w.table, w.index, result).length).toBeGreaterThan(0);
    });
  }

  test("one cold build over 60 days runs no statement for 1 s or more, and every record and body is byte-identical without the indexes", async () => {
    const [{ db }] = await fixtureDb<{ db: string }[]>`SELECT current_database() AS db`;
    await adminExec("CREATE EXTENSION IF NOT EXISTS pg_stat_statements", db);
    await adminExec("SELECT pg_stat_statements_reset()", db);

    const indexed = await buildAll();
    expect(indexed.records.size).toBeGreaterThanOrEqual(DAYS);
    const [slowest] = await adminExec(
      `SELECT max(max_exec_time)::float8 AS ms, count(*)::int AS statements FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = '${db}')
          AND (query LIKE '%analytics_vintage_members%' OR query LIKE '%source_value_versions%' OR query LIKE '%analytics_overwrite_events%')`,
      db,
    );
    expect(Number(slowest!.statements)).toBeGreaterThan(0);
    expect(Number(slowest!.ms)).toBeLessThan(1_000);

    // The same chain with the indexes gone (rolled back by recreating them): the statements are unchanged, so is every byte.
    const defs = await fixtureDb<{ def: string }[]>`SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indexrelid::regclass::text = ANY(${NEW_INDEXES})`;
    expect(defs.length).toBe(NEW_INDEXES.length);
    await asOwner(NEW_INDEXES.map((i) => `DROP INDEX ${i};`).join("\n"));
    try {
      const plain = await buildAll();
      expect([...plain.records.keys()]).toEqual([...indexed.records.keys()]);
      expect(plain.records).toEqual(indexed.records);
      expect(plain.bodies.size).toBeGreaterThan(0);
      expect(plain.bodies).toEqual(indexed.bodies);
    } finally {
      await asOwner(defs.map((d) => `${d.def};`).join("\n"));
      _resetArchiveForTests();
    }
  }, 600_000);
});

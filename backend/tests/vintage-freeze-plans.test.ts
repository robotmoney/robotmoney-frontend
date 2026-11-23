// The vintages freeze reads the ledger heads index-only at production size
// (issue 1690, migration 0134).
//
// POST /api/analytics/vintages (freezeVintage) reads the head of every series
// known at the cutoff (loadHistoricalSourceValues). On the production copy of
// 2026-11-22 that read took 3.4 s through source_value_versions_lookup_idx (a
// heap fetch per row for `value`) and 3.9 s in the generic plan the api's
// prepared statement runs after five executions (a bitmap scan of two indexes
// and a 560k-row sort on disk). Stage saw the freeze at 7.6 s and 8.8 s.
//
// The ledger is loaded to production's size and shape (550k rows over 74
// keys, ids interleaved across keys so the heap is not in key order), then
// VACUUMed and ANALYZEd. Then:
//   * the registered statement plans as an Index Only Scan on
//     source_value_versions_heads_idx for the real cutoffs, and no node sorts;
//   * it never runs on the generic plan (force_custom_plan for its
//     transaction): the generic plan guesses a third of the table and, on
//     some tables, picks a sequential scan and a sort instead;
//   * it returns exactly the rows the pre-change statement returns, so
//     freezeVintage's manifest and members are the ones it froze before;
//   * freezeVintage finishes under 2.5 s (best of three after a warm-up);
//   * the slow-request line carries heads_ms, manifest_ms and members_ms, and
//     scripts/release/analytics-load-check.ts parses them;
//   * red control: without the index the plan judge fails, and the
//     pre-change statement's generic plan fails it with the index.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { registeredSites } from "../src/db/registry.ts";
import { withRequestTiming } from "../src/api/request-timing.ts";
import { buildVintageManifest } from "../src/analytics/run-ledger.ts";
import { beginRun, freezeVintage, loadFrozenVintage, loadHistoricalSourceValues } from "../src/analytics/store/run-ledger-store.ts";
import { parseApiLog } from "../../scripts/release/analytics-load-check.ts";
import { flatten, type ExplainResult } from "../../scripts/release/jobs-query-plans.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { vacuumAnalyzeAsOwner } from "./support/vacuum-as-owner.ts";

useCleanDatabase(import.meta.file);

const KEYS = 74;
const DATES = 7_350;
const SITE = "src/analytics/store/run-ledger-store:loadHistoricalSourceValues";
const INDEX = "source_value_versions_heads_idx";
const KNOWLEDGE_CUTOFF = "2026-11-22T00:00:00.000Z";
const MARKET_CUTOFF = "2026-11-20";
const METHODOLOGY = { toolId: "freeze-1690", versionLabel: "v1", config: { issue: 1690 } };

// The statement as it stood before issue 1690: the market cutoff inside the subquery.
const PRE_1690 = `SELECT source_key, string_agg(
      id::text || E'\\t' || coalesce(market_date::text, '') || E'\\t' || coalesce(market_instant::text, '') || E'\\t' || value::text,
      E'\\n' ORDER BY market_date, market_instant) AS points
    FROM (
      SELECT DISTINCT ON (source_key, market_date, market_instant)
        id, source_key, market_date, market_instant, value
      FROM source_value_versions
      WHERE knowledge_time <= $1::timestamptz
        AND (market_date IS NULL OR market_date <= $2::date)
        AND (market_instant IS NULL OR (market_instant AT TIME ZONE 'UTC')::date <= $2::date)
        AND source_key <> ALL($3::text[])
      ORDER BY source_key, market_date, market_instant, knowledge_time DESC, id DESC
    ) heads
    GROUP BY source_key`;

class Rollback extends Error {}

function probe(): string {
  const declaration = registeredSites().find((d) => d.site === SITE);
  if (!declaration?.probe) throw new Error(`no registered probe for ${SITE}`);
  return declaration.probe.statement;
}

/** EXPLAIN (ANALYZE, BUFFERS) of the statement with the real cutoffs, generic or custom, after `before`, never committed. */
async function explain(statement: string, generic: boolean, before = ""): Promise<ExplainResult> {
  let result: ExplainResult | undefined;
  await fixtureDb
    .begin(async (tx) => {
      if (before) await tx.unsafe(before);
      await tx.unsafe(`SET LOCAL plan_cache_mode = ${generic ? "force_generic_plan" : "force_custom_plan"}`);
      await tx.unsafe("SET LOCAL work_mem = '2MB'");
      await tx.unsafe(`PREPARE freeze_probe (timestamptz, date, text[]) AS ${statement}`);
      const rows = (await tx.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE freeze_probe('${KNOWLEDGE_CUTOFF}', '${MARKET_CUTOFF}', '{}')`,
      )) as unknown as { "QUERY PLAN": ExplainResult[] }[];
      result = rows[0]!["QUERY PLAN"][0]!;
      await tx.unsafe("DEALLOCATE freeze_probe");
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result!;
}

/** What is wrong with the head read's plan: anything but an index-only read of the heads index, or a sort. */
function judge(result: ExplainResult): string[] {
  const nodes = flatten(result.Plan);
  const problems: string[] = [];
  const reads = nodes.filter((n) => n["Relation Name"] === "source_value_versions");
  if (!reads.every((n) => n["Node Type"] === "Index Only Scan" && n["Index Name"] === INDEX)) {
    problems.push(`source_value_versions read by ${reads.map((n) => `${n["Node Type"]} ${n["Index Name"] ?? ""}`.trim()).join(", ")}`);
  }
  if (nodes.some((n) => n["Node Type"] === "Sort")) problems.push("a Sort node");
  return problems;
}

beforeAll(async () => {
  // 74 keys, each with a value per market date and a revision of each of its
  // last 90 dates. Written 30 dates at a time across all keys, the way acquisitions
  // land: a series' points of one fetch have consecutive ids (so a vintage
  // stores them as runs, ~10k member rows as on production), and the heap is
  // in time order, not key order. A few dates sit past the market cutoff and a
  // few revisions past the knowledge cutoff.
  await fixtureDb.unsafe(`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    SELECT md5('acq-1690-' || r)::uuid, 'fixture', 'test:1', 'freeze-1690:' || r, '2026-09-21'::timestamptz
      FROM generate_series(0, 1) r`);
  await fixtureDb.unsafe(`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, knowledge_time)
    SELECT md5('acq-1690-' || r)::uuid, 'series:k' || lpad(k::text, 3, '0'), '2006-09-01'::date + d,
           k * 1000 + d + r * 0.5, CASE r WHEN 0 THEN 'initial' ELSE 'revision' END,
           '2026-09-21'::timestamptz + make_interval(secs => d * 800 + r * 600000 + k)
      FROM generate_series(0, ${DATES - 1}) d, generate_series(0, 1) r, generate_series(1, ${KEYS}) k
     WHERE r = 0 OR d >= ${DATES - 90}
     ORDER BY r, d / 30, k, d`);
  expect(await vacuumAnalyzeAsOwner("source_value_versions")).toEqual([{ table: "source_value_versions", allVisible: 1 }]);
  const [{ n }] = await fixtureDb<{ n: number }[]>`SELECT count(*)::int AS n FROM source_value_versions`;
  expect(n).toBeGreaterThanOrEqual(550_000);
}, 600_000);

describe("the freeze's head read at production size (issue 1690)", () => {
  test(`the plan for the real cutoffs: an Index Only Scan on ${INDEX}, no Sort`, async () => {
    expect(judge(await explain(probe(), false))).toEqual([]);
  });

  test("it never runs on the generic plan: ten reads on one connection run ten custom plans", async () => {
    const one = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      for (let i = 0; i < 10; i++) await loadHistoricalSourceValues(KNOWLEDGE_CUTOFF, MARKET_CUTOFF, one);
      const [plans] = await one<{ generic: number; custom: number }[]>`
        SELECT coalesce(sum(generic_plans), 0)::int AS generic, coalesce(sum(custom_plans), 0)::int AS custom
          FROM pg_prepared_statements
         WHERE statement LIKE '%FROM source_value_versions%' AND statement LIKE '%OFFSET 0%'`;
      // Every one of the ten executions was planned for its own cutoffs. (postgres.js's first
      // round trip describes the statement, which Postgres counts as one generic plan.)
      expect(plans!.custom).toBe(10);
      expect(plans!.generic).toBeLessThanOrEqual(1);
    } finally {
      await one.end({ timeout: 5 });
    }
  });

  test("RED CONTROL: without the heads index the same judge fails", async () => {
    expect(judge(await explain(probe(), false, `DROP INDEX ${INDEX}`)).length).toBeGreaterThan(0);
  });

  test("RED CONTROL: the pre-change statement's generic plan fails the judge even with the index", async () => {
    expect(judge(await explain(PRE_1690, true)).length).toBeGreaterThan(0);
  });

  test("the rows are exactly the pre-change statement's, for several cutoffs and an excluded key", async () => {
    const cases: [string, string, string[]][] = [
      [KNOWLEDGE_CUTOFF, MARKET_CUTOFF, []],
      ["2026-10-15T00:00:00.000Z", "2026-01-31", []],
      [KNOWLEDGE_CUTOFF, MARKET_CUTOFF, ["series:k001", "series:k050"]],
    ];
    for (const [kt, mt, exclude] of cases) {
      const before = await fixtureDb.unsafe(PRE_1690, [kt, mt, exclude] as never[]);
      const after = await loadHistoricalSourceValues(kt, mt, fixtureDb, exclude);
      const expected = before.flatMap((r) =>
        String(r.points).split("\n").map((line) => {
          const [id, marketDate, marketInstant, value] = line.split("\t");
          return { versionId: id!, sourceKey: String(r.source_key), marketDate: marketDate || null, marketInstant: marketInstant || null, value: Number(value) };
        }),
      );
      const key = (v: { versionId: string }) => v.versionId;
      expect([...after].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...expected].sort((a, b) => key(a).localeCompare(key(b))));
      expect(after.length).toBeGreaterThan(0);
    }
  });

  test("freezeVintage: the pre-change manifest and members, under 2.5 s (best of three), and the slow line's phases parse", async () => {
    const buildIdentity = "build-1690";
    const freezeOnce = async (toolId: string) => {
      const run = await beginRun({ runKey: randomUUID(), asof: "2026-11-21", toolId, sourceLabel: "fixture", methodology: { ...METHODOLOGY, toolId }, buildIdentity });
      return freezeVintage({
        runId: run.runId, toolId, knowledgeTimeCutoff: KNOWLEDGE_CUTOFF, marketTimeCutoff: MARKET_CUTOFF,
        methodologyVersionId: run.methodologyVersionId, buildIdentity,
      });
    };

    // The slow-request line, as the api logs it around the route.
    const lines: string[] = [];
    const log = { warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    let first: Awaited<ReturnType<typeof freezeOnce>> | undefined;
    await withRequestTiming(new Request("http://api/api/analytics/vintages", { method: "POST" }), "/api/analytics/vintages", async () => {
      first = await freezeOnce("freeze-1690-a");
      return new Response("{}");
    }, { slowMs: 0, log });
    const [logged] = parseApiLog(lines.join("\n")).requests;
    expect(logged?.path).toBe("/api/analytics/vintages");
    expect(Object.keys(logged!.phases)).toEqual(["heads", "manifest", "members"]);
    expect(Object.values(logged!.phases).every((ms) => Number.isInteger(ms) && ms >= 0)).toBe(true);

    // The same manifest as one built from the pre-change statement's rows.
    const old = await fixtureDb.unsafe(PRE_1690, [KNOWLEDGE_CUTOFF, MARKET_CUTOFF, []] as never[]);
    const oldMembers = old.flatMap((r) =>
      String(r.points).split("\n").map((line) => {
        const [id, marketDate, marketInstant, value] = line.split("\t");
        return { versionId: id!, sourceKey: String(r.source_key), marketDate: marketDate || null, marketInstant: marketInstant || null, value: Number(value) };
      }),
    );
    const frozen = await loadFrozenVintage(first!.vintageId);
    const { manifest } = buildVintageManifest(oldMembers, frozen!.methodologyVersionId, buildIdentity, KNOWLEDGE_CUTOFF, MARKET_CUTOFF);
    expect(first!.manifest.manifestDigest).toBe(manifest.manifestDigest);
    expect(frozen!.memberCount).toBe(oldMembers.length);
    expect(frozen!.members.map((m) => m.versionId).sort()).toEqual(oldMembers.map((m) => m.versionId).sort());

    let best = Infinity;
    for (const tool of ["freeze-1690-b", "freeze-1690-c", "freeze-1690-d"]) {
      const started = performance.now();
      await freezeOnce(tool);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(2_500);
  }, 120_000);
});

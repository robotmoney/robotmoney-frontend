// The jobs table's live-row reads use an index at production size (issue 1581).
//
// On production (2026-11-05) `jobs` held 310k rows and caused about 90% of all
// disk reads. The reaper, the enqueue live-job guard, livePayloadField and the
// worker-start backlog sweep each scanned every row, and the admin counts
// grouped every row. Migration 0130 adds jobs_live_kind_locked_idx (kind,
// locked_at) WHERE status IN ('pending','running'). The admin counts keep
// their heap scan and are held to the issue's 50 ms budget at this size.
//
// The table is loaded to production's size and shape (310k rows, 85% the two
// wallet samplers, almost every row terminal, a few dozen live), then VACUUMed
// and ANALYZEd: a plan on an empty table proves nothing. Then:
//   * the REAL statements, from the query registry's probes (the call sites'
//     own text), plan on the partial index with no Seq Scan on jobs and run
//     under 10 ms. EXPLAIN ANALYZE of an UPDATE executes it, so each runs in a
//     transaction that is rolled back;
//   * the read forms the stage rehearsal script runs as rm_readonly
//     (scripts/release/jobs-query-plans.ts) pass the same judge, and the admin
//     counts run under 50 ms;
//   * red control: without the index the same judge fails.
// A time is the best of three runs after one warm-up run, so one slow CI tick
// does not decide it; the budgets are the issue's own.
import { beforeAll, describe, expect, test } from "bun:test";
import { registeredSites } from "../src/db/registry.ts";
import "../src/pipeline/queue-store.ts";
import "../src/api/routes/admin.ts";
import "../src/admin/overview.ts";
import { JOBS_PLAN_READS, LIVE_INDEX, checkJobsPlans, explainText, flatten, planProblems, type ExplainResult } from "../../scripts/release/jobs-query-plans.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const ROWS = 310_000;

class Rollback extends Error {}

/** EXPLAIN (ANALYZE, BUFFERS) of `statement`, in a transaction that never commits. */
async function explainOnce(statement: string, params: readonly unknown[] = []): Promise<ExplainResult> {
  let result: ExplainResult | undefined;
  await fixtureDb
    .begin(async (tx) => {
      const rows = (await tx.unsafe(explainText(statement), params as never[])) as unknown as { "QUERY PLAN": ExplainResult[] }[];
      result = rows[0]!["QUERY PLAN"][0]!;
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result!;
}

/** One warm-up run, then the fastest of three: the plan is the same each time. */
async function explain(statement: string, params: readonly unknown[] = []): Promise<ExplainResult> {
  await explainOnce(statement, params);
  let best: ExplainResult | undefined;
  for (let i = 0; i < 3; i++) {
    const r = await explainOnce(statement, params);
    if (best === undefined || (r["Execution Time"] ?? Infinity) < (best["Execution Time"] ?? Infinity)) best = r;
  }
  return best!;
}

function probeOf(site: string): { statement: string; params: readonly unknown[] } {
  const declaration = registeredSites().find((d) => d.site === site);
  if (!declaration?.probe) throw new Error(`no registered probe for ${site}`);
  return { statement: declaration.probe.statement, params: declaration.probe.params ?? [] };
}

beforeAll(async () => {
  // Production's shape: the two wallet samplers are 85% of the rows; almost
  // every row is terminal; a few live rows, some running with an expired lease.
  await fixtureDb.unsafe(`
    INSERT INTO jobs (kind, payload, status, attempts, locked_at, locked_by, created_at, updated_at, run_after)
    SELECT CASE WHEN g % 100 < 43 THEN 'wallet.sample_balances'
                WHEN g % 100 < 85 THEN 'wallet.sample_sleeves'
                ELSE 'kind.' || (g % 15) END,
           jsonb_build_object('slotAt', to_char(now() - make_interval(mins => g), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                              'asof', to_char(now() - make_interval(mins => g), 'YYYY-MM-DD'),
                              'note', repeat('x', 120)),
           CASE WHEN g % 1000 = 1 THEN 'dead' WHEN g % 1000 = 2 THEN 'failed' WHEN g % 100 = 3 THEN 'cancelled' ELSE 'succeeded' END,
           1, NULL, NULL,
           now() - make_interval(mins => g), now() - make_interval(mins => g), now() - make_interval(mins => g)
      FROM generate_series(1, ${ROWS}) g`);
  // The live rows: pending samplers, a pending backfill, running rows with a
  // live lease and with one that expired an hour ago.
  await fixtureDb.unsafe(`
    INSERT INTO jobs (kind, payload, status, locked_at, locked_by)
    SELECT k, jsonb_build_object('slotAt', to_char(now() - make_interval(mins => g), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'asof', '2026-11-0' || (g % 9 + 1)),
           s, CASE s WHEN 'running' THEN now() - make_interval(mins => g * 30) END, CASE s WHEN 'running' THEN 'w-plan' END
      FROM generate_series(1, 6) g,
           (VALUES ('wallet.sample_balances'), ('wallet.sample_sleeves'), ('wallet.backfill_day'), ('ops.repair_gaps')) kinds(k),
           (VALUES ('pending'), ('running')) statuses(s)`);
  await fixtureDb.unsafe("VACUUM ANALYZE jobs");
  const [{ n, live }] = await fixtureDb<{ n: number; live: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('pending', 'running'))::int AS live FROM jobs`;
  expect(n).toBeGreaterThanOrEqual(ROWS);
  expect(live).toBeGreaterThanOrEqual(48);
}, 300_000);

describe("the real statements plan on the live-row index at 310k rows (issue 1581)", () => {
  const cases: readonly { site: string; params?: readonly unknown[] }[] = [
    { site: "src/pipeline/queue-store:reapStuckJobs" },
    // unlessLive true: the guard is the subquery that scanned.
    { site: "src/pipeline/queue-store:enqueueJob", params: ["wallet.sample_balances", "{}", null, true, "wallet.sample_balances"] },
    { site: "src/pipeline/queue-store:livePayloadField", params: ["asof", "wallet.backfill_day"] },
    { site: "src/pipeline/queue-store:sweepStaleBacklog" },
  ];
  for (const c of cases) {
    test(`${c.site}: an index scan on ${LIVE_INDEX}, no Seq Scan on jobs, under 10 ms`, async () => {
      const probe = probeOf(c.site);
      const result = await explain(probe.statement, c.params ?? probe.params);
      expect(planProblems({ name: c.site, index: LIVE_INDEX, maxMs: 10 }, result)).toEqual([]);
    });
  }
});

describe("the admin counts at 310k rows (issue 1581)", () => {
  for (const site of ["src/api/routes/admin:listJobs.byStatus", "src/api/routes/admin:listJobs.byKind", "src/admin/overview:getOverviewProjection.queueCounts"]) {
    test(`${site}: under 50 ms`, async () => {
      const result = await explain(probeOf(site).statement);
      expect(planProblems({ name: site, index: null, maxMs: 50, seqScanAllowed: true }, result)).toEqual([]);
    });
  }
});

describe("the stage rehearsal script's read forms (scripts/release/jobs-query-plans.ts)", () => {
  test("every read form passes the script's own judge", async () => {
    const verdicts = await checkJobsPlans((statement) => explain(statement));
    expect(verdicts.map((v) => v.name)).toEqual(JOBS_PLAN_READS.map((r) => r.name));
    expect(verdicts.flatMap((v) => v.problems)).toEqual([]);
  });

  test("red control: without the live-row index the judge fails every live-row read", async () => {
    const live = JOBS_PLAN_READS.filter((r) => r.index === LIVE_INDEX);
    let problems: string[] = [];
    await fixtureDb
      .begin(async (tx) => {
        await tx.unsafe(`DROP INDEX ${LIVE_INDEX}`);
        for (const read of live) {
          const rows = (await tx.unsafe(explainText(read.statement))) as unknown as { "QUERY PLAN": ExplainResult[] }[];
          problems.push(...planProblems(read, rows[0]!["QUERY PLAN"][0]!));
          expect(flatten(rows[0]!["QUERY PLAN"][0]!.Plan).some((n) => n["Index Name"] === LIVE_INDEX)).toBe(false);
        }
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
    for (const read of live) expect(problems.some((p) => p.startsWith(`${read.name}: the plan does not use`)), read.name).toBe(true);
    problems = [];
  });
});

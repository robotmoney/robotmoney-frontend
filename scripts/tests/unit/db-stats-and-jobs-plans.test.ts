// The two release checks of issue 1581, judged without a database:
// scripts/release/db-stats-check.ts (Q37a-db-stats / C25a-db-stats) and
// scripts/release/jobs-query-plans.ts (Q37b-jobs-plans). Each exits non-zero
// exactly when its judge returns a problem. backend/tests/role-passwords.test.ts
// and backend/tests/jobs-query-plans.test.ts run the same judges against a
// real Postgres.
import { describe, expect, test } from "bun:test";
import { dbStatsProblems, type DbStatsFound } from "../../release/db-stats-check.ts";
import { JOBS_PLAN_READS, LIVE_INDEX, checkJobsPlans, planProblems, type ExplainResult } from "../../release/jobs-query-plans.ts";

const GOOD: DbStatsFound = {
  extension: true,
  readAllStats: true,
  statements: { otherRoles: 12, hidden: 0 },
  statementsError: null,
  activity: { otherRoles: 3, hidden: 0 },
};

describe("db-stats-check: passes only with the extension, the grant and every row visible", () => {
  test("a provisioned target has no problem", () => {
    expect(dbStatsProblems(GOOD)).toEqual([]);
  });

  test("each missing piece is its own refusal", () => {
    expect(dbStatsProblems({ ...GOOD, extension: false, statements: null })).toEqual([
      "pg_extension does not list pg_stat_statements (run role-passwords as doadmin, D61)",
    ]);
    expect(dbStatsProblems({ ...GOOD, readAllStats: false })).toEqual([
      "rm_readonly does not hold pg_read_all_stats (run role-passwords as doadmin, D61)",
    ]);
    expect(dbStatsProblems({ ...GOOD, statements: { otherRoles: 12, hidden: 12 } })).toEqual([
      "pg_stat_statements hides 12 other-role row(s) from rm_readonly",
    ]);
    expect(dbStatsProblems({ ...GOOD, statements: { otherRoles: 0, hidden: 0 } })).toEqual(["pg_stat_statements holds no row of another role"]);
    expect(dbStatsProblems({ ...GOOD, activity: { otherRoles: 2, hidden: 2 } })).toEqual([
      "pg_stat_activity hides 2 other-role session(s) from rm_readonly",
    ]);
    expect(dbStatsProblems({ ...GOOD, activity: { otherRoles: 0, hidden: 0 } })).toEqual(["pg_stat_activity holds no client session of another role"]);
  });

  test("an installed extension whose view will not answer (the library is not preloaded) refuses with the error", () => {
    expect(dbStatsProblems({ ...GOOD, statements: null, statementsError: "pg_stat_statements must be loaded via shared_preload_libraries" })).toEqual([
      "pg_stat_statements could not be read: pg_stat_statements must be loaded via shared_preload_libraries",
    ]);
  });
});

const plan = (nodes: { type: string; relation?: string; index?: string }[], ms: number | undefined): ExplainResult => {
  const [head, ...rest] = nodes.map((n) => ({ "Node Type": n.type, "Relation Name": n.relation, "Index Name": n.index }));
  return { Plan: { ...head!, Plans: rest }, ...(ms === undefined ? {} : { "Execution Time": ms }) };
};

describe("jobs-query-plans: the index, no Seq Scan on jobs, and the budget", () => {
  const reaper = JOBS_PLAN_READS.find((r) => r.name === "reapStuckJobs")!;
  const counts = JOBS_PLAN_READS.find((r) => r.name === "admin counts by status")!;

  test("the four live-row reads name the live index and a 10 ms budget; the admin counts 50 ms and allow their heap scan", () => {
    expect(JOBS_PLAN_READS.map((r) => [r.name, r.index, r.maxMs, r.seqScanAllowed === true])).toEqual([
      ["reapStuckJobs", LIVE_INDEX, 10, false],
      ["enqueueJob live guard", LIVE_INDEX, 10, false],
      ["livePayloadField", LIVE_INDEX, 10, false],
      ["sweepStaleBacklog", LIVE_INDEX, 10, false],
      ["admin counts by status", null, 50, true],
      ["admin counts by kind", null, 50, true],
    ]);
  });

  test("an index scan on the live index inside the budget passes", () => {
    expect(planProblems(reaper, plan([{ type: "Update" }, { type: "Index Scan", relation: "jobs", index: LIVE_INDEX }], 0.4))).toEqual([]);
    expect(planProblems(reaper, plan([{ type: "Bitmap Heap Scan", relation: "jobs" }, { type: "Bitmap Index Scan", index: LIVE_INDEX }], 2))).toEqual([]);
  });

  test("a Seq Scan on jobs, another index, a slow run or no ANALYZE time each refuse", () => {
    expect(planProblems(reaper, plan([{ type: "Seq Scan", relation: "jobs" }], 2500))).toEqual([
      "reapStuckJobs: a Seq Scan on jobs",
      `reapStuckJobs: the plan does not use ${LIVE_INDEX}`,
      "reapStuckJobs: ran in 2500.00 ms, the budget is under 10 ms",
    ]);
    expect(planProblems(reaper, plan([{ type: "Index Scan", relation: "jobs", index: "jobs_pending_run_after_idx" }], 1))).toEqual([
      `reapStuckJobs: the plan does not use ${LIVE_INDEX}`,
    ]);
    expect(planProblems(reaper, plan([{ type: "Index Scan", relation: "jobs", index: LIVE_INDEX }], undefined))).toEqual([
      "reapStuckJobs: no execution time (EXPLAIN without ANALYZE)",
    ]);
  });

  test("the admin counts: a guarded heap scan that never ran passes; one that ran, or a slow count, refuses", () => {
    const guarded = (loops: number, ms: number): ExplainResult => ({
      Plan: { "Node Type": "Append", Plans: [{ "Node Type": "Seq Scan", "Relation Name": "jobs", "Actual Loops": loops }] },
      "Execution Time": ms,
    });
    expect(planProblems(counts, guarded(0, 2))).toEqual([]);
    expect(planProblems(counts, guarded(1, 278))).toEqual([
      "admin counts by status: a Seq Scan on jobs",
      "admin counts by status: ran in 278.00 ms, the budget is under 50 ms",
    ]);
  });

  test("checkJobsPlans warms each read once and judges the fastest of three", async () => {
    const times = [9, 30, 4, 12];
    let calls = 0;
    const verdicts = await checkJobsPlans(async () => plan([{ type: "Index Scan", relation: "jobs", index: LIVE_INDEX }], times[calls++ % 4]), [reaper]);
    expect(calls).toBe(4);
    expect(verdicts).toEqual([{ name: "reapStuckJobs", executionMs: 4, indexes: [LIVE_INDEX], problems: [] }]);
  });
});

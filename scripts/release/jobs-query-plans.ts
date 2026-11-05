#!/usr/bin/env bun
// scripts/release/jobs-query-plans.ts — the jobs-table plan check of issue 1581,
// run ON THE TARGET HOST against a fresh production dump (the stage-only step
// Q37b-jobs-plans), or by hand on the stage host.
//
//   bun scripts/release/jobs-query-plans.ts [--receipt-dir <dir>]
//
// WHY. On production (2026-11-05) the `jobs` table caused about 90% of all
// disk reads: the reaper, the enqueue live-job guard, livePayloadField and the
// worker-start backlog sweep each read every row, because the only status
// index covered 'pending' rows alone. Migration 0130 adds the partial index
// `jobs_live_kind_locked_idx` (kind, locked_at) WHERE status IN ('pending',
// 'running'). This check proves, on production's real data, that each of
// those reads plans on that index and runs inside its budget, and that the
// admin counts (still a heap scan, kept exact) run inside theirs.
//
// WHAT IT RUNS. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of each read in
// JOBS_PLAN_READS, as rm_readonly on the proven read-only session
// (./db-read.ts). Four of the six sites are UPDATEs or an INSERT, which
// rm_readonly may not run, so each is checked by its READ FORM: the same
// predicate over the same table, as a SELECT. The row selection is the only
// part of those statements that reads `jobs` at scale, so its plan is theirs.
// backend/tests/jobs-query-plans.test.ts checks both the real statements (from
// the query registry) and these read forms on a 310k-row table in CI.
//
// It exits 0 only when every live-row read uses jobs_live_kind_locked_idx
// with no Seq Scan on jobs and runs under 10 ms, and each admin count runs
// under 50 ms. Each time is the best of three runs after one warm-up run. It writes jobs-query-plans.json to --receipt-dir.
// Reads only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The live-row index migration 0130 adds. */
export const LIVE_INDEX = "jobs_live_kind_locked_idx";

/** One read the check plans, with the budget the issue sets for it. */
export interface JobsPlanRead {
  readonly name: string;
  /** The SELECT that reads `jobs` the way the site does. Literal values: no parameters. */
  readonly statement: string;
  /** The index the plan must use; null when only the time is judged. */
  readonly index: string | null;
  readonly maxMs: number;
  /** The admin counts read every row by design: a Seq Scan is allowed, the time is judged. */
  readonly seqScanAllowed?: boolean;
}

/** The reaper's lease window as the worker runs it (JOB_VISIBILITY_TIMEOUT default). */
const LEASE_SECONDS = 300;

/**
 * The read forms of the six sites (backend/src/pipeline/queue-store.ts,
 * backend/src/api/routes/admin.ts, backend/src/admin/overview.ts). Each keeps
 * the site's WHERE clause verbatim, with a production kind for `$kind`.
 */
export const JOBS_PLAN_READS: readonly JobsPlanRead[] = Object.freeze([
  {
    name: "reapStuckJobs",
    statement: `SELECT id FROM jobs WHERE status = 'running' AND locked_at < now() - (${LEASE_SECONDS} || ' seconds')::interval`,
    index: LIVE_INDEX,
    maxMs: 10,
  },
  {
    name: "enqueueJob live guard",
    statement: "SELECT EXISTS (SELECT 1 FROM jobs WHERE kind = 'wallet.sample_balances' AND status IN ('pending', 'running')) AS live",
    index: LIVE_INDEX,
    maxMs: 10,
  },
  {
    name: "livePayloadField",
    statement: "SELECT payload->>'asof' AS value FROM jobs WHERE kind = 'wallet.backfill_day' AND status IN ('pending', 'running')",
    index: LIVE_INDEX,
    maxMs: 10,
  },
  {
    name: "sweepStaleBacklog",
    statement: `WITH policy AS (
        SELECT kind, min(catchup_policy) AS catchup_policy FROM job_schedules
        WHERE enabled GROUP BY kind
        HAVING count(DISTINCT catchup_policy) = 1 AND min(catchup_policy) IN ('latest-only', 'collapse-per-bucket')
      ), live AS (
        SELECT j.id, j.kind, p.catchup_policy,
          coalesce(j.payload->>'slotAt', to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS slot
        FROM jobs j JOIN policy p ON p.kind = j.kind
        WHERE j.status = 'pending' OR (j.status = 'running' AND j.locked_at < now() - (${LEASE_SECONDS} || ' seconds')::interval)
      ), ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY kind, CASE WHEN catchup_policy = 'collapse-per-bucket' THEN left(slot, 10) END
          ORDER BY slot DESC, id DESC) AS rn
        FROM live
      )
      SELECT id FROM ranked WHERE rn > 1`,
    index: LIVE_INDEX,
    maxMs: 10,
  },
  { name: "admin counts by status", statement: "SELECT status, count(*)::int AS n FROM jobs GROUP BY status", index: null, maxMs: 50, seqScanAllowed: true },
  { name: "admin counts by kind", statement: "SELECT kind, count(*)::int AS n FROM jobs GROUP BY kind", index: null, maxMs: 50, seqScanAllowed: true },
]);

/** The parts of an EXPLAIN (FORMAT JSON) node the judge reads. */
export interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly Plans?: readonly PlanNode[];
}

/** One EXPLAIN (ANALYZE, FORMAT JSON) result: the `QUERY PLAN` array's first element. */
export interface ExplainResult {
  readonly Plan: PlanNode;
  readonly "Execution Time"?: number;
}

export function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

/** PURE. Why one read's plan fails its rule; empty when it passes. */
export function planProblems(read: Pick<JobsPlanRead, "name" | "index" | "maxMs" | "seqScanAllowed">, result: ExplainResult): string[] {
  const nodes = flatten(result.Plan);
  const out: string[] = [];
  if (read.seqScanAllowed !== true && nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "jobs")) out.push(`${read.name}: a Seq Scan on jobs`);
  if (read.index !== null && !nodes.some((n) => n["Index Name"] === read.index)) {
    out.push(`${read.name}: the plan does not use ${read.index}`);
  }
  const ms = result["Execution Time"];
  if (ms === undefined) out.push(`${read.name}: no execution time (EXPLAIN without ANALYZE)`);
  else if (ms >= read.maxMs) out.push(`${read.name}: ran in ${ms.toFixed(2)} ms, the budget is under ${read.maxMs} ms`);
  return out;
}

/** What the check found for one read. */
export interface ReadVerdict {
  readonly name: string;
  readonly executionMs: number | null;
  readonly indexes: readonly string[];
  readonly problems: readonly string[];
}

/** EXPLAIN (ANALYZE, BUFFERS) every read through `explain`, and judge each. */
export async function checkJobsPlans(
  explain: (statement: string) => Promise<ExplainResult>,
  reads: readonly JobsPlanRead[] = JOBS_PLAN_READS,
): Promise<ReadVerdict[]> {
  const verdicts: ReadVerdict[] = [];
  for (const read of reads) {
    await explain(read.statement);
    let result = await explain(read.statement);
    for (let i = 0; i < 2; i++) {
      const again = await explain(read.statement);
      if ((again["Execution Time"] ?? Infinity) < (result["Execution Time"] ?? Infinity)) result = again;
    }
    const indexes = [...new Set(flatten(result.Plan).map((n) => n["Index Name"]).filter((n): n is string => n !== undefined))];
    verdicts.push({ name: read.name, executionMs: result["Execution Time"] ?? null, indexes, problems: planProblems(read, result) });
  }
  return verdicts;
}

/** The text before an EXPLAIN of `statement`, as both this script and the CI test send it. */
export const explainText = (statement: string): string => `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`;

async function main(): Promise<number> {
  const at = process.argv.indexOf("--receipt-dir");
  const receiptDir = at >= 0 ? process.argv[at + 1] : undefined;
  const { openReadOnly } = await import("./db-read.ts");
  const db = await openReadOnly();
  let verdicts: ReadVerdict[];
  try {
    verdicts = await checkJobsPlans(async (statement) => {
      const [row] = await db.query<{ "QUERY PLAN": ExplainResult[] | string }>(explainText(statement));
      const plan = row!["QUERY PLAN"];
      return (typeof plan === "string" ? JSON.parse(plan) : plan)[0]!;
    });
  } finally {
    await db.close();
  }
  for (const v of verdicts) {
    console.log(`[jobs-query-plans] ${v.name}: ${v.executionMs?.toFixed(2) ?? "?"} ms, indexes ${v.indexes.join(", ") || "none"}${v.problems.length ? " FAIL" : " ok"}`);
    for (const p of v.problems) console.error(`[jobs-query-plans] REFUSE: ${p}`);
  }
  const problems = verdicts.flatMap((v) => v.problems);
  if (receiptDir) {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(receiptDir, "jobs-query-plans.json"),
      `${JSON.stringify({ step: "jobs-query-plans", target: db.target, at: new Date().toISOString(), reads: verdicts, problems }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();

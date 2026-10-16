// Q47-latest-only-catchup / C33-latest-only-catchup (PR 1381, issue 1378, migration 0125): the six heavy
// scheduled kinds catch up with 'latest-only', so a start, a restart or a rolling boot after downtime
// enqueues one job for each at its newest due slot and no stale backlog.
//
// Migration 0125 widens job_schedules_catchup_policy_check and moves the six kinds below to
// 'latest-only'. The check reads job_schedules, read-only: every one of the six kinds has a row, and
// that row's catchup_policy is 'latest-only'. The kinds are the migration's own; a unit test reads
// that file and fails if they drift apart.
import type { VersionCheck } from "../../version-check.ts";

export const LATEST_ONLY_KINDS = Object.freeze([
  "analytics.parity_sweep",
  "projects.refresh_wallets",
  "projects.fetch_vaults",
  "projects.refresh_coins",
  "ops.repair_gaps",
  "ops.backfill_asset_prices",
]);

const lit = (s: string) => `'${s}'`;

/** The one read-only query: each heavy kind's row and its catch-up policy. */
export const CATCHUP_SQL = `SELECT kind, catchup_policy FROM job_schedules WHERE kind IN (${LATEST_ONLY_KINDS.map(lit).join(", ")}) ORDER BY kind`;

/** PURE. Every heavy kind with no schedule row, or a policy other than latest-only. */
export function latestOnlyProblems(rows: readonly { kind: string; catchup_policy: string }[]): string[] {
  const out: string[] = [];
  for (const kind of LATEST_ONLY_KINDS) {
    const row = rows.find((r) => r.kind === kind);
    if (row === undefined) out.push(`${kind} has no job_schedules row`);
    else if (row.catchup_policy !== "latest-only") out.push(`${kind} catches up with '${row.catchup_policy}', not 'latest-only'`);
  }
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const rows = await db.query<{ kind: string; catchup_policy: string }>(CATCHUP_SQL);
  return { found: { schedules: rows, claim: "the six heavy kinds catch up with latest-only (migration 0125)" }, problems: latestOnlyProblems(rows) };
}) satisfies VersionCheck;

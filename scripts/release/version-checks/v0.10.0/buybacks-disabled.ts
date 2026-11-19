// Q40-buybacks-disabled/C28-buybacks-disabled (PR 1686, migration 0133_buybacks_refresh_disabled, issue 1184): the buyback
// refresh job no longer runs. Read-only: the ledger and two counts as rm_readonly.
//
// WHAT IT REQUIRES:
//   - schema_migrations records 0133_buybacks_refresh_disabled.sql;
//   - no buybacks.refresh row in job_schedules is enabled (the scheduler enqueues nothing of that kind);
//   - no buybacks.refresh job is pending or running (the migration dead-lettered them, and a disabled schedule adds none).
// The buyback tables and their rows stay (the migration is additive); this check does not read them.
import type { VersionCheck } from "../../version-check.ts";

export const MIGRATION = "0133_buybacks_refresh_disabled.sql";

export interface BuybacksRead {
  readonly ledger: readonly string[];
  readonly enabledSchedules: number;
  readonly liveJobs: number;
}

/** PURE. Why the buyback refresh is still live; empty when it is stopped. */
export function buybacksProblems(r: BuybacksRead): string[] {
  const out: string[] = [];
  if (!r.ledger.includes(MIGRATION) && !r.ledger.includes(MIGRATION.replace(/\.sql$/, ""))) out.push(`the ledger does not record ${MIGRATION}`);
  if (r.enabledSchedules > 0) out.push(`${r.enabledSchedules} buybacks.refresh schedule(s) are still enabled`);
  if (r.liveJobs > 0) out.push(`${r.liveJobs} buybacks.refresh job(s) are pending or running`);
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const ledger = (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((x) => x.name);
  const [sched] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM job_schedules WHERE kind = 'buybacks.refresh' AND enabled");
  const [live] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM jobs WHERE kind = 'buybacks.refresh' AND status IN ('pending', 'running')");
  const read: BuybacksRead = { ledger, enabledSchedules: Number(sched?.n ?? 0), liveJobs: Number(live?.n ?? 0) };
  return { found: { migrationRecorded: ledger.includes(MIGRATION), enabledSchedules: read.enabledSchedules, liveJobs: read.liveJobs }, problems: buybacksProblems(read) };
}) satisfies VersionCheck;

// Q44-regime-frozen/C32-regime-frozen (PR 1646, issue 1182, D83): no past regime day changes after its day
// ended, across a real run. Issue 1182's release evidence. Read-only: GETs through the public origin and
// the newest regime artifact's id and rows as rm_readonly.
//
// WHY NOT `csvb audit drift`. That tool (packages/csvb/src/audit/drift.ts) compares each day's last run with
// the `regime_snapshots` table, and D83 keeps that table's writers: every run still rewrites every day there.
// So it reports the same drift after the fix as before it. What D83 changed is what readers are SERVED, so
// this check watches the served line instead.
//
// HOW. It reads the served history (A) and the newest regime artifact's id, waits for the next regime run's
// artifact (the producer runs regime every 3 hours at :30 UTC), then reads the served history again (B).
// It exits as soon as B is read; the wait is a cap, not a fixed sleep (release-runbooks.md §4.4).
// WHAT IT REQUIRES:
//   - a new regime artifact lands within the cap (else nothing is proven, and the check fails saying so);
//   - every day that had ended when A was read (date < A's UTC day) is served in B exactly as in A: same
//     presence, same composite, same regime. A served day never disappears. A gap that a late run of that
//     as-of day publishes is allowed by D83 item 3 (`found.gapsPublished` lists it), since that is its
//     first publication, not a revision.
// `found.rewrittenByNewRun` counts the ended days on which the new run's own recomputation differs from
// what is served: the days the run rewrote and readers did not see move.
import type { VersionCheck } from "../../version-check.ts";
import { newestArtifactId, readArtifactRows, readServed, type Point } from "./_regime.ts";

/** How long the check waits for the next regime run: one 3-hour cadence plus slack. Under the step's maxMinutes. */
export const WAIT_CAP_MS = 200 * 60_000;
export const POLL_MS = 60_000;

/** PURE. Why an ended day moved between two reads of the served history; empty when none did. */
export function frozenProblems(a: readonly Point[], b: readonly Point[], todayA: string): string[] {
  const ended = (list: readonly Point[]) => new Map(list.filter((p) => p.date < todayA).map((p) => [p.date, p]));
  const before = ended(a);
  const after = ended(b);
  const out: string[] = [];
  if (before.size === 0) out.push("the first read served no ended day, so nothing could stay frozen");
  // A history capped by range can drop its oldest day as a new one arrives: compare from B's first day.
  const from = b[0]?.date ?? "";
  const moved: string[] = [];
  for (const [d, p] of before) {
    if (d < from) continue;
    const q = after.get(d);
    if (q === undefined) moved.push(`${d} was served ${p.composite} ${p.regime}, now absent`);
    else if (q.composite !== p.composite || q.regime !== p.regime) moved.push(`${d} moved from ${p.composite} ${p.regime} to ${q.composite} ${q.regime}`);
  }
  if (moved.length > 0) out.push(`${moved.length} ended day(s) changed after their day ended: ${moved.slice(0, 5).join("; ")}`);
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const a = await readServed(ctx);
  if ("error" in a) return { found: {}, problems: [a.error] };
  const startId = await newestArtifactId(db);
  const startedAt = Date.now();
  let newId = startId;
  while (newId === startId && Date.now() - startedAt < WAIT_CAP_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    newId = await newestArtifactId(db);
  }
  if (newId === startId) {
    return { found: { readAt: a.today, artifactBefore: startId, waitedMinutes: Math.round((Date.now() - startedAt) / 60_000) }, problems: [`no regime run wrote an artifact within ${WAIT_CAP_MS / 60_000} minutes, so no run was seen to leave the ended days alone`] };
  }
  const b = await readServed(ctx);
  if ("error" in b) return { found: {}, problems: [b.error] };
  const endedDays = a.history.filter((p) => p.date < a.today).map((p) => p.date);
  const recomputed = await readArtifactRows(db, newId, { days: endedDays.slice(-120) });
  const servedByDay = new Map(b.history.map((p) => [p.date, p]));
  const rewrittenByNewRun = [...recomputed.values()].filter((r) => { const s = servedByDay.get(r.date); return s !== undefined && (s.composite !== r.composite || s.regime !== r.regime); }).length;
  return {
    found: { readAt: a.today, artifactBefore: startId, artifactAfter: newId, gapsPublished: b.history.filter((p) => p.date < a.today && p.date >= (a.history[0]?.date ?? "") && !a.history.some((x) => x.date === p.date)).map((p) => p.date), waitedMinutes: Math.round((Date.now() - startedAt) / 60_000), endedDays: endedDays.length, rewrittenByNewRunOfLast120: rewrittenByNewRun },
    problems: frozenProblems(a.history, b.history, a.today),
  };
}) satisfies VersionCheck;

// Q37-missed-sessions/C25-missed-sessions (PR 1343, migration 0122): a seat's consecutive missed
// sessions are counted from the upgrade and shown on its member page. Reads:
//   - swarm_dormancy_baseline: exactly one row, with counted_from set (the
//     instant migration 0122 ran; the count starts there);
//   - GET /api/swarm/members/<id> for up to three active `member`-role seats:
//     each answers 200 with `silentSessions` a non-negative integer and
//     `silentThreshold` a positive integer (backend/src/swarm/projections.ts;
//     only getMember counts it, and the member page renders it).
import type { VersionCheck } from "../../version-check.ts";
import { safeId } from "./_member.ts";

export interface MemberAnswer {
  readonly id: string;
  readonly status: number;
  readonly silentSessions: unknown;
  readonly silentThreshold: unknown;
}

/** PURE. Every way the dormancy baseline or the member page's count is not in place. */
export function missedSessionsProblems(baseline: readonly { counted_from: unknown }[], members: readonly MemberAnswer[]): string[] {
  const out: string[] = [];
  if (baseline.length !== 1) out.push(`swarm_dormancy_baseline holds ${baseline.length} row(s); migration 0122 writes exactly one`);
  else if (baseline[0]!.counted_from == null || Number.isNaN(Date.parse(String(baseline[0]!.counted_from)))) out.push("swarm_dormancy_baseline's counted_from is not a time");
  if (members.length === 0) out.push("no active member-role seat to read the count from");
  for (const m of members) {
    if (m.status !== 200) { out.push(`GET /api/swarm/members/${m.id} answered ${m.status}`); continue; }
    if (!(Number.isInteger(m.silentSessions) && (m.silentSessions as number) >= 0)) out.push(`member ${m.id}: silentSessions is ${JSON.stringify(m.silentSessions)}, not a count`);
    if (!(Number.isInteger(m.silentThreshold) && (m.silentThreshold as number) > 0)) out.push(`member ${m.id}: silentThreshold is ${JSON.stringify(m.silentThreshold)}, not a positive count`);
  }
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const baseline = await db.query<{ counted_from: unknown }>("SELECT counted_from::text AS counted_from FROM swarm_dormancy_baseline");
  const seats = (await db.query<{ id: string; handle: string }>(
    "SELECT id::text AS id, handle FROM swarm_members WHERE status = 'active' AND role = 'member' ORDER BY handle LIMIT 3",
  )).filter((s) => safeId(s.id));
  const members: MemberAnswer[] = [];
  for (const s of seats) {
    const r = await ctx.http(`/api/swarm/members/${encodeURIComponent(s.id)}`);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(r.text) as Record<string, unknown>; } catch { body = {}; }
    members.push({ id: s.id, status: r.status, silentSessions: body.silentSessions, silentThreshold: body.silentThreshold });
  }
  return {
    found: {
      baseline: baseline.map((b) => b.counted_from),
      members: members.map((m, i) => ({ handle: seats[i]?.handle, ...m })),
    },
    problems: missedSessionsProblems(baseline, members),
  };
}) satisfies VersionCheck;

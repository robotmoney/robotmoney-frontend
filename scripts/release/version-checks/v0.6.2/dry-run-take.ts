// Q40-dry-run-take (PR 1341, RM-178): a member can dry-run a take before its
// first session. Reads:
//   - POST /api/swarm/submit/dry-run with no bearer: 401 (the route is there,
//     and refuses a caller with no credential as submit does);
//   - the same, as one of the host's in-house agents, for a take on the
//     soonest-closing collecting session with a deliberately unsigned body:
//     200, `dryRun: true`, the token check ok, every check listed, and the
//     signature check refusing (the body is not signed, so nothing about it
//     could be filed);
//   - swarm_recommendations' row count for that agent before and after: equal
//     (the dry run writes nothing).
// The bearer goes only into the Authorization header (./_member.ts).
import type { VersionCheck } from "../../version-check.ts";
import { dryRunBody, loadInHouseMember, safeId, type DryRunVerdict } from "./_member.ts";

export interface DryRunObservation {
  readonly anonymousStatus: number;
  readonly status: number;
  readonly verdict: DryRunVerdict | null;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
}

/** PURE. Every way the dry run is not in place or wrote something. */
export function dryRunProblems(o: DryRunObservation): string[] {
  const out: string[] = [];
  if (o.anonymousStatus !== 401) out.push(`the dry run with no bearer answered ${o.anonymousStatus}, not 401`);
  if (o.status !== 200 || o.verdict === null) out.push(`the dry run answered ${o.status}, not a 200 verdict`);
  else {
    if (o.verdict.dryRun !== true) out.push("the answer is not a dry-run verdict");
    const checks = o.verdict.checks ?? [];
    if (!checks.some((c) => c.check === "token" && c.ok)) out.push("the verdict has no passing token check");
    const sig = checks.find((c) => c.check === "signature");
    if (!sig) out.push("the verdict has no signature check");
    else if (sig.ok) out.push("an unsigned body passed the signature check");
  }
  if (o.rowsAfter !== o.rowsBefore) out.push(`the member's take rows went from ${o.rowsBefore} to ${o.rowsAfter} during a dry run`);
  return out;
}

export default (async (ctx) => {
  const anonymous = await ctx.http("/api/swarm/submit/dry-run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const member = loadInHouseMember();
  if ("error" in member) return { found: { anonymousStatus: anonymous.status }, problems: [`no in-house agent credential to ask the dry run with: ${member.error}`] };
  if (!safeId(member.memberId)) return { found: {}, problems: ["the in-house agent's member id is not an id"] };
  const db = await ctx.db();
  const [open] = await db.query<{ id: string; subject_id: string; date: string }>(
    "SELECT id::text AS id, subject_id, to_char(date, 'YYYY-MM-DD') AS date FROM swarm_sessions " +
      "WHERE state = 'collecting' ORDER BY window_closes_at ASC NULLS LAST LIMIT 1",
  );
  if (!open) return { found: { anonymousStatus: anonymous.status }, problems: ["no collecting session to dry-run a take for"] };
  const count = async () =>
    Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM swarm_recommendations WHERE member_id = '${member.memberId}'`))[0]?.n ?? -1);
  const rowsBefore = await count();
  const res = await ctx.http("/api/swarm/submit/dry-run", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${member.bearer}` },
    body: JSON.stringify(dryRunBody({ memberId: member.memberId, subjectId: open.subject_id, date: open.date })),
  });
  let verdict: DryRunVerdict | null = null;
  try { verdict = JSON.parse(res.text) as DryRunVerdict; } catch { verdict = null; }
  const rowsAfter = await count();
  const observation: DryRunObservation = { anonymousStatus: anonymous.status, status: res.status, verdict, rowsBefore, rowsAfter };
  return {
    found: {
      anonymousStatus: anonymous.status,
      asked: { as: member.handle, subject: open.subject_id, date: open.date },
      status: res.status,
      verdictSession: verdict?.sessionId ?? null,
      checks: (verdict?.checks ?? []).map((c) => ({ check: c.check, ok: c.ok, status: c.status })),
      rowsBefore,
      rowsAfter,
    },
    problems: dryRunProblems(observation),
  };
}) satisfies VersionCheck;

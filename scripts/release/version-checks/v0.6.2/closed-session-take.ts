// Q38-closed-session-take (PR 1338, issue 1249): a take that names a closed
// session is refused, never filed into the next session. Stage only (the step
// is onlyFor stage).
//
// It asks the take dry run (POST /api/swarm/submit/dry-run), as one of the
// host's in-house agents, about a take naming the newest PUBLISHED session of
// a subject. The dry run runs submit's own checks (domain.ts checkTake) and
// writes nothing. It asserts:
//   - the verdict is for the named session (`sessionId` is that session's id,
//     never the subject's newer collecting one: "filed there or nowhere");
//   - its `window` check refuses with 409 `submission window closed (session <id>)`;
//   - swarm_recommendations holds the same number of rows for that session
//     before and after.
// Gap, stated: the dry run shares submit's checks, not submit's INSERT, whose
// `s.state = 'collecting'` conjunct is the final authority. That conjunct is
// covered by backend/tests/swarm-submission-window.test.ts, not here.
import type { VersionCheck } from "../../version-check.ts";
import { dryRunBody, loadInHouseMember, safeId, type DryRunVerdict } from "./_member.ts";

export interface ClosedTakeObservation {
  readonly sessionId: string;
  readonly status: number;
  readonly verdict: DryRunVerdict | null;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
}

/** PURE. Every way a take naming a closed session was not refused at that session. */
export function closedTakeProblems(o: ClosedTakeObservation): string[] {
  const out: string[] = [];
  if (o.status !== 200 || o.verdict === null) return [`the dry run answered ${o.status}, not a 200 verdict`];
  if (o.verdict.dryRun !== true) out.push("the answer is not a dry-run verdict");
  if (o.verdict.sessionId !== o.sessionId) {
    out.push(`the verdict is for session ${String(o.verdict.sessionId)}, not the named ${o.sessionId}: a take naming a closed session was redirected`);
  }
  const window = o.verdict.checks?.find((c) => c.check === "window");
  if (!window) out.push("the verdict has no window check");
  else if (window.ok) out.push(`the window check passed for closed session ${o.sessionId}`);
  else {
    if (window.status !== 409) out.push(`the window check refused with ${String(window.status)}, not 409`);
    if (!(window.error ?? "").includes(`submission window closed (session ${o.sessionId})`)) out.push(`the window refusal does not name the session: ${JSON.stringify(window.error)}`);
  }
  if (o.rowsAfter !== o.rowsBefore) out.push(`session ${o.sessionId} went from ${o.rowsBefore} to ${o.rowsAfter} take rows during a dry run`);
  return out;
}

export default (async (ctx) => {
  const member = loadInHouseMember();
  if ("error" in member) return { found: {}, problems: [`no in-house agent credential to ask the dry run with: ${member.error}`] };
  const db = await ctx.db();
  const [closed] = await db.query<{ id: string; subject_id: string; date: string }>(
    "SELECT id::text AS id, subject_id, to_char(date, 'YYYY-MM-DD') AS date FROM swarm_sessions " +
      "WHERE state = 'published' ORDER BY published_at DESC NULLS LAST LIMIT 1",
  );
  if (!closed || !safeId(closed.id)) return { found: {}, problems: ["no published session to name"] };
  const count = async () =>
    Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM swarm_recommendations WHERE session_id = '${closed.id}'`))[0]?.n ?? -1);
  const rowsBefore = await count();
  const res = await ctx.http("/api/swarm/submit/dry-run", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${member.bearer}` },
    body: JSON.stringify(dryRunBody({ memberId: member.memberId, subjectId: closed.subject_id, date: closed.date, sessionId: closed.id })),
  });
  let verdict: DryRunVerdict | null = null;
  try { verdict = JSON.parse(res.text) as DryRunVerdict; } catch { verdict = null; }
  const rowsAfter = await count();
  const observation: ClosedTakeObservation = { sessionId: closed.id, status: res.status, verdict, rowsBefore, rowsAfter };
  return {
    found: {
      asked: { as: member.handle, session: closed.id, subject: closed.subject_id, date: closed.date },
      status: res.status,
      verdictSession: verdict?.sessionId ?? null,
      window: verdict?.checks?.find((c) => c.check === "window") ?? null,
      rowsBefore,
      rowsAfter,
      gap: "the dry run proves submit's checks; submit's INSERT conjunct is covered by backend tests",
    },
    problems: closedTakeProblems(observation),
  };
}) satisfies VersionCheck;

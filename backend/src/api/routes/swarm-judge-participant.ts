// The judge participant's HTTP surface — issue #1026 W4.7.
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.2. Two routes, both
// authenticated by the JUDGE's own participant bearer and by nothing else:
//
//   GET  …/participants/judge/subscribe — hold the connection, receive the
//        sessions in `judging` this judge has not submitted, on every connect.
//   POST …/participants/judgement      — submit one judgement.
//
// THE CREDENTIAL IS THE POINT. Scheduler spec §7 keeps four kinds of credential
// apart and warns they "must not be confused". The scheduler's automation token
// opens the stream in backend/src/api/routes/swarm-stream.ts and opens nothing
// here; a judge's member token opens these and opens nothing there. Neither
// holds a database credential, and this file reads no secret of any kind — it
// resolves the bearer through the swarm domain's one choke point.
//
// Thin transport: the pending set, the role check and the submission all live in
// backend/src/swarm/domain.ts, under the judge-subscription banner, which is
// where the reasoning about state-not-events belongs.
import { ROUTES } from "@robotmoney/contract";
import { bearer } from "../auth.ts";
import { isJudgeMember, memberIdForToken, openJudgeStream, submitJudgement } from "../../swarm/domain.ts";
import { readJsonObject } from "../validation.ts";
import type { SwarmRouteResult } from "./swarm/types.ts";

const P = ROUTES.swarm.participants;

export async function handleJudgeParticipant(
  req: Request,
  url: URL,
): Promise<SwarmRouteResult | Response | null> {
  const p = url.pathname;
  const m = req.method;

  if (p === P.judgeSubscribe && m === "GET") {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const memberId = await memberIdForToken(token);
    if (!memberId) return { status: 401, body: { error: "invalid token" } };
    // The role gate is here as well as in the submission path because a
    // subscription is a read of other members' outstanding work: a plain member
    // holding a stream would learn which sessions are in judging and when their
    // deadlines fall, which is not its business.
    if (!(await isJudgeMember(memberId))) return { status: 403, body: { error: "judge_role_required" } };
    return openJudgeStream(memberId);
  }

  if (p === P.judgement && m === "POST") {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const b = (await readJsonObject(req)) ?? {};
    const result = await submitJudgement(token, {
      sessionId: typeof b.sessionId === "string" ? b.sessionId : "",
      opinion: b.opinion,
      model: typeof b.model === "string" ? b.model : undefined,
      promptHash: typeof b.promptHash === "string" ? b.promptHash : undefined,
      inputsDigest: typeof b.inputsDigest === "string" ? b.inputsDigest : undefined,
      takeCount: typeof b.takeCount === "number" ? b.takeCount : undefined,
      minTakes: typeof b.minTakes === "number" ? b.minTakes : undefined,
    });
    if (!result.ok) return { status: result.status, body: { error: result.error } };
    const { ok: _ok, status, ...body } = result;
    return { status, body };
  }

  return null;
}

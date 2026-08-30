import * as ic from "../../swarm/domain.ts";
import * as admin from "../../swarm/admin.ts";
import { deliverSwarmNotification } from "../../swarm/notifications.ts";

export async function openSession(payload: Record<string, unknown>): Promise<unknown> {
  // `payload.date` is deliberately IGNORED (and no longer defaulted from this
  // process's clock): since migration 0022 the session's date is derived from
  // the convened_at that Postgres stamps on insert. A queued job that has sat
  // in the queue across midnight must file its session under the day it
  // actually ran, not the day it was enqueued.
  const subjectId = String(payload.subjectId ?? "");
  return await ic.openSession(subjectId);
}

export async function publishBrief(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  const windowMinutes = Number(payload.windowMinutes ?? 60);
  const prevOutcome = payload.prevOutcome ? String(payload.prevOutcome) : undefined;
  return await ic.publishBrief(sessionId, windowMinutes, prevOutcome);
}

export async function closeWindow(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  return await ic.closeWindow(sessionId);
}

export async function aggregateSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  return await ic.aggregateSession(sessionId);
}

// Issue #752. Enqueued the same way every other lifecycle step is, so the judge
// is observable in the swarm lane rather than being an out-of-band script.
//
// A DISABLED JUDGE IS A SKIP, NOT A DEGRADATION (issue #767). judgeSessionAdmin
// answers `{ ok:false, error:"judge_disabled" }` and worker/loop.ts's
// isDegradedResult() matches exactly that shape — so once #767 put
// `swarm.judge` on every session's cadence, the SHIPPED DEFAULT (`mode: off`)
// would have written a `degraded` job_run and retried with exponential backoff
// on every session before settling. That is a queue full of red for a switch
// working exactly as designed, and it buries the degraded rows that mean
// something. `off` is not a transient blip that a retry can fix; it is an
// operator's answer, and re-asking it four times does not change it.
//
// So this seam — the CADENCE, where nobody asked for a judging and the schedule
// simply fired — translates it into a truthy skip, which loop.ts records as one
// clean `succeeded` run naming the reason. The HTTP path keeps the 409: there a
// caller DID ask, and must be told it cannot have one rather than reading a 200
// as "judged".
export async function judgeSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  const result = await admin.judgeSessionAdmin(sessionId, undefined, "worker");
  if (result.ok === false && result.error === "judge_disabled") {
    return { skipped: "judge_disabled", sessionId };
  }
  return result;
}

export async function publishSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  return await ic.publishSession(sessionId);
}

export async function sendApplicationReceivedNotification(payload: Record<string, unknown>): Promise<unknown> {
  const outboxId = String(payload.outboxId ?? "");
  if (!outboxId) throw new Error("swarm application received notification requires outboxId");
  return deliverSwarmNotification(outboxId);
}

export async function sendActivationNotification(payload: Record<string, unknown>): Promise<unknown> {
  const outboxId = String(payload.outboxId ?? "");
  if (!outboxId) throw new Error("swarm activation notification requires outboxId");
  return deliverSwarmNotification(outboxId);
}

export async function sendSeatOpenNotification(payload: Record<string, unknown>): Promise<unknown> {
  const outboxId = String(payload.outboxId ?? "");
  if (!outboxId) throw new Error("swarm seat open notification requires outboxId");
  return deliverSwarmNotification(outboxId);
}


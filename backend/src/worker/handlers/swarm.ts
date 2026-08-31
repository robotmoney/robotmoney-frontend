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

// STATE-GUARDED LIKE EVERY OTHER TRANSITION (issue #806). This used to call
// `ic.aggregateSession` directly, and `domain.aggregateSession` has no state
// opinion of its own — it is the rollup computation, and it replaces
// `swarm_recommendation` WHOLESALE. So a re-delivered `swarm.aggregate` job
// rewrote the recommendation from ANY state, including `judged` and
// `published`, dropping the judge's `rationale`, `disagreements`,
// `release_safety` and fingerprint — outside the judge's advisory lock, with
// the judgement row left saying `applied = true` and the read path still
// calling it "in force". Nothing dequeues a lifecycle job, and #797 is what
// first puts `swarm.aggregate` and `swarm.judge` on the same cadence, so this
// became reachable on the normal path.
//
// `aggregateSessionAdmin` is the same rollup behind `guardedTransition`, which
// refuses `judged -> aggregated` and anything out of a terminal state, and
// writes the session event and audit row every other transition writes. The
// sanctioned way to re-aggregate a judged session is unchanged and still works:
// `judged -> window_closed -> aggregated`, two deliberate admin actions.
export async function aggregateSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  const result = await admin.aggregateSessionAdmin(sessionId, undefined, "worker");
  return translateBenignSkip(result, aggregateSkipReason, sessionId);
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
  return translateBenignSkip(result, judgeSkipReason, sessionId);
}

// ── Benign terminals on the cadence (issues #767, #806) ─────────────────────
//
// #767 translated exactly one error, `judge_disabled`, and left the rest.
// Executed against a real Postgres driving the real claim loop, each of the
// others wrote FIVE `degraded` job_runs before `jobs.max_attempts` settled the
// job — `terminal_state:cancelled`, `terminal_state:published`,
// `illegal_transition:window_closed->judged`. The cancellation case needs no
// race at all: `cancelSessionAdmin` is a bare `guardedTransition` and NOTHING
// dequeues the session's remaining lifecycle jobs, so cancelling a session
// during a soak reliably produced five red rows for a control working exactly
// as designed. That is verbatim the harm `judge_disabled` was special-cased to
// avoid: a queue of red for a control working as designed buries the degraded
// rows that mean something.
//
// THE TEST IS "CAN A RETRY CHANGE THE ANSWER", NOT "IS IT AN ERROR". A session
// that has published or been cancelled will never become judgeable, and no
// backoff makes it so. A session that has not yet been aggregated MIGHT — which
// is why `aggregate`'s list below names only `judged`, the one source state
// from which a re-delivered rollup is a step the session has already moved
// past. Nothing here touches `isDegradedResult()` itself: the translation is at
// the seam that knows nobody asked, exactly as #767 did it. The HTTP path keeps
// its 409 — there a caller DID ask.

/** The judge's benign terminals: an operator's answer, or a session past judging. */
function judgeSkipReason(error: string): string | null {
  if (error === "judge_disabled") return error;
  if (error.startsWith("terminal_state:")) return error;
  if (/^illegal_transition:.+->judged$/.test(error)) return error;
  return null;
}

/** The rollup's: a terminal session, or one already judged past a re-delivery. */
function aggregateSkipReason(error: string): string | null {
  if (error.startsWith("terminal_state:")) return error;
  if (error === "illegal_transition:judged->aggregated") return error;
  return null;
}

/**
 * Turn a benign refusal into ONE clean `succeeded` run naming the reason.
 * `worker/loop.ts`'s `isDegradedResult()` matches any `{ ok:false }`, so a
 * truthy object is the whole translation — and anything NOT on the seam's list
 * stays `{ ok:false }` and stays degraded, which is the point.
 */
function translateBenignSkip(
  result: { ok?: unknown; error?: unknown },
  reasonOf: (error: string) => string | null,
  sessionId: string,
): unknown {
  if (result.ok !== false) return result;
  const reason = typeof result.error === "string" ? reasonOf(result.error) : null;
  return reason == null ? result : { skipped: reason, sessionId };
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


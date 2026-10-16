// WHY A JUDGE DID NOT SUBMIT — issue #1117.
//
// Production kept a judge's failure in `jobs.last_error`. The judge is a
// participant now, so the only party that knows a model call failed is the
// judge container, and it tells the API here. The admin overview reads this to
// name the reason beside a session that is waiting on, or ended without, a
// judgement.
//
// IN MEMORY, ON PURPOSE. A table would need a migration, a grant and a place
// in the release rosters, for a fact whose useful life is one judging window
// and whose absence changes no outcome. A refusal never decides a session:
// `finalizeEpoch` decides from stored instants alone (scheduler spec §4.4),
// and nothing here is read by it. The cost of the choice is plain: an API
// restart forgets the reasons, and the next attempt's report puts them back
// while the window is open. The record is bounded (sessions and attempts) so
// it cannot grow without limit.

/** What one refused attempt looked like, as the judge reported it. */
export interface JudgeRefusal {
  memberId: string;
  sessionId: string;
  /** The D-A7 name (judge-reasons.ts), or `runner`. Free text is refused, so it cannot carry a payload. */
  reason: string;
  /** A bounded label for the operator. Never parsed. */
  detail: string;
  /** 1-based count of attempts this judge has made on this session. */
  attempt: number;
  at: string;
}

const MAX_SESSIONS = 200;
const MAX_PER_SESSION = 20;
const DETAIL_MAX = 400;
/** Matches the D-A7 taxonomy's shapes: `model_unavailable:503`, `credit_exhausted`, `runner`. */
const REASON_SHAPE = /^[a-z_]{1,40}(:\d{1,3})?$/;

const bySession = new Map<string, JudgeRefusal[]>();

export function recordJudgeRefusal(input: {
  memberId: string;
  sessionId: string;
  reason: unknown;
  detail?: unknown;
  attempt?: unknown;
  now?: Date;
}): { ok: true } | { ok: false; status: number; error: string } {
  if (typeof input.reason !== "string" || !REASON_SHAPE.test(input.reason)) {
    return { ok: false, status: 400, error: "reason_invalid" };
  }
  const attempt = Number.isInteger(input.attempt) && (input.attempt as number) > 0 ? (input.attempt as number) : 1;
  const detail = typeof input.detail === "string" ? input.detail.slice(0, DETAIL_MAX) : "";
  const list = bySession.get(input.sessionId) ?? [];
  list.push({
    memberId: input.memberId,
    sessionId: input.sessionId,
    reason: input.reason,
    detail,
    attempt,
    at: (input.now ?? new Date()).toISOString(),
  });
  while (list.length > MAX_PER_SESSION) list.shift();
  // Re-insert so Map order is recency order, then drop the oldest sessions.
  bySession.delete(input.sessionId);
  bySession.set(input.sessionId, list);
  while (bySession.size > MAX_SESSIONS) bySession.delete(bySession.keys().next().value as string);
  return { ok: true };
}

/** Newest-first refusals for one session. */
export function refusalsForSession(sessionId: string): JudgeRefusal[] {
  return [...(bySession.get(sessionId) ?? [])].reverse();
}

/** The latest refusal per session, newest session first, for the overview. */
export function latestRefusals(limit = 10): JudgeRefusal[] {
  const out: JudgeRefusal[] = [];
  for (const list of [...bySession.values()].reverse()) {
    const last = list[list.length - 1];
    if (last) out.push(last);
    if (out.length >= limit) break;
  }
  return out;
}

export function describeJudgeRefusal(r: JudgeRefusal, attempts: number): string {
  return `judge ${r.memberId} refused session ${r.sessionId}: ${r.reason}` +
    `${r.detail ? ` (${r.detail})` : ""}; ${attempts} attempt(s) reported, last at ${r.at}`;
}

/** Test seam. */
export function _resetJudgeRefusals(): void {
  bySession.clear();
}

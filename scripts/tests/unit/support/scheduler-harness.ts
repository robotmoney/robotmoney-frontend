// Shared test harness for the `system-scheduler` clock — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §3.2, §4.3, §4.4, §4.6
// and §10.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A FAKE API AND A FAKE TIMER HOST
// ─────────────────────────────────────────────────────────────────────────────
//
// §10 asks for two things that cannot both be had from a real stack:
//
//   * "one tick before the instant produces no API call, so polling cannot
//     pass" — which needs a clock a test can stop one millisecond short of an
//     instant and hold there. Against a real clock the difference between "a
//     timer that fires at the instant" and "a poll that happens to be slow" is
//     not observable in bounded time.
//
//   * "turnover is dispatched within one second of `window_closes_at`" — which
//     needs a REAL timer, because a fake one dispatches at whatever instant the
//     test says it does and proves nothing about setTimeout.
//
// So both exist. `FakeTimers` answers the first, the production `realTimers`
// answers the second, and each test says which it used and what it measured.
// Nothing here fakes a transition: the fake API records the exact calls made,
// in order, and the tests assert over that list.
import type {
  ConsumerApi,
  FullReadSnapshot,
  StreamEventFrame,
} from "../../../lib/system-scheduler/stream-consumer.ts";
import type {
  AggregateBody,
  FinalizeBody,
  OpenBody,
  RequestJudgingBody,
  SchedulerApiResult,
  SchedulerFullRead,
  TimerHandle,
  TimerHost,
  TransitionApi,
  TurnoverBody,
} from "../../../lib/system-scheduler/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A deterministic timer host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A clock the test moves by hand.
 *
 * `advanceTo` fires every timer whose instant is at or below the new time, in
 * instant order, and awaits the microtask queue between each — so a handler
 * that sets a further timer inside the same advance has it considered, exactly
 * as a real event loop would.
 *
 * A timer set for an instant already past fires on the next `advanceTo`, not
 * immediately, so "the boundary fell during the outage" is a fire the test can
 * see rather than something that happened inside the constructor.
 */
export class FakeTimers implements TimerHost {
  #now: number;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  set(atMs: number, fn: () => void): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: atMs, fn });
    return { id };
  }

  clear(h: TimerHandle): void {
    this.#timers.delete(h.id);
  }

  /** How many timers are outstanding. §10's "one timer per …" is asserted on this. */
  get pending(): { id: number; at: number }[] {
    return [...this.#timers].map(([id, t]) => ({ id, at: t.at })).sort((a, b) => a.at - b.at);
  }

  /** Move the clock to `t`, firing everything due, and drain the microtask queue. */
  async advanceTo(t: number): Promise<void> {
    for (;;) {
      const due = [...this.#timers].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      this.#timers.delete(id);
      this.#now = Math.max(this.#now, timer.at);
      timer.fn();
      await drain();
    }
    this.#now = Math.max(this.#now, t);
    await drain();
  }

  async advanceBy(ms: number): Promise<void> {
    await this.advanceTo(this.#now + ms);
  }
}

/** Let every already-resolved promise chain run to completion. */
export async function drain(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
// A fake API that behaves like the real one's guards
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordedCall {
  /** The transition name, or `fullRead` / `subscribe` / `ackJob`. */
  call: string;
  /** The clock instant the call was DISPATCHED at, as the injected timer host reports it. */
  atMs: number;
  args: Record<string, string>;
}

interface FakeSubject {
  subjectId: string;
  name: string;
  epochDurationSeconds: number;
  active: boolean;
}

interface FakeSession {
  sessionId: string;
  subjectId: string;
  state: "collecting" | "window_closed" | "aggregated" | "judging" | "judged" | "published";
  windowClosesAt: number;
  judgeMode: "off" | "enforce";
  judgingDeadlineAt: number | null;
  consensusAt: number | null;
  outcome: "judged" | "no_consensus" | "not_judged" | null;
  successorId: string | null;
}

export interface FakeApiOptions {
  /** Where the fake reads "now" from, so its stored instants line up with the clock under test. */
  now: () => number;
  /** Seconds the API adds to the request instant to get the judging deadline. */
  judgingDurationSeconds?: number;
}

/**
 * An in-memory stand-in for the epoch lifecycle endpoints.
 *
 * It reproduces the REAL API's guards, because the clock's correctness is
 * defined against them: a replayed turnover, an "already done" aggregate and a
 * time-guarded finalize are the answers the clock has to keep going from. Where
 * this fake and `backend/src/swarm/domain.ts` could drift, the backend's own
 * tests are the authority — this one exists so the CLIENT's reaction to each
 * answer is testable without a database.
 */
export class FakeSchedulerApi implements TransitionApi, ConsumerApi {
  readonly calls: RecordedCall[] = [];
  readonly subjects = new Map<string, FakeSubject>();
  readonly sessions = new Map<string, FakeSession>();

  /** Per-transition-name queue of injected outcomes, consumed one per call. */
  readonly faults = new Map<string, ("transient" | "throw" | "ok")[]>();
  /** Transitions that fail transiently on EVERY call until cleared. */
  readonly stuck = new Set<string>();

  #now: () => number;
  #judgingSeconds: number;
  #seq = 0;
  #nextSession = 1;

  constructor(opts: FakeApiOptions) {
    this.#now = opts.now;
    this.#judgingSeconds = opts.judgingDurationSeconds ?? 600;
  }

  // ── fixture helpers ────────────────────────────────────────────────────────

  addSubject(subjectId: string, epochDurationSeconds: number, active = true): void {
    this.subjects.set(subjectId, { subjectId, name: subjectId, epochDurationSeconds, active });
  }

  /** Put a session into the fake at a chosen state, as a recovery fixture. */
  addSession(s: Partial<FakeSession> & { sessionId: string; subjectId: string }): FakeSession {
    const full: FakeSession = {
      state: "collecting",
      windowClosesAt: this.#now(),
      judgeMode: "off",
      judgingDeadlineAt: null,
      consensusAt: null,
      outcome: null,
      successorId: null,
      ...s,
    };
    this.sessions.set(full.sessionId, full);
    return full;
  }

  countCalls(name: string): number {
    return this.calls.filter((c) => c.call === name).length;
  }

  callsOf(name: string): RecordedCall[] {
    return this.calls.filter((c) => c.call === name);
  }

  /** Every transition call, in order, as `name(arg)` strings — readable in a failure message. */
  get trail(): string[] {
    return this.calls.map((c) => `${c.call}(${Object.values(c.args).join(",")})`);
  }

  sessionsOf(subjectId: string): FakeSession[] {
    return [...this.sessions.values()].filter((s) => s.subjectId === subjectId);
  }

  // ── fault injection ────────────────────────────────────────────────────────

  failNext(call: string, times: number, mode: "transient" | "throw" = "transient"): void {
    const q = this.faults.get(call) ?? [];
    for (let i = 0; i < times; i += 1) q.push(mode);
    this.faults.set(call, q);
  }

  failAlways(call: string): void {
    this.stuck.add(call);
  }

  recover(call: string): void {
    this.stuck.delete(call);
    this.faults.delete(call);
  }

  #record(call: string, args: Record<string, string>): void {
    this.calls.push({ call, atMs: this.#now(), args });
  }

  /** Returns a transient result when a fault is queued for this call, else null. */
  #fault(call: string): SchedulerApiResult<never> | null {
    if (this.stuck.has(call)) {
      return { ok: false, status: 503, error: "injected_dependency_down", transient: true };
    }
    const q = this.faults.get(call);
    const mode = q?.shift();
    if (!mode || mode === "ok") return null;
    if (mode === "throw") {
      return { ok: false, status: null, error: "injected_network_error", transient: true };
    }
    return { ok: false, status: 503, error: "injected_transient", transient: true };
  }

  // ── the consumer half ──────────────────────────────────────────────────────

  async fullRead(): Promise<FullReadSnapshot & SchedulerFullRead> {
    this.#record("fullRead", {});
    const subjects = [...this.subjects.values()]
      .filter((s) => s.active)
      .map((s) => ({ subjectId: s.subjectId, name: s.name, epochDurationSeconds: s.epochDurationSeconds }));
    const collecting = [...this.sessions.values()]
      .filter((s) => s.state === "collecting")
      .map((s) => ({
        sessionId: s.sessionId,
        subjectId: s.subjectId,
        windowClosesAt: new Date(s.windowClosesAt).toISOString(),
      }));
    const settling = [...this.sessions.values()]
      .filter((s) => ["window_closed", "aggregated", "judging", "judged"].includes(s.state))
      .map((s) => ({
        sessionId: s.sessionId,
        subjectId: s.subjectId,
        state: s.state as "window_closed" | "aggregated" | "judging" | "judged",
        judgingDeadlineAt: s.judgingDeadlineAt == null ? null : new Date(s.judgingDeadlineAt).toISOString(),
        subjectActive: this.subjects.get(s.subjectId)?.active ?? false,
      }));
    return { subjects, collecting, settling, cursor: this.#seq };
  }

  async subscribe(cursor: number): Promise<void> {
    this.#record("subscribe", { cursor: String(cursor) });
  }

  async ackJob(idempotencyKey: string): Promise<void> {
    this.#record("ackJob", { idempotencyKey });
  }

  // ── the transition half ────────────────────────────────────────────────────

  async openEpoch(subjectId: string): Promise<SchedulerApiResult<OpenBody>> {
    this.#record("openEpoch", { subjectId });
    const fault = this.#fault("openEpoch");
    if (fault) return fault;
    const subject = this.subjects.get(subjectId);
    if (!subject) return { ok: false, status: 404, error: "subject_not_found", transient: false };
    if (!subject.active) return { ok: false, status: 409, error: "subject_not_active", transient: false };
    const existing = this.sessionsOf(subjectId).find((s) => s.state === "collecting");
    if (existing) {
      return {
        ok: true,
        subjectId,
        sessionId: existing.sessionId,
        state: "collecting",
        windowClosesAt: new Date(existing.windowClosesAt).toISOString(),
        created: false,
      };
    }
    return { ok: true, ...this.#open(subject) };
  }

  #open(subject: FakeSubject): OpenBody {
    const sessionId = `s${this.#nextSession++}`;
    const closesAt = this.#now() + subject.epochDurationSeconds * 1000;
    this.addSession({
      sessionId,
      subjectId: subject.subjectId,
      state: "collecting",
      windowClosesAt: closesAt,
      judgeMode: "off",
    });
    this.#seq += 1;
    return {
      subjectId: subject.subjectId,
      sessionId,
      state: "collecting",
      windowClosesAt: new Date(closesAt).toISOString(),
      created: true,
    };
  }

  async turnover(subjectId: string, expectedSessionId: string): Promise<SchedulerApiResult<TurnoverBody>> {
    this.#record("turnover", { subjectId, expectedSessionId });
    const fault = this.#fault("turnover");
    if (fault) return fault;
    const closing = this.sessions.get(expectedSessionId);
    if (!closing || closing.subjectId !== subjectId) {
      return { ok: false, status: 404, error: "session_not_for_subject", transient: false };
    }
    if (closing.successorId) {
      // §4.3: replay the ORIGINAL result. Never close the successor.
      const successor = this.sessions.get(closing.successorId)!;
      return {
        ok: true,
        subjectId,
        closedSessionId: closing.sessionId,
        openedSessionId: successor.sessionId,
        windowClosesAt: new Date(successor.windowClosesAt).toISOString(),
        judgeMode: closing.judgeMode,
        replayed: true,
      };
    }
    if (closing.state !== "collecting") {
      return { ok: false, status: 409, error: "session_not_collecting", transient: false };
    }
    closing.state = "window_closed";
    this.#seq += 1;
    const subject = this.subjects.get(subjectId)!;
    if (!subject.active) {
      // §4.5: deactivation closes and opens no successor. Not reachable from the
      // boundary in practice, but the guard is here so a stale timer cannot.
      return { ok: false, status: 409, error: "subject_not_active", transient: false };
    }
    const opened = this.#open(subject);
    closing.successorId = opened.sessionId;
    return {
      ok: true,
      subjectId,
      closedSessionId: closing.sessionId,
      openedSessionId: opened.sessionId,
      windowClosesAt: opened.windowClosesAt,
      judgeMode: closing.judgeMode,
      replayed: false,
    };
  }

  async aggregate(sessionId: string): Promise<SchedulerApiResult<AggregateBody>> {
    this.#record("aggregate", { sessionId });
    const fault = this.#fault("aggregate");
    if (fault) return fault;
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, status: 404, error: "session_not_found", transient: false };
    if (["aggregated", "judging", "judged", "published"].includes(s.state)) {
      return { ok: true, sessionId, state: "aggregated", transitioned: false };
    }
    if (s.state !== "window_closed") {
      return { ok: false, status: 409, error: "session_not_window_closed", transient: false };
    }
    s.state = "aggregated";
    return { ok: true, sessionId, state: "aggregated", transitioned: true };
  }

  async requestJudging(sessionId: string): Promise<SchedulerApiResult<RequestJudgingBody>> {
    this.#record("requestJudging", { sessionId });
    const fault = this.#fault("requestJudging");
    if (fault) return fault;
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, status: 404, error: "session_not_found", transient: false };
    if (s.judgeMode === "off") return { ok: false, status: 409, error: "judge_mode_off", transient: false };
    if (s.judgingDeadlineAt != null) {
      return {
        ok: true,
        sessionId,
        state: "judging",
        deadlineAt: new Date(s.judgingDeadlineAt).toISOString(),
        transitioned: false,
      };
    }
    if (s.state !== "aggregated") {
      return { ok: false, status: 409, error: "session_not_aggregated", transient: false };
    }
    s.state = "judging";
    s.judgingDeadlineAt = this.#now() + this.#judgingSeconds * 1000;
    return {
      ok: true,
      sessionId,
      state: "judging",
      deadlineAt: new Date(s.judgingDeadlineAt).toISOString(),
      transitioned: true,
    };
  }

  /** A judge's consensus landing, as the participant route would record it. */
  recordConsensus(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.consensusAt = this.#now();
    if (s.state === "judging") s.state = "judged";
    this.#seq += 1;
  }

  async finalize(sessionId: string): Promise<SchedulerApiResult<FinalizeBody>> {
    this.#record("finalize", { sessionId });
    const fault = this.#fault("finalize");
    if (fault) return fault;
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, status: 404, error: "session_not_found", transient: false };
    if (s.state === "published") {
      return { ok: true, sessionId, state: "published", outcome: s.outcome!, replayed: true };
    }
    if (s.judgeMode === "off") {
      s.state = "published";
      s.outcome = "not_judged";
      return { ok: true, sessionId, state: "published", outcome: "not_judged", replayed: false };
    }
    const deadline = s.judgingDeadlineAt;
    if (deadline == null) return { ok: false, status: 409, error: "judging_not_requested", transient: false };
    const eligible = s.consensusAt != null && s.consensusAt <= deadline;
    if (!eligible && this.#now() < deadline) {
      // §4.4's time guard: a reasoned no-op, never a retryable error.
      return { ok: false, status: 409, error: "deadline_not_reached", transient: false };
    }
    s.state = "published";
    s.outcome = eligible ? "judged" : "no_consensus";
    return { ok: true, sessionId, state: "published", outcome: s.outcome, replayed: false };
  }
}

/** Build a `session.judged` frame the way the API's stream would. */
export function judgedEvent(seq: number, sessionId: string, subjectId: string): StreamEventFrame {
  return { type: "event", seq, kind: "session.judged", sessionId, subjectId, payload: {} };
}

/** Build an `epoch.turned_over` frame the way the API's stream would. */
export function turnedOverEvent(
  seq: number,
  subjectId: string,
  closedSessionId: string,
  openedSessionId: string,
  windowClosesAt: string,
): StreamEventFrame {
  return {
    type: "event",
    seq,
    kind: "epoch.turned_over",
    subjectId,
    sessionId: closedSessionId,
    payload: { closedSessionId, openedSessionId, windowClosesAt },
  };
}

/** Build a `subject.changed` frame the way the API's stream would. */
export function subjectChangedEvent(seq: number, subjectId: string): StreamEventFrame {
  return { type: "event", seq, kind: "subject.changed", subjectId, sessionId: null, payload: {} };
}

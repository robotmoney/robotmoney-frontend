// THE CLOCK — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §3.2, §4.1, §4.3,
// §4.4, §4.5, §4.6, §5, §6.2 and §9.
//
//   §3: "`system-scheduler` is the clock. It holds one timer per active
//    subject: the instant that subject's current epoch closes. It also holds
//    one timer per session in `judging` … It fires at the instant. It does not
//    poll the API on an interval. It does not tick."
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF THIS MODULE, AND WHY
// ─────────────────────────────────────────────────────────────────────────────
//
// Three things live here and nothing else:
//
//   1. THE TIMER SET. One boundary timer per subject, one deadline timer per
//      judging session, each set from an instant THE API SUPPLIED. This module
//      computes no close instant at all, which is what makes §2.2's grid
//      (amended 2026-09-24, D52) a property it cannot break: `window_closes_at`
//      is `epoch_anchor + k × epoch_duration`, decided by the API inside the
//      transaction that opens the epoch, and the clock's only job is to wait
//      for the instant it was handed. A client that computed "now plus a
//      duration" would reintroduce exactly the drift the grid exists to remove.
//
//   2. THE SETTLEMENT CHAIN. A state machine over §4.4's steps, driven step by
//      step as each call returns, parking at the judging wait and woken by
//      either the deadline timer or the `session.judged` event.
//
//   3. §4.6's RETRY AND DEGRADATION. One wrapper around every call, which is
//      the only place that decides retry-or-not, and the only place that writes
//      to the exhausted set.
//
// WHAT IS DELIBERATELY NOT HERE: the socket, the HTTP client, the health server
// and the process. The clock takes a `TransitionApi` and a `TimerHost` and is
// otherwise pure, which is what lets a test hold it one millisecond short of an
// instant and count the calls it did not make. `scripts/system-scheduler.ts`
// wires it to the real ones.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY EVERY UNIT OF WORK IS ITS OWN TRACKED TASK
// ─────────────────────────────────────────────────────────────────────────────
//
// §4.4: "Settlement of session N and the open window of N+1 are independent …
// nothing about one subject's settlement blocks another subject's boundary."
// §10 asks for it directly: "a judge wait on one session and a failed
// transition on another do not delay any subject's boundary or any other
// session's settlement."
//
// An implementation that awaited settlement inside the boundary handler would
// fail that, and would fail it invisibly — the timers would still be right, the
// calls would just be late. So a boundary re-arms its subject's timer and then
// LAUNCHES settlement without awaiting it, and a rebuild launches one task per
// subject and per settling session. `#track` holds each promise so `idle()` can
// wait for quiescence in a test; production never calls `idle()`.
import type { StreamEventFrame } from "./stream-consumer.ts";
import type {
  ExhaustedItem,
  SchedulerApiFailure,
  SchedulerApiOk,
  SchedulerApiResult,
  SchedulerFullRead,
  SchedulerHealth,
  SettlingSession,
  TimerHandle,
  TimerHost,
  TransitionApi,
} from "./types.ts";

/** A reasoned refusal the clock recorded and did not retry (§4.6). */
export interface RecordedRefusal {
  item: string;
  subjectId?: string;
  sessionId?: string;
  status: number | null;
  error: string;
  atMs: number;
}

export interface ClockOptions {
  timers: TimerHost;
  /** §4.6's retry budget: total attempts, including the first. */
  maxAttempts?: number;
  /** Exponential backoff, in milliseconds. The last step repeats. */
  backoffMs?: readonly number[];
  /** Injected so a test does not wait out a real budget. */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /**
   * §3.1's "if and only if", asked at the instant a boundary or deadline timer
   * fires. The container passes the stream consumer's `current`; a clock with
   * no stream (most unit tests) is always current.
   *
   * A timer that fires while this is false does NOTHING and is dropped, and
   * that is safe rather than lossy: the only way back to current is a rebuild,
   * and a rebuild re-arms every timer from the new snapshot and fires, once,
   * every boundary whose instant has already passed (§3.2). What must not
   * happen is the stale copy acting in the gap — §10's "Silent stall … no
   * stale timer fires" and "a gap causes a full read and rebuild before any
   * further fire".
   */
  isCurrent?: () => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF = [500, 1_000, 2_000, 5_000, 15_000] as const;

/**
 * How far past a refused-as-too-early finalize the clock re-arms its timer.
 *
 * §4.4's finalize is time-guarded by the API's OWN clock, so a scheduler whose
 * clock is a little ahead can fire the deadline timer and be told
 * `judging_deadline_not_reached`. That is a reasoned refusal, and §4.6 says a
 * reasoned refusal is not retried — but it is the one refusal that means "not
 * yet" rather than "never", and treating it as final would strand the session
 * until the next restart.
 *
 * So it is re-armed, bounded by the same retry budget as everything else, and
 * it is a TIMER rather than a retry loop: the clock goes back to waiting rather
 * than spinning. When the budget runs out it degrades like any other item, so
 * an operator sees a genuinely stuck session rather than silence.
 */
const DEADLINE_REARM_MS = 1_000;

type CallOutcome<T> =
  | { kind: "ok"; body: SchedulerApiOk<T> }
  | { kind: "refused"; status: number | null; error: string }
  | { kind: "exhausted"; error: string };

interface WorkId {
  item: string;
  subjectId?: string;
  sessionId?: string;
}

export class SchedulerClock {
  readonly refusals: RecordedRefusal[] = [];
  /** Backoff delays actually waited, in order. Exposed for the retry gate. */
  readonly backoffWaits: number[] = [];

  #api: TransitionApi;
  #timers: TimerHost;
  #maxAttempts: number;
  #backoff: readonly number[];
  #sleep: (ms: number) => Promise<void>;
  #log: (msg: string) => void;
  #isCurrent: () => boolean;

  /** subjectId → the boundary timer it holds. */
  #boundaries = new Map<string, { at: number; sessionId: string; handle: TimerHandle }>();
  /** sessionId → the judging-deadline timer it holds. */
  #deadlines = new Map<string, { at: number; handle: TimerHandle; rearms: number }>();
  /** Sessions whose settlement chain is currently running, so nothing drives it twice. */
  #driving = new Set<string>();
  /** Sessions already carried to `published`, so a duplicate event is free. */
  #published = new Set<string>();
  /** §4.6's degradation surface, keyed by item so a repeat replaces rather than piles up. */
  #exhausted = new Map<string, ExhaustedItem>();

  #authenticated = false;
  /**
   * The API refused this token on a call it had accepted before (HTTP 401 or
   * 403). STICKY for the life of the process: the automation-token criterion
   * says that after re-provisioning "the running scheduler is unhealthy until
   * restarted", and a token that the API has once disowned is not proven good
   * again by a later read that happens to pass — a read right and a lifecycle
   * right are separate grants.
   */
  #tokenRejected: string | null = null;
  #streamSynchronized = false;
  #initialRebuildComplete = false;
  #lastError: string | null = null;
  #stopped = false;

  #inFlight = new Set<Promise<void>>();

  constructor(api: TransitionApi, opts: ClockOptions) {
    this.#api = api;
    this.#timers = opts.timers;
    this.#maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.#sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.#log = opts.log ?? (() => {});
    this.#isCurrent = opts.isCurrent ?? (() => true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // What the container and the tests read
  // ───────────────────────────────────────────────────────────────────────────

  get health(): SchedulerHealth {
    const exhausted = [...this.#exhausted.values()];
    const authenticated = this.#authenticated && this.#tokenRejected === null;
    return {
      authenticated,
      streamSynchronized: this.#streamSynchronized,
      initialRebuildComplete: this.#initialRebuildComplete,
      exhausted,
      healthy:
        authenticated &&
        this.#streamSynchronized &&
        this.#initialRebuildComplete &&
        exhausted.length === 0,
      lastError: this.#lastError,
      timers: { boundaries: this.#boundaries.size, deadlines: this.#deadlines.size },
    };
  }

  get timerCount(): { boundaries: number; deadlines: number } {
    return { boundaries: this.#boundaries.size, deadlines: this.#deadlines.size };
  }

  boundaryAt(subjectId: string): number | null {
    return this.#boundaries.get(subjectId)?.at ?? null;
  }

  deadlineAt(sessionId: string): number | null {
    return this.#deadlines.get(sessionId)?.at ?? null;
  }

  markAuthenticated(ok: boolean, error?: string): void {
    this.#authenticated = ok;
    if (!ok && error) this.#lastError = error;
    // A disowned token keeps its reason on the health surface; see #tokenRejected.
    if (ok) this.#lastError = this.#tokenRejected;
  }

  /**
   * The API rejected this process's token. Unhealthy from here until a
   * restart; nothing later in this process clears it.
   */
  markTokenRejected(error: string): void {
    this.#tokenRejected = error;
    this.#authenticated = false;
    this.#lastError = error;
    this.#log(`automation token rejected: ${error} — unhealthy until restarted`);
  }

  markStreamSynchronized(ok: boolean): void {
    this.#streamSynchronized = ok;
  }

  /** Drop every timer and refuse further work. A restart is a new instance. */
  stop(): void {
    this.#stopped = true;
    for (const b of this.#boundaries.values()) this.#timers.clear(b.handle);
    for (const d of this.#deadlines.values()) this.#timers.clear(d.handle);
    this.#boundaries.clear();
    this.#deadlines.clear();
  }

  /** Resolve once nothing the clock launched is still running. Tests only. */
  async idle(): Promise<void> {
    for (let guard = 0; guard < 1_000 && this.#inFlight.size > 0; guard += 1) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §3 — the rebuild
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Consume a full read: set every timer, resume every settlement, open every
   * missing epoch, and wait.
   *
   * IT CLEARS FIRST. §3.1 makes a rebuild the replacement of the whole copy, not
   * a merge into it — so a timer held for a session the snapshot no longer
   * mentions must be gone, not merely unused. An implementation that only added
   * would keep a stale boundary alive after an operator's early turnover and
   * fire it against a closed epoch.
   *
   * IT DOES NOT AWAIT THE WORK. §6.3 of the smoke spec defines the initial
   * rebuild as complete when "timers reconstructed and recoverable work
   * resumed, not that any settlement has finished". Awaiting settlement here
   * would also make one slow subject delay every other subject's first timer,
   * which §4.4 forbids.
   */
  async rebuild(snapshot: SchedulerFullRead): Promise<void> {
    if (this.#stopped) return;

    for (const b of this.#boundaries.values()) this.#timers.clear(b.handle);
    for (const d of this.#deadlines.values()) this.#timers.clear(d.handle);
    this.#boundaries.clear();
    this.#deadlines.clear();
    this.#driving.clear();

    // 1. A boundary timer per collecting session. One whose instant already
    //    passed is §3.2's missed boundary: fire ONCE, now, never replayed and
    //    never backdated — the API computes the successor's instant from its own
    //    `now()`, so the client supplies no instant at all.
    const collectingSubjects = new Set<string>();
    for (const c of snapshot.collecting) {
      collectingSubjects.add(c.subjectId);
      const at = Date.parse(c.windowClosesAt);
      if (at <= this.#timers.now()) {
        this.#track(this.#fireBoundary(c.subjectId, c.sessionId));
      } else {
        this.#armBoundary(c.subjectId, c.sessionId, at);
      }
    }

    // 2. Every unfinished settlement, resumed from its recorded state. Each is
    //    its own task, so a stuck one delays none of the others.
    for (const s of snapshot.settling) {
      this.#track(this.#resumeSettlement(s));
    }

    // 3. §3: "An active subject with no session in `collecting` is opened
    //    immediately as part of the rebuild." Nothing else opens a first epoch.
    for (const subject of snapshot.subjects) {
      if (collectingSubjects.has(subject.subjectId)) continue;
      this.#track(this.#openFirstEpoch(subject.subjectId));
    }

    this.#initialRebuildComplete = true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §6.2 — the three events
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Apply one stream event.
   *
   * Only the three kinds §6.2 names do anything; an unknown kind is ignored
   * rather than treated as a reason to rebuild, because §3.1 makes a rebuild
   * the answer to a PROVABLE loss of currency, and a kind this build does not
   * know about is not that.
   */
  async applyEvent(event: StreamEventFrame): Promise<void> {
    if (this.#stopped) return;
    switch (event.kind) {
      case "subject.changed":
        return this.#onSubjectChanged(event);
      case "epoch.turned_over":
        return this.#onTurnedOver(event);
      case "session.judged":
        return this.#onJudged(event);
      default:
        return;
    }
  }

  /**
   * §6.2: "re-reads that subject … on activation opens its first epoch; on
   * deactivation drops its boundary timer and settles the closed epoch".
   *
   * THERE IS NO RE-READ CALL, and that is not a shortcut. The event's payload
   * is written in the SAME TRANSACTION as the change it describes
   * (`backend/src/swarm/admin.ts`), so it carries the new duration and the
   * closed epoch's id as committed facts. A separate read could only return the
   * same values or newer ones — and newer ones arrive as their own event above
   * this one's sequence, which §6.3 guarantees. Calling an endpoint to learn
   * what the frame already stated would be a read on a timer in all but name.
   */
  async #onSubjectChanged(event: StreamEventFrame): Promise<void> {
    const subjectId = event.subjectId;
    if (!subjectId) return;
    const payload = (event.payload ?? {}) as {
      reason?: string;
      closedEpochId?: string | null;
    };
    // The event's `epochDurationSeconds` is DELIBERATELY not recorded. Under
    // §2.2's grid the clock never computes a close instant, so a duration it
    // held would be state it could only use to be wrong with.

    if (payload.reason === "deactivated") {
      this.#clearBoundary(subjectId);
      if (payload.closedEpochId) {
        await this.#track(
          this.#resumeSettlement({
            sessionId: payload.closedEpochId,
            subjectId,
            state: "window_closed",
            judgingDeadlineAt: null,
            subjectActive: false,
          }),
        );
      }
      return;
    }

    if (payload.reason === "activated") {
      await this.#track(this.#openFirstEpoch(subjectId));
      return;
    }

    // `updated`: §6.2's "A duration change takes effect at the NEXT boundary:
    // the current window keeps the `window_closes_at` it was opened with." So
    // there is deliberately nothing to do to the timer. Resetting it here would
    // be the bug this clause exists to forbid. §2.2 adds that the admin API
    // re-anchors the grid at the current close in the same transaction, which
    // is likewise the API's business and not a fact this clock has to hold.
  }

  /**
   * §6.2: "sets that subject's boundary timer to the new `window_closes_at`;
   * settles N if it is not already settling."
   *
   * This is the path an OPERATOR's early turnover reaches. The scheduler's own
   * turnover re-arms and settles inline, so by the time its event arrives the
   * successor is already armed and the closed epoch is already driving — and
   * both re-entries are no-ops, which is why a duplicate frame costs nothing.
   */
  async #onTurnedOver(event: StreamEventFrame): Promise<void> {
    const subjectId = event.subjectId;
    const payload = (event.payload ?? {}) as {
      closedSessionId?: string;
      openedSessionId?: string;
      windowClosesAt?: string;
    };
    if (!subjectId || !payload.openedSessionId || !payload.windowClosesAt) return;

    const at = Date.parse(payload.windowClosesAt);
    if (Number.isFinite(at)) {
      if (at <= this.#timers.now()) {
        this.#track(this.#fireBoundary(subjectId, payload.openedSessionId));
      } else {
        this.#armBoundary(subjectId, payload.openedSessionId, at);
      }
    }

    if (payload.closedSessionId) {
      await this.#track(
        this.#resumeSettlement({
          sessionId: payload.closedSessionId,
          subjectId,
          state: "window_closed",
          judgingDeadlineAt: null,
          subjectActive: true,
        }),
      );
    }
  }

  /**
   * §4.4: "The event is a wake-up and nothing more … It lets the scheduler
   * finalize the moment consensus lands instead of waiting out the deadline. It
   * decides nothing. Its arrival time is never compared to anything."
   *
   * Nothing below compares `now` to the deadline, and nothing passes a time to
   * the API. The outcome is decided by finalize from stored instants.
   */
  async #onJudged(event: StreamEventFrame): Promise<void> {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (this.#published.has(sessionId)) return;
    this.#clearDeadline(sessionId);
    await this.#track(this.#finalizeChain(sessionId, event.subjectId ?? undefined));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Timers
  // ───────────────────────────────────────────────────────────────────────────

  #armBoundary(subjectId: string, sessionId: string, at: number): void {
    this.#clearBoundary(subjectId);
    if (this.#stopped) return;
    const handle = this.#timers.set(at, () => {
      this.#boundaries.delete(subjectId);
      // See ClockOptions.isCurrent: a copy that is not provably current does
      // not act, and the rebuild that must follow re-arms this boundary.
      if (!this.#isCurrent()) {
        this.#log(`boundary for ${subjectId} fell while not current; the rebuild owns it`);
        return;
      }
      this.#track(this.#fireBoundary(subjectId, sessionId));
    });
    this.#boundaries.set(subjectId, { at, sessionId, handle });
  }

  #clearBoundary(subjectId: string): void {
    const held = this.#boundaries.get(subjectId);
    if (held) this.#timers.clear(held.handle);
    this.#boundaries.delete(subjectId);
  }

  #armDeadline(sessionId: string, subjectId: string | undefined, at: number, rearms = 0): void {
    this.#clearDeadline(sessionId);
    if (this.#stopped) return;
    const handle = this.#timers.set(at, () => {
      this.#deadlines.delete(sessionId);
      if (!this.#isCurrent()) {
        this.#log(`deadline for ${sessionId} fell while not current; the rebuild owns it`);
        return;
      }
      this.#track(this.#finalizeChain(sessionId, subjectId, rearms));
    });
    this.#deadlines.set(sessionId, { at, handle, rearms });
  }

  #clearDeadline(sessionId: string): void {
    const held = this.#deadlines.get(sessionId);
    if (held) this.#timers.clear(held.handle);
    this.#deadlines.delete(sessionId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §4.3 — the boundary
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Turn the named epoch over, then re-arm on the successor and settle the
   * closed one.
   *
   * §4.3: "Turnover is bound to the epoch, never to 'whatever is open.'" The
   * `expectedSessionId` passed here is the session the timer was armed FOR, not
   * whatever the clock currently believes is open — those differ after an
   * operator's early turnover, and the difference is the whole guarantee.
   *
   * THE RE-ARM HAPPENS BEFORE SETTLEMENT IS LAUNCHED, and settlement is not
   * awaited. A settlement that hangs must not delay the next boundary (§4.4).
   */
  async #fireBoundary(subjectId: string, expectedSessionId: string): Promise<void> {
    const id: WorkId = { item: `turnover:${subjectId}`, subjectId, sessionId: expectedSessionId };
    const out = await this.#call(id, () => this.#api.turnover(subjectId, expectedSessionId));
    if (out.kind !== "ok") return;

    const at = Date.parse(out.body.windowClosesAt);
    if (Number.isFinite(at)) this.#armBoundary(subjectId, out.body.openedSessionId, at);

    this.#track(
      this.#resumeSettlement({
        sessionId: out.body.closedSessionId,
        subjectId,
        state: "window_closed",
        judgingDeadlineAt: null,
        subjectActive: true,
      }),
    );
  }

  /** §3: open an epoch for an active subject that has none, and arm its timer. */
  async #openFirstEpoch(subjectId: string): Promise<void> {
    const id: WorkId = { item: `open:${subjectId}`, subjectId };
    const out = await this.#call(id, () => this.#api.openEpoch(subjectId));
    if (out.kind !== "ok") return;
    const at = Date.parse(out.body.windowClosesAt);
    if (Number.isFinite(at)) this.#armBoundary(subjectId, out.body.sessionId, at);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §4.4 — settlement
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Drive one session's settlement from its recorded state to `published`, or
   * to the point where it parks waiting for a judging deadline.
   *
   * The chain is written as a sequence of guarded steps rather than a switch on
   * the recorded state alone, because §5's guards mean each step is safe to
   * attempt from a state past it: an aggregate on an already-aggregated session
   * answers "already done" and the chain moves on. That is what makes recovery
   * from an UNKNOWN state — the "commit whose response was lost" case — work
   * without the client tracking which calls it believes landed.
   */
  async #resumeSettlement(s: SettlingSession): Promise<void> {
    if (this.#stopped) return;
    if (this.#published.has(s.sessionId)) return;
    if (this.#driving.has(s.sessionId)) return;
    if (this.#deadlines.has(s.sessionId)) return; // already parked on its deadline
    this.#driving.add(s.sessionId);
    try {
      await this.#drive(s);
    } finally {
      this.#driving.delete(s.sessionId);
    }
  }

  async #drive(s: SettlingSession): Promise<void> {
    const { sessionId, subjectId } = s;

    // A recovered `judging` session's deadline is reconstructed from the STORED
    // instant (§3.2, §9). It is never restarted from now, and this is the only
    // place a deadline timer is created from the snapshot.
    if (s.state === "judging") {
      const at = s.judgingDeadlineAt == null ? null : Date.parse(s.judgingDeadlineAt);
      if (at != null && Number.isFinite(at)) {
        if (at > this.#timers.now()) {
          this.#armDeadline(sessionId, subjectId, at);
          return;
        }
        await this.#finalizeChain(sessionId, subjectId);
        return;
      }
      // A `judging` row with no stored deadline is a contradiction the API's
      // paired CHECK forbids. Record it rather than inventing an instant.
      this.#recordRefusal(
        { item: `judging-deadline:${sessionId}`, subjectId, sessionId },
        null,
        "judging_without_stored_deadline",
      );
      return;
    }

    if (s.state === "judged") {
      await this.#finalizeChain(sessionId, subjectId);
      return;
    }

    if (s.state === "window_closed") {
      const agg = await this.#call({ item: `aggregate:${sessionId}`, subjectId, sessionId }, () =>
        this.#api.aggregate(sessionId),
      );
      if (agg.kind !== "ok") return;
    }

    // `aggregated`, or just aggregated above.
    const req = await this.#call({ item: `request-judging:${sessionId}`, subjectId, sessionId }, () =>
      this.#api.requestJudging(sessionId),
    );

    if (req.kind === "ok") {
      const at = Date.parse(req.body.deadlineAt);
      if (Number.isFinite(at) && at > this.#timers.now()) {
        this.#armDeadline(sessionId, subjectId, at);
        return;
      }
      await this.#finalizeChain(sessionId, subjectId);
      return;
    }

    if (req.kind === "refused" && req.error === "judge_mode_off") {
      // §4.4: "`off`: no judging is requested and nothing waits.
      // `aggregated → publish` directly, with judging outcome `not_judged`.
      // This is not a failure and is never presented as one." So this refusal
      // is removed from the refusal record it was just written into: it is the
      // mode's normal answer, and leaving it there would make an operator's
      // health view list every `off` session as a problem.
      this.#forgetRefusal(`request-judging:${sessionId}`);
      await this.#finalizeChain(sessionId, subjectId);
      return;
    }

    // Any other refusal, or exhaustion: recorded by #call, chain stops. §4.6:
    // "The work resumes on the next rebuild."
  }

  /**
   * Finalize, and remember the session is done.
   *
   * §4.4: "A repeated finalize returns the outcome already decided; it never
   * re-decides." The client's `#published` set is a courtesy that saves a call,
   * not the guarantee — the guarantee is the API's, and the client never
   * depends on its own memory surviving a restart.
   */
  async #finalizeChain(sessionId: string, subjectId?: string, rearms = 0): Promise<void> {
    if (this.#stopped) return;
    if (this.#published.has(sessionId)) return;
    const id: WorkId = { item: `finalize:${sessionId}`, subjectId, sessionId };
    const out = await this.#call(id, () => this.#api.finalize(sessionId));

    if (out.kind === "ok") {
      this.#published.add(sessionId);
      this.#clearDeadline(sessionId);
      this.#log(`session ${sessionId} published with outcome ${out.body.outcome}`);
      return;
    }

    if (out.kind === "refused" && out.error === "judging_deadline_not_reached") {
      // See DEADLINE_REARM_MS. The API's clock is a little behind this one;
      // go back to waiting rather than spinning, bounded by the retry budget.
      this.#forgetRefusal(id.item);
      if (rearms + 1 >= this.#maxAttempts) {
        this.#markExhausted(id, "judging_deadline_not_reached", rearms + 1);
        return;
      }
      this.#armDeadline(sessionId, subjectId, this.#timers.now() + DEADLINE_REARM_MS, rearms + 1);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §4.6 — the one place retry is decided
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Make one call, retrying only what §4.6 says to retry.
   *
   *   * a refusal with a reason → final, recorded, NOT retried;
   *   * a transient error or lost response → bounded exponential backoff;
   *   * the budget running out → degraded, naming the item and the last error,
   *     and no further attempt until the next rebuild.
   *
   * A success CLEARS any exhaustion recorded for the same item, which is how
   * §10's "a restart after the dependency recovers resumes it exactly once"
   * ends with a healthy scheduler rather than a stale degradation.
   */
  async #call<T>(id: WorkId, fn: () => Promise<SchedulerApiResult<T>>): Promise<CallOutcome<T>> {
    let last: SchedulerApiFailure = { ok: false, status: null, error: "never_attempted", transient: true };

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (this.#stopped) return { kind: "exhausted", error: "stopped" };

      let result: SchedulerApiResult<T>;
      try {
        result = await fn();
      } catch (err) {
        // A thrown transport error IS a lost response: the request may have
        // committed. §4.6 retries it for exactly that reason.
        result = { ok: false, status: null, error: String((err as Error)?.message ?? err), transient: true };
      }

      if (result.ok) {
        this.#exhausted.delete(id.item);
        return { kind: "ok", body: result };
      }

      if (!result.transient) {
        this.#recordRefusal(id, result.status, result.error);
        // A refusal of the CREDENTIAL, not of the transition. Still final and
        // not retried, but it is not this item's problem: every later call
        // will meet it too, so the scheduler as a whole stops being healthy.
        if (result.status === 401 || result.status === 403) {
          this.markTokenRejected(`${id.item}: API rejected the automation token (HTTP ${result.status}): ${result.error}`);
        }
        return { kind: "refused", status: result.status, error: result.error };
      }

      last = result;
      if (attempt < this.#maxAttempts) {
        const delay = this.#backoff[Math.min(attempt - 1, this.#backoff.length - 1)];
        this.backoffWaits.push(delay);
        await this.#sleep(delay);
      }
    }

    this.#markExhausted(id, last.error, this.#maxAttempts);
    return { kind: "exhausted", error: last.error };
  }

  #markExhausted(id: WorkId, lastError: string, attempts: number): void {
    this.#exhausted.set(id.item, {
      item: id.item,
      subjectId: id.subjectId,
      sessionId: id.sessionId,
      lastError,
      attempts,
      exhaustedAtMs: this.#timers.now(),
    });
    this.#log(`degraded: ${id.item} after ${attempts} attempts — ${lastError}`);
  }

  #recordRefusal(id: WorkId, status: number | null, error: string): void {
    this.refusals.push({
      item: id.item,
      subjectId: id.subjectId,
      sessionId: id.sessionId,
      status,
      error,
      atMs: this.#timers.now(),
    });
  }

  #forgetRefusal(item: string): void {
    for (let i = this.refusals.length - 1; i >= 0; i -= 1) {
      if (this.refusals[i].item === item) {
        this.refusals.splice(i, 1);
        return;
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  #track(p: Promise<void>): Promise<void> {
    const tracked = p
      .catch((err) => {
        // A task that throws must not take the process down: §4.6 gives every
        // failure a home on the health surface, and an unhandled rejection
        // would bypass it.
        this.#log(`task failed: ${String((err as Error)?.message ?? err)}`);
        this.#lastError = String((err as Error)?.message ?? err);
      })
      .finally(() => {
        this.#inFlight.delete(tracked);
      });
    this.#inFlight.add(tracked);
    return tracked;
  }
}

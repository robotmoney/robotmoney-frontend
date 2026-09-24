// The `system-scheduler` container's shared vocabulary — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §4, §4.6, §7 and §10,
// and docs/technical/smoke-production-spec.md §6.3.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE TYPES ARE HERE AND NOT IMPORTED FROM THE BACKEND
// ─────────────────────────────────────────────────────────────────────────────
//
// §7: `system-scheduler` "holds exactly one" credential, an API token. It "never
// touches the database, so it has no role password."
//
// `backend/src/config.ts` requires DATABASE_URL at MODULE SCOPE. Importing any
// backend module that reaches it — and `backend/src/swarm/domain.ts`, where the
// server-side shapes live, imports the database handle directly — would make a
// database credential a startup requirement of a process that must never hold
// one. The invariant would be violated by an import statement.
//
// So the wire shapes are declared here, structurally, against the same JSON the
// API serves. The duplication is the price of the credential boundary and it is
// deliberate. `scripts/tests/unit/system-scheduler-wire-parity.test.ts` reads
// the backend's declarations as TEXT and asserts the field names match, so the
// two cannot drift silently without importing one into the other.

/**
 * A `fetch` a test can substitute.
 *
 * `typeof fetch` cannot be used: Bun's declaration carries a `preconnect`
 * property, so every injected stub would have to invent one to typecheck. This
 * is the call surface and nothing else.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ─────────────────────────────────────────────────────────────────────────────
// §3's full read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §3 part 1: an active subject and its schedule.
 *
 * §2.2 was amended on 2026-09-24 (D52) from one parameter to three:
 * `epoch_duration` (the grid spacing), `epoch_anchor` (one instant on the grid)
 * and `judging_duration`, carried with their unit suffix per D53 (7). §3 part 1
 * says the full read returns every active subject "with its scheduling
 * columns", so all three are here. The CLIENT computes nothing from them —
 * every close instant and every judging deadline arrives already decided by
 * the API, and the clock's whole job is to wait for it — so they are carried
 * as read, for the operator's health surface, never as inputs to a timer. The
 * API's declaration is the authority; `system-scheduler-wire-parity.test.ts`
 * compares the two as text.
 */
export interface SchedulerSubject {
  subjectId: string;
  name: string;
  /** The grid's spacing, and the length of every full window. */
  epochDurationSeconds: number;
  /** One instant on the grid: every close is `epochAnchor + k × epochDurationSeconds`. */
  epochAnchor: string;
  /** How long judging waits for a consensus once requested (§4.4). Not part of the grid. */
  judgingDurationSeconds: number;
}

/** §3 part 2: an open window and the instant it closes at. */
export interface CollectingSession {
  sessionId: string;
  subjectId: string;
  windowClosesAt: string;
}

/** §3 part 3's four states: closed, but not yet `published`. */
export type SettlingState = "window_closed" | "aggregated" | "judging" | "judged";

/** §3 part 3: an unfinished settlement the rebuild has to resume. */
export interface SettlingSession {
  sessionId: string;
  subjectId: string;
  state: SettlingState;
  /** The API's STORED deadline. §3.2: "never restarted from now." */
  judgingDeadlineAt: string | null;
  /** §4.5: settlement of a deactivated subject's closed epoch still has to finish. */
  subjectActive: boolean;
}

export interface SchedulerFullRead {
  subjects: SchedulerSubject[];
  collecting: CollectingSession[];
  settling: SettlingSession[];
  /** §3 part 4, §6.3: the sequence of the last event committed before this snapshot. */
  cursor: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.6's three outcomes, as one type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a transition call can answer.
 *
 * §4.6 names three outcomes and handles them differently, so the type names all
 * three and forces the caller to tell them apart:
 *
 *   * success — including the "already done" successes, which carry a flag
 *     (`replayed`, `transitioned`, `created`) rather than being a refusal, so
 *     §4.6's "the scheduler continues the chain from there" is the DEFAULT path
 *     and not something the client has to reconstruct.
 *   * a refusal with a reason (`transient: false`) — final. Never retried.
 *   * a transient error or lost response (`transient: true`) — retried with
 *     bounded backoff.
 *
 * A lost response reaches this as `transient: true` with `status: null`, which
 * is the same shape a 503 takes, because §4.6 treats them identically: "A
 * transient error or a lost response is retried."
 */
export type SchedulerApiOk<T> = { ok: true } & T;
export interface SchedulerApiFailure {
  ok: false;
  /** Null when the call never reached an HTTP status at all (a lost response). */
  status: number | null;
  error: string;
  transient: boolean;
}
export type SchedulerApiResult<T> = SchedulerApiOk<T> | SchedulerApiFailure;

export interface OpenBody {
  subjectId: string;
  sessionId: string;
  state: "collecting";
  windowClosesAt: string;
  /** False when the epoch was already open and this call returned it (§4.1). */
  created: boolean;
}

export interface TurnoverBody {
  subjectId: string;
  closedSessionId: string;
  openedSessionId: string;
  windowClosesAt: string;
  judgeMode: "off" | "enforce";
  /** True when the turnover had already happened and its ORIGINAL result came back (§4.3). */
  replayed: boolean;
}

export interface AggregateBody {
  sessionId: string;
  state: "aggregated";
  transitioned: boolean;
}

export interface RequestJudgingBody {
  sessionId: string;
  state: "judging";
  /** The STORED absolute deadline (§4.4). A repeat returns the same instant. */
  deadlineAt: string;
  transitioned: boolean;
}

export interface FinalizeBody {
  sessionId: string;
  state: "published";
  outcome: "judged" | "no_consensus" | "not_judged";
  replayed: boolean;
}

/**
 * Every lifecycle call the clock makes, and nothing else.
 *
 * Deliberately narrow: the clock cannot read a take, cannot change a duration
 * and cannot write a judgement, because none of those is on this interface. The
 * HTTP client implements it; a test implements it in memory.
 */
export interface TransitionApi {
  openEpoch(subjectId: string): Promise<SchedulerApiResult<OpenBody>>;
  turnover(subjectId: string, expectedSessionId: string): Promise<SchedulerApiResult<TurnoverBody>>;
  aggregate(sessionId: string): Promise<SchedulerApiResult<AggregateBody>>;
  requestJudging(sessionId: string): Promise<SchedulerApiResult<RequestJudgingBody>>;
  finalize(sessionId: string): Promise<SchedulerApiResult<FinalizeBody>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The timer host
// ─────────────────────────────────────────────────────────────────────────────

export interface TimerHandle {
  id: number;
}

/**
 * The clock's only access to time.
 *
 * §3: "It fires at the instant. It does not poll the API on an interval. It
 * does not tick." An interface with `set(instant, fn)` and no `every(ms, fn)`
 * is that rule expressed as a type: there is no way to write a polling loop
 * through it without writing a self-rescheduling timer, which a reader would
 * see.
 *
 * Injecting it is also the only way §10's "one tick before the instant produces
 * no API call" can be asserted, because it needs a clock a test can hold one
 * millisecond short of an instant.
 */
export interface TimerHost {
  now(): number;
  set(atMs: number, fn: () => void): TimerHandle;
  clear(h: TimerHandle): void;
}

/**
 * The production timer host.
 *
 * `setTimeout` saturates above 2^31-1 ms (~24.9 days) and fires IMMEDIATELY on
 * an overflowed delay, which for an epoch duration measured in weeks would turn
 * the boundary into a hot loop. So a long wait is chained in bounded hops and
 * the instant is re-checked at each one; §3's "fires at the instant" survives,
 * and a clock adjustment during the wait is corrected rather than accumulated.
 */
const MAX_DELAY_MS = 2_147_483_000;

export function realTimers(): TimerHost {
  let next = 1;
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  const host: TimerHost = {
    now: () => Date.now(),
    set(atMs, fn) {
      const id = next++;
      const arm = (): void => {
        const remaining = atMs - Date.now();
        if (remaining <= 0) {
          live.delete(id);
          fn();
          return;
        }
        live.set(id, setTimeout(arm, Math.min(remaining, MAX_DELAY_MS)));
      };
      arm();
      return { id };
    },
    clear(h) {
      const t = live.get(h.id);
      if (t !== undefined) clearTimeout(t);
      live.delete(h.id);
    },
  };
  return host;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.6's degradation surface, §6.3 of the smoke spec's readiness input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One piece of work the retry budget ran out on.
 *
 * §4.6: the scheduler "marks itself degraded on its health surface naming the
 * subject or session and the last error, and stops retrying that item." Both
 * identifiers are optional because a turnover names a subject and a settlement
 * step names a session, and inventing the other one would be a lie in the
 * operator's only view of the failure.
 */
export interface ExhaustedItem {
  /** A stable key for the work, e.g. `turnover:sub-a` or `aggregate:s12`. */
  item: string;
  subjectId?: string;
  sessionId?: string;
  lastError: string;
  /** How many attempts the budget allowed. */
  attempts: number;
  /** When the budget ran out, as the clock's own time source reports it. */
  exhaustedAtMs: number;
}

/**
 * What the health endpoint answers, and what smoke's readiness consumes.
 *
 * Smoke spec §6.3 names exactly four requirements on the scheduler's side, and
 * this type is those four: "the scheduler authenticated to the API; its stream
 * established and synchronized; its initial rebuild complete …; and every
 * active subject holding a `collecting` session. A scheduler reporting
 * exhausted work is not ready."
 *
 * The fourth is NOT here, on purpose: the scheduler is not the authority on
 * which subjects have a collecting session at this instant — the API is, and
 * §6.3 has smoke check it separately. A scheduler asserting it would be
 * reporting its own stale copy as a fact about the database.
 */
export interface SchedulerHealth {
  authenticated: boolean;
  streamSynchronized: boolean;
  initialRebuildComplete: boolean;
  exhausted: ExhaustedItem[];
  /** True only when the first three hold and `exhausted` is empty. */
  healthy: boolean;
  /** Set when the startup check or a later probe failed, for the operator's view. */
  lastError: string | null;
  /** Timers currently held, for the operator's view. Not a readiness input. */
  timers: { boundaries: number; deadlines: number };
}

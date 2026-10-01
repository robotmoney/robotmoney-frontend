// The epoch lifecycle and the scheduler stream's log (issue #1026, W4.2 to W4.4).
//
// EVERY STATEMENT IN THIS FILE IS REGISTERED (smoke-production-spec.md §7.1,
// D55 (13)). A statement that names a relation goes through `on(...)` with a
// declaration of `(role, object, privilege)`, and each one carries a probe that
// tests/db-registry-execution.test.ts runs as the declared role. A statement
// that names no relation (the database clock, the snapshot setting of the full
// read) goes through `onStatement(...)` and equals a shape on the registry's
// closed list. There is no raw `sql` template here, and this module is NOT on
// the raw-statement allowlist in tests/db-registry.test.ts, so the detector
// fails the build if one is added.
//
// WHY THIS IS A MODULE OF ITS OWN. It lived in `swarm/domain.ts` because a new
// module issuing raw statements would have needed a new allowlist line, and the
// allowlist only shrinks. Registering the sites removes that reason. The names
// are unchanged: `domain.ts` re-exports this module, so `import * as epoch from
// "../../swarm/domain.ts"` and every test that imports from there keep working.
//
// The one edge back into `domain.ts` is a set of helpers the lifecycle shares
// with the take and judgement paths (`aggregateSession`, the brief builders,
// `recordAbsencesTx`, `judgeOfRecordTx`). It is a cycle, and a safe one: this
// module touches them only inside function bodies, and registers its sites at
// module level without reading anything from `domain.ts`.
import { type DbHandle, jsonValue, sql } from "../db/client.ts";
import { on, onStatement, registerQuery, registerStatement } from "../db/registry.ts";
import {
  aggregateSession,
  appendBriefRevision,
  buildBriefBody,
  judgeOfRecordTx,
  recordAbsencesTx,
} from "./domain.ts";

/** The entry modules that reach this file's statements (QueryDeclaration.callers). */
const ADMIN_ROUTE = "src/api/routes/swarm-admin";
const STREAM_ROUTE = "src/api/routes/swarm-stream";
const JUDGE_ROUTE = "src/api/routes/swarm-judge-participant";

/** A sample session id and subject id for probes: well-formed, referring to nothing. */
const SAMPLE_UUID = "00000000-0000-0000-0000-000000000000";
const SAMPLE_TEXT = "2000-01-01 00:00:00+00";

// ── The scheduler event stream (spec §6, §9) ────────────────────────────────
//
// "Every change to what the clock waits on is an event on the stream, sequenced
// in the transaction that made the change" (§9). That sentence is why this
// takes a transaction handle and has no non-transactional form: an event
// written after its transition commits is an event a crash can lose, and a lost
// event with no later event behind it is exactly the failure §6.3's
// head-sequence keepalive exists to catch. Writing it inside makes the case
// impossible rather than detectable.
//
// THE NUMBER COMES FROM ONE COUNTER ROW (§6.3, D52; migration 0081). "Each
// event takes its number by incrementing one counter row inside the
// transaction that makes the change. The row lock serializes event-writing
// transactions, so numbers are assigned in commit order and a rolled-back
// transaction leaves no hole." `UPDATE swarm_stream_head ... RETURNING` takes
// that row lock and holds it to COMMIT: the next writer waits until this
// number is either visible or rolled back (which restores the old value), so
// the numbers are gapless and commit-ordered by construction.
//
// Not a database sequence: a sequence numbers at insert time, so a later number
// can commit first and push a subscriber's cursor past an earlier one still in
// flight — §6.3 then has the subscriber drop that earlier event as a duplicate.
// And no longer MAX(seq) + 1 under an advisory lock, which it replaced: the two
// agree only while the log is never pruned. D53 (2) lets rm_owner prune rows
// below the oldest servable cursor, and once the newest rows can be gone,
// MAX + 1 hands out a number a subscriber already holds. The counter only moves
// forward (its trigger refuses a decrease), whatever is deleted.
export type StreamEventKind = "subject.changed" | "epoch.turned_over" | "session.judged";

/** Every writer of the log reaches it through one of these entry modules: the admin route (a subject change, a turnover) and the judge's submit route (a recorded consensus). */
const EVENT_WRITERS = [ADMIN_ROUTE, JUDGE_ROUTE] as const;

const advanceHead = registerQuery({
  role: "rm_app",
  object: "swarm_stream_head",
  // SELECT as well: `seq = seq + 1` and RETURNING both read the counter.
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/epoch:appendStreamEvent.advanceHead",
  purpose: "Take the next event number by incrementing the one counter row, whose lock serialises event writers (spec §6.3).",
  callers: EVENT_WRITERS,
  probe: { statement: "UPDATE swarm_stream_head SET seq = seq + 1 RETURNING seq" },
});

const insertEvent = registerQuery({
  role: "rm_app",
  object: "swarm_stream_events",
  privileges: ["INSERT"],
  site: "src/swarm/epoch:appendStreamEvent.insert",
  purpose: "Append one event to the stream's log, in the transaction of the change it announces.",
  callers: EVENT_WRITERS,
  probe: {
    statement: `INSERT INTO swarm_stream_events (seq, kind, subject_id, session_id, payload)
    VALUES ($1, $2, $3, $4, $5::jsonb)`,
    params: ["1", "subject.changed", null, null, "{}"],
  },
});

export async function appendStreamEvent(
  tx: DbHandle,
  kind: StreamEventKind,
  target: { subjectId?: string | null; sessionId?: string | null; payload?: Record<string, unknown> },
): Promise<number> {
  const [head] = await on(tx, advanceHead)<{ seq: string }>`UPDATE swarm_stream_head SET seq = seq + 1 RETURNING seq`;
  if (!head) throw new Error("swarm_stream_head holds no row: the event counter (migration 0081) is missing");
  await on(tx, insertEvent)`
    INSERT INTO swarm_stream_events (seq, kind, subject_id, session_id, payload)
    VALUES (${head.seq}, ${kind}, ${target.subjectId ?? null}, ${target.sessionId ?? null},
            ${tx.json((target.payload ?? {}) as any)})`;
  return Number(head.seq);
}

const readHead = registerQuery({
  role: "rm_app",
  object: "swarm_stream_head",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:streamHeadSequence",
  purpose: "Read the stream's head sequence: the cursor a full read is paired with, and the head every keepalive carries.",
  callers: [STREAM_ROUTE],
  probe: { statement: "SELECT seq FROM swarm_stream_head" },
});

/**
 * The last sequence number committed — the cursor a full read is paired with,
 * and the head every keepalive carries (§6.3). Read from the counter row, never
 * from the log: after a prune the log's MAX is not the head.
 */
export async function streamHeadSequence(h: DbHandle = sql): Promise<number> {
  const [row] = await on(h, readHead)<{ seq: string }>`SELECT seq FROM swarm_stream_head`;
  if (!row) throw new Error("swarm_stream_head holds no row: the event counter (migration 0081) is missing");
  return Number(row.seq);
}

// ═════════════════════════════════════════════════════════════════════════════
// THE EPOCH LIFECYCLE (issue #1026 W4.2/W4.3)
// ═════════════════════════════════════════════════════════════════════════════
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §4 and §5. Where this
// section and the older cron-driven lifecycle above it disagree, the spec says
// the code changes; this section IS that change, and it is deliberately new
// rather than grafted onto `openSession` / `closeWindow` / `publishSession`,
// which stay exactly as they are until W4.8 retires their callers.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE IDEA
// ─────────────────────────────────────────────────────────────────────────────
//
// The API decides nothing about timing. `system-scheduler` holds the clock and
// calls in at the instant; every function here is a state-guarded transition
// that can be called twice, called late, called by two schedulers at once, or
// retried after a lost response, and must produce the same world either way.
// Only `system-scheduler` calls them (D55): there is no operator or admin
// early turnover. §5 states the rule and §10 races it: "a boundary fired
// twice, a settlement resumed after downtime, a stale timer, a second
// scheduler, and a retry after a lost response all reach the same guard."
//
// So every function returns a DISCRIMINATED result rather than throwing, and
// the successful ones say whether they actually did the work (`transitioned` /
// `replayed`). §5: "Where the transition has already happened, the guard
// returns the original result rather than a bare refusal, so a caller can tell
// 'already done' from 'not allowed.'"
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT HERE
// ─────────────────────────────────────────────────────────────────────────────
//
//   * No timer, no interval, no background work. The API "runs no background
//     orchestration of its own" (§1).
//   * No SUBSCRIPTION. Every transition below writes its event to the log in
//     its own transaction (§9), but the cursor handoff, the keepalive and the
//     resync that serve that log to a subscriber are the serving section's
//     below, and nothing here depends on them. There are no job pushes (§6.3).
//   * No judge call and no push to a judge. Requesting judging records the
//     request and its absolute deadline, which is the STATE a judge
//     subscription is served on every connect (smoke spec §6.2); the
//     subscription itself is W4.7.
//   * No fallback. There is no path in this file that invents a verdict, a
//     certificate or a template opinion when a real one is missing (§4.4).

// There is no judging-duration constant. §2.2 makes `judging_duration` a
// subject column (`judging_duration_seconds`, migration 0073, D53 (7)), and
// §4.4 captures it onto the session at turnover (migration 0074) beside the
// judge mode. `requestJudging` adds THAT captured value to the request instant.

export type JudgeMode = "off" | "enforce";
export type JudgingOutcome = "judged" | "no_consensus" | "not_judged";

/** A refusal always carries a machine-readable reason. §4.6 turns on it: a reasoned refusal is never retried. */
export type Refusal = {
  ok: false;
  status: number;
  error: string;
};

const refuse = (status: number, error: string): Refusal => ({ ok: false, status, error });

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 — The grid, and §4.2 — one clock
// ─────────────────────────────────────────────────────────────────────────────
//
// Every close is `epoch_anchor + k × epoch_duration` for an integer k. The API
// computes k, and nothing else about timing (§1).
//
// ONE PRESENT PER TRANSACTION (§4.2). A derived instant is computed from a
// single reading of `clock_timestamp()`, taken once and passed down, so a
// transaction never acts on two different presents. It is carried as TEXT, not
// as a JS Date: a Date keeps milliseconds and Postgres keeps microseconds, and
// a round trip through one would store a close that is not quite the instant
// the grid rule chose. It goes back in as `${x}::text::timestamptz`, never
// `${x}::timestamptz`: with the bare cast Postgres infers the PARAMETER as
// timestamptz, and postgres.js then serializes the string through a Date —
// the very truncation the text form exists to avoid.
//
// THE ARITHMETIC STAYS IN SQL. `extract(epoch FROM interval)` is exact numeric
// in Postgres 14+, and `make_interval(secs => k·d)` adds a pure time span with
// no calendar component, so `anchor + k·d` is exact to the microsecond. Doing
// it in JS would pass the anchor through a double and lose that.

const clockText = registerStatement({
  role: "rm_app",
  shape: "clockText",
  site: "src/swarm/epoch:readPresent",
  purpose: "Read the database clock once per transaction, as lossless text (§4.2).",
  callers: [ADMIN_ROUTE],
});

/** One reading of the database clock, as lossless text (§4.2). */
export async function readPresent(tx: DbHandle): Promise<string> {
  const [row] = await onStatement(tx, clockText)<{ at: string }>`SELECT clock_timestamp()::text AS at`;
  return row.at;
}

/**
 * The close of the epoch about to open, on the subject's grid (§2.2).
 *
 *   `after` given (turnover): the first grid instant strictly after N's
 *     `window_closes_at` — on an unchanged grid exactly N's close plus one
 *     duration. If that instant is not after `present`, it has passed, and the
 *     close is the first grid instant after `present` instead. Missed slots are
 *     skipped, never opened (§3.2).
 *   `after` null (first epoch — a fresh subject, an activation, a rebuild): the
 *     first grid instant at least HALF a duration after `present`, so the
 *     window lasts between half a duration and one and a half, never a sliver.
 *
 * Both branches read `present` and nothing else for "now".
 */
const gridRead = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:gridClose",
  purpose: "Compute the next close on a subject's grid from its anchor and duration, in SQL so no instant passes through a double (§2.2).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `
    WITH g AS (
      SELECT epoch_anchor AS a, epoch_duration_seconds::numeric AS d,
             $1::text::timestamptz AS p, $2::text::timestamptz AS n
        FROM swarm_subjects WHERE id = $3
    ), k AS (
      SELECT a, d, p, n,
             CASE WHEN n IS NULL
                  THEN ceil((extract(epoch FROM (p - a)) + d / 2) / d)
                  ELSE floor(extract(epoch FROM (n - a)) / d) + 1
             END AS k,
             floor(extract(epoch FROM (p - a)) / d) + 1 AS k_after_present
        FROM g
    )
    SELECT (CASE
              WHEN n IS NOT NULL AND a + make_interval(secs => (k * d)::float8) <= p
                THEN a + make_interval(secs => (k_after_present * d)::float8)
              ELSE a + make_interval(secs => (k * d)::float8)
            END)::text AS close
      FROM k`,
    params: [SAMPLE_TEXT, null, "grid-probe-subject"],
  },
});

async function gridClose(
  tx: DbHandle,
  subjectId: string,
  present: string,
  after: string | null,
): Promise<string> {
  const [row] = await on(tx, gridRead)<{ close: string }>`
    WITH g AS (
      SELECT epoch_anchor AS a, epoch_duration_seconds::numeric AS d,
             ${present}::text::timestamptz AS p, ${after}::text::timestamptz AS n
        FROM swarm_subjects WHERE id = ${subjectId}
    ), k AS (
      SELECT a, d, p, n,
             CASE WHEN n IS NULL
                  THEN ceil((extract(epoch FROM (p - a)) + d / 2) / d)
                  ELSE floor(extract(epoch FROM (n - a)) / d) + 1
             END AS k,
             floor(extract(epoch FROM (p - a)) / d) + 1 AS k_after_present
        FROM g
    )
    SELECT (CASE
              WHEN n IS NOT NULL AND a + make_interval(secs => (k * d)::float8) <= p
                THEN a + make_interval(secs => (k_after_present * d)::float8)
              ELSE a + make_interval(secs => (k * d)::float8)
            END)::text AS close
      FROM k`;
  if (!row) throw new Error(`gridClose: no subject ${subjectId}`);
  return row.close;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 — Epoch open
// ─────────────────────────────────────────────────────────────────────────────

export type OpenResult = {
  ok: true;
  status: number;
  subjectId: string;
  sessionId: string;
  state: "collecting";
  windowClosesAt: string;
  /** False when this call found an epoch already open and returned it (§4.1). */
  created: boolean;
};

/**
 * Open an epoch: create the session, publish its brief, set `window_closes_at`
 * — one transaction, §4.1.
 *
 * THE CLOSE IS ON THE GRID (§2.2). An epoch opened here has no predecessor, so
 * it takes the first-epoch rule: the first grid instant at least half a
 * duration after the present this transaction read. Its window is therefore
 * between half a duration and one and a half — never `now + duration`, and
 * never a sliver nobody could submit into.
 *
 * CONCURRENCY. Two callers reaching this at once both try to INSERT a
 * `collecting` row, and migration 0068's partial unique index lets exactly one
 * through. The loser does not fail: it reads the winner's session and returns
 * it, which is §4.1's "the second call returns it." The race is resolved by the
 * database rather than by a lock we take first, because a lock would have to be
 * taken on something — and the thing worth locking is precisely the row that
 * does not exist yet.
 */
const readSubjectToOpen = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:openEpoch.subject",
  purpose: "Read the subject an epoch is being opened for: it must exist and be active (§4.1).",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT id, name, status FROM swarm_subjects WHERE id = $1", params: ["grid-probe-subject"] },
});

export async function openEpoch(subjectId: string): Promise<OpenResult | Refusal> {
  try {
    return await sql.begin(async (tx) => {
      const [subject] = await on(tx, readSubjectToOpen)<{ id: string; name: string; status: string }>`
        SELECT id, name, status FROM swarm_subjects WHERE id = ${subjectId}`;
      if (!subject) return refuse(404, "subject_not_found");
      if (subject.status !== "active") return refuse(409, "subject_not_active");
      const closesAt = await gridClose(tx, subject.id, await readPresent(tx), null);
      return await insertEpoch(tx, subject, closesAt);
    });
  } catch (err) {
    if (isOneCollectingViolation(err)) {
      const existing = await currentCollecting(sql, subjectId);
      if (existing) {
        return {
          ok: true,
          status: 200,
          subjectId,
          sessionId: existing.id,
          state: "collecting",
          windowClosesAt: new Date(existing.window_closes_at).toISOString(),
          created: false,
        };
      }
    }
    throw err;
  }
}

/**
 * The three writes of §4.1, in the caller's transaction.
 *
 * Shared by `openEpoch` and by turnover, which opens N+1 in the SAME
 * transaction that closes N. There is one implementation because §4.3 defines
 * the successor by reference — "opens epoch N+1 (§4.1)" — and two
 * implementations would let the first epoch of a subject and every later one
 * drift apart.
 *
 * THE CLOSE COMES FROM THE CALLER. The two callers apply different grid rules
 * (§2.2: first epoch vs turnover), each against its own single reading of the
 * clock, so this function computes no instant of its own.
 */
const insertSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  // SELECT as well: RETURNING * reads every column of the row it wrote.
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/epoch:insertEpoch.session",
  purpose: "Create the epoch's session, `collecting`, with its close on the grid (§4.1).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
    SELECT $1, $2, 'collecting', $3::text::timestamptz WHERE false
    RETURNING *`,
    params: ["grid-probe-subject", "Probe", SAMPLE_TEXT],
  },
});

const seatMembers = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["INSERT"],
  site: "src/swarm/epoch:insertEpoch.seat",
  purpose: "Freeze the epoch's seated roster at open: every active `member` is `expected` (scheduler spec §4.3).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
    SELECT $1, m.id, m.name, m.lens, 'expected'
      FROM swarm_members m
     WHERE m.status = 'active' AND m.role = 'member'`,
    params: [SAMPLE_UUID],
  },
});

const readSeatable = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:insertEpoch.seatable",
  purpose: "Read the active members the roster is frozen from (the SELECT half of the seating INSERT).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
    SELECT $1, m.id, m.name, m.lens, 'expected'
      FROM swarm_members m
     WHERE m.status = 'active' AND m.role = 'member'`,
    params: [SAMPLE_UUID],
  },
});

const insertBrief = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["INSERT"],
  site: "src/swarm/epoch:insertEpoch.brief",
  purpose: "Publish the epoch's brief with the session it belongs to (§4.1).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_briefs (session_id, date, subject_id, body, report_snapshot_id)
           SELECT $1, $2, $3, $4::jsonb, $5::bigint WHERE false`,
    params: [SAMPLE_UUID, "2000-01-01", "grid-probe-subject", "{}", null],
  },
});

async function insertEpoch(
  tx: DbHandle,
  subject: { id: string; name: string },
  closesAt: string,
): Promise<OpenResult> {
  const [session] = await on(tx, insertSession)<Record<string, any>>`
    INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
    VALUES (${subject.id}, ${subject.name ?? subject.id}, 'collecting', ${closesAt}::text::timestamptz)
    RETURNING *`;
  const windowClosesAt = new Date(session.window_closes_at).toISOString();
  // THE EPOCH'S SEATED ROSTER, frozen at open (scheduler spec §4.3). Turnover
  // records "an `absent` event for each seated member with no take received
  // before `window_closes_at`", and recordAbsencesTx reads the seated members
  // from swarm_session_members — so an epoch that seats nobody records no
  // absence, ever. Every active member with the `member` role is seated here,
  // in the transaction that opens the epoch: the rule the retired admin
  // session create used, with name and lens denormalised at seating time
  // (loadFrozenTakeSet digests the frozen name, issue #765). Judges hold no
  // seat: they file no take (§4.4). The roster is immutable from this instant,
  // because the session is already `collecting`: a member activated afterwards
  // joins the NEXT epoch (docs/architecture/admin-surface.md US-C3), which is
  // what keeps who may submit, whose take counts and who is recorded absent one
  // set, fixed when the window opened.
  await on(tx, seatMembers, readSeatable)`
    INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
    SELECT ${session.id}, m.id, m.name, m.lens, 'expected'
      FROM swarm_members m
     WHERE m.status = 'active' AND m.role = 'member'`;
  const { body, reportSnapshotId } = await buildBriefBody(session, windowClosesAt, undefined, tx);
  await appendBriefRevision(String(session.id), body, reportSnapshotId, tx);
  await on(tx, insertBrief)`INSERT INTO swarm_briefs (session_id, date, subject_id, body, report_snapshot_id)
           VALUES (${session.id}, ${session.date}, ${subject.id},
                   ${tx.json(jsonValue(body) as any)}, ${reportSnapshotId}::bigint)`;
  return {
    ok: true,
    status: 201,
    subjectId: subject.id,
    sessionId: String(session.id),
    state: "collecting",
    windowClosesAt,
    created: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.3 — The boundary
// ─────────────────────────────────────────────────────────────────────────────

export type TurnoverResult = {
  ok: true;
  status: number;
  subjectId: string;
  closedSessionId: string;
  /**
   * The successor N+1, or null when the subject was inactive at the boundary
   * (§4.3 "opens epoch N+1 … but only if the subject is active at that
   * instant"; §4.5, D55 (4)). A null here is not a failure: N closed and
   * settles, and nothing opened.
   */
  openedSessionId: string | null;
  /** N+1's close, or null with `openedSessionId`. */
  windowClosesAt: string | null;
  judgeMode: JudgeMode;
  /** True when this call found the turnover already done and returned its original result (§4.3). */
  replayed: boolean;
};

/**
 * Close epoch N and open N+1, in one transaction, bound to N.
 *
 * THIS IS THE LOAD-BEARING FUNCTION OF THE WHOLE WORKSTREAM. §4.3: "Turnover is
 * bound to the epoch, never to 'whatever is open.'" Three callers can arrive
 * holding a stale idea of the world — a retry after a lost response, a timer
 * that fired after an operator turned over early, a second scheduler during a
 * deploy — and none of them may close the successor.
 *
 * HOW THE BINDING WORKS. `expectedSessionId` names the epoch the caller intends
 * to close, and the answer is decided entirely from that row:
 *
 *   * it is `collecting`           → do the turnover. For an inactive
 *                                    subject that closes N and opens nothing
 *                                    (§4.5, D55 (4)).
 *   * it already has a successor   → replay that original result verbatim.
 *   * it was closed as an epoch with no successor (a turnover of an inactive
 *     subject's window) → replay that result: N closed, nothing opened.
 *   * it was closed with nothing captured (a row closed before capture
 *     existed, e.g. by the retired admin `close` verb) → reasoned no-op.
 *     `closeWindow` DOES capture, so a session it closed with no successor
 *     replays like an inactive subject's boundary; it has no callers today.
 *   * it belongs to another subject, or does not exist   → reasoned no-op.
 *
 * At no point is "the subject's current collecting session" consulted as a
 * TARGET. It is only ever compared against, which is the difference between a
 * bound turnover and the unbound one §4.3 forbids.
 *
 * THE SUBJECT ROW IS LOCKED FIRST, `FOR NO KEY UPDATE` — strong enough to
 * serialise two turnovers, and deliberately not `FOR UPDATE`: a take in flight
 * holds this epoch's session row and needs a key-share lock on the subject for
 * its foreign key, which `FOR UPDATE` would refuse it, deadlocking the two.
 * Two schedulers racing the same epoch would
 * otherwise both read `collecting` and both try to insert a successor; one
 * would lose on the unique index and take an error rather than a replay. The
 * lock serialises them so the loser reads the winner's committed successor and
 * replays it — which is what §10's "race two schedulers against the same epoch"
 * gate asks for: "exactly one successor and one reasoned no-op or replayed
 * result."
 */
const lockSubject = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  // UPDATE as well: FOR NO KEY UPDATE is a row lock, and Postgres requires
  // UPDATE on the table for one.
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/epoch:turnOverEpoch.subject",
  purpose: "Lock the subject's row for the boundary and read its status and judging duration (§4.3).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `SELECT id, name, status, judging_duration_seconds FROM swarm_subjects
       WHERE id = $1 FOR NO KEY UPDATE`,
    params: ["grid-probe-subject"],
  },
});

const readExpectedSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:turnOverEpoch.expected",
  purpose: "Read the session the scheduler says is closing, with its close as lossless text.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: "SELECT *, window_closes_at::text AS window_closes_at_text FROM swarm_sessions WHERE id = $1",
    params: [SAMPLE_UUID],
  },
});

const readSuccessor = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:turnOverEpoch.successor",
  purpose: "Read the successor an earlier turnover already opened, for a replay's original result.",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT id, window_closes_at FROM swarm_sessions WHERE id = $1", params: [SAMPLE_UUID] },
});

const closeWindow = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  // SELECT as well: the WHERE reads `id` and `state`.
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/epoch:turnOverEpoch.close",
  purpose: "Close epoch N, capturing the judge mode and the judging duration on it (§4.4).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions
                SET state = 'window_closed', judge_mode = $1,
                    judging_duration_seconds = $2
              WHERE id = $3 AND state = 'collecting'`,
    params: ["off", 900, SAMPLE_UUID],
  },
});

const linkSuccessor = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/epoch:turnOverEpoch.link",
  purpose: "Record which session succeeded the one just closed.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions SET successor_session_id = $1
                WHERE id = $2`,
    params: [SAMPLE_UUID, SAMPLE_UUID],
  },
});

export async function turnOverEpoch(
  subjectId: string,
  expectedSessionId: string,
): Promise<TurnoverResult | Refusal> {
  if (!isUuid(expectedSessionId)) return refuse(400, "expected_session_not_found");
  return sql.begin(async (tx) => {
    const [subject] = await on(tx, lockSubject)<{ id: string; name: string; status: string; judging_duration_seconds: number }>`
      SELECT id, name, status, judging_duration_seconds FROM swarm_subjects
       WHERE id = ${subjectId} FOR NO KEY UPDATE`;
    if (!subject) return refuse(404, "subject_not_found");

    const [expected] = await on(tx, readExpectedSession)<Record<string, any>>`
      SELECT *, window_closes_at::text AS window_closes_at_text FROM swarm_sessions WHERE id = ${expectedSessionId}`;
    if (!expected) return refuse(404, "expected_session_not_found");
    if (expected.subject_id !== subjectId) return refuse(409, "expected_session_not_for_subject");

    if (expected.state !== "collecting") {
      if (!expected.successor_session_id) {
        // Closed with no successor. When the close captured its judge mode and
        // judging duration, it was an epoch close — the boundary of an
        // inactive subject's window (§4.5) — and a retry after a lost
        // response gets that original result back, so the scheduler settles
        // N instead of recording a refusal (§5: "the guard returns the
        // original result rather than a bare refusal"). A session closed with
        // nothing captured (a row from before capture existed, e.g. the
        // retired admin `close` verb) stays a reasoned no-op. `closeWindow`
        // captures both values, so a session it closed takes the replay
        // branch; it has no callers today.
        if (!judgingCaptured(expected)) return refuse(409, "epoch_not_collecting");
        return {
          ok: true as const,
          status: 200,
          subjectId,
          closedSessionId: String(expected.id),
          openedSessionId: null,
          windowClosesAt: null,
          judgeMode: expected.judge_mode as JudgeMode,
          replayed: true,
        };
      }
      const [successor] = await on(tx, readSuccessor)<Record<string, any>>`
        SELECT id, window_closes_at FROM swarm_sessions WHERE id = ${expected.successor_session_id}`;
      return {
        ok: true as const,
        status: 200,
        subjectId,
        closedSessionId: String(expected.id),
        openedSessionId: String(expected.successor_session_id),
        windowClosesAt: new Date(successor.window_closes_at).toISOString(),
        judgeMode: expected.judge_mode as JudgeMode,
        replayed: true,
      };
    }

    // §4.5, D55 (4) as corrected 2026-09-25 — THE WINDOW RUNS TO ITS CLOSE. An
    // admin deactivation only sets the subject inactive; it closes nothing. The
    // open window keeps accepting takes until `window_closes_at`, and THIS is
    // the transaction that closes it: the ordinary boundary turnover, which
    // closes N, records absences and captures the judge mode exactly as for an
    // active subject, and then opens no N+1 because the subject is inactive.
    // The status is read once, under the subject lock taken above, so an
    // activation racing this boundary either commits first (N+1 opens) or
    // waits for it (nothing opens here, and the scheduler opens the first
    // epoch from that activation's subject.changed).
    const opensSuccessor = subject.status === "active";

    // §4.4: "Judge mode and judging duration are captured at turnover." Read
    // once, here, and stored on the closing session — everything downstream
    // reads the stored values, so an admin changing either mid-settlement
    // cannot reach this epoch.
    const judgeMode = await currentJudgeMode(tx);

    await on(tx, closeWindow)`UPDATE swarm_sessions
                SET state = 'window_closed', judge_mode = ${judgeMode},
                    judging_duration_seconds = ${subject.judging_duration_seconds}
              WHERE id = ${expectedSessionId} AND state = 'collecting'`;
    await recordAbsencesTx(expectedSessionId, tx);

    // §2.2 turnover rule, against ONE reading of the clock taken here — after
    // the subject lock is held, so a turnover that waited on another never
    // derives its close from a present that went stale while it waited.
    let successor: OpenResult | null = null;
    if (opensSuccessor) {
      const closesAt = await gridClose(tx, subjectId, await readPresent(tx), expected.window_closes_at_text ?? null);
      successor = await insertEpoch(tx, subject, closesAt);
      await on(tx, linkSuccessor)`UPDATE swarm_sessions SET successor_session_id = ${successor.sessionId}
                WHERE id = ${expectedSessionId}`;
    }
    // §6.2: `epoch.turned_over` — "epoch N closed and N+1 opened", or N closed
    // and nothing opened for an inactive subject (§4.5), which the scheduler
    // reads as "drop the boundary timer, settle N". Written here, in the
    // transaction that did both, so the scheduler cannot be told about a
    // turnover that rolled back or miss one that committed. A REPLAY does not
    // publish: the event for this turnover was written when it happened, and a
    // second copy would read to a subscriber as a second turnover.
    await appendStreamEvent(tx, "epoch.turned_over", {
      subjectId,
      sessionId: successor?.sessionId ?? expectedSessionId,
      payload: {
        closedSessionId: expectedSessionId,
        openedSessionId: successor?.sessionId ?? null,
        windowClosesAt: successor?.windowClosesAt ?? null,
      },
    });

    return {
      ok: true as const,
      status: 200,
      subjectId,
      closedSessionId: expectedSessionId,
      openedSessionId: successor?.sessionId ?? null,
      windowClosesAt: successor?.windowClosesAt ?? null,
      judgeMode,
      replayed: false,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.4 — Settlement
// ─────────────────────────────────────────────────────────────────────────────

const readSessionState = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:aggregateEpoch.state",
  purpose: "Read the session's state, the guard of the aggregate step (§4.4).",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT state FROM swarm_sessions WHERE id = $1", params: [SAMPLE_UUID] },
});

const lockSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  // UPDATE as well: FOR UPDATE is a row lock, which Postgres allows only to a
  // role holding UPDATE on the table.
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/epoch:lockSession",
  purpose: "Lock a session's row and read all of it, the first statement of request-judging, of a consensus and of finalize (§4.4).",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE],
  probe: { statement: "SELECT * FROM swarm_sessions WHERE id = $1 FOR UPDATE", params: [SAMPLE_UUID] },
});

export type AggregateResult = {
  ok: true;
  status: number;
  sessionId: string;
  state: "aggregated";
  transitioned: boolean;
};

/**
 * Step 1: roll the signed takes up into the recommendation.
 *
 * Deterministic, and independent of anything judging later produces (§4.4).
 * The arithmetic itself is `domain.aggregateSession`, unchanged — this wrapper
 * exists for the state guard, which that function does not have.
 */
export async function aggregateEpoch(sessionId: string): Promise<AggregateResult | Refusal> {
  const [s] = await on(sql, readSessionState)<{ state: string }>`SELECT state FROM swarm_sessions WHERE id = ${sessionId}`;
  if (!s) return refuse(404, "session_not_found");
  // Already past this step: idempotent success, not a refusal (§5).
  if (s.state !== "window_closed") {
    if (["aggregated", "judging", "judged", "published"].includes(s.state)) {
      return { ok: true, status: 200, sessionId, state: "aggregated", transitioned: false };
    }
    return refuse(409, `session_not_window_closed`);
  }
  await aggregateSession(sessionId);
  return { ok: true, status: 200, sessionId, state: "aggregated", transitioned: true };
}

const requestDeadline = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/epoch:requestJudging.deadline",
  purpose: "Move the session to `judging`, recording the request instant and the absolute deadline (§4.4).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `
      UPDATE swarm_sessions s
         SET state = 'judging',
             judging_requested_at = c.at,
             judging_deadline_at = c.at + make_interval(secs => s.judging_duration_seconds)
        FROM (SELECT clock_timestamp() AS at) c
       WHERE s.id = $1 AND s.state = 'aggregated'
         AND s.judging_duration_seconds IS NOT NULL
       RETURNING s.judging_deadline_at`,
    params: [SAMPLE_UUID],
  },
});

const readJudgement = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:recordJudgingConsensusTx.judgement",
  purpose: "Read the judgement a consensus is being recorded from, and who authored it (§4.4).",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `
    SELECT id, judged_by_member_id FROM swarm_session_judgements
     WHERE id = $1 AND session_id = $2`,
    params: [1, SAMPLE_UUID],
  },
});

const clockTimestamp = registerStatement({
  role: "rm_app",
  shape: "clockTimestamp",
  site: "src/swarm/epoch:recordJudgingConsensusTx.lateAt",
  purpose: "Read the database clock as the acceptance instant of late evidence (§4.2).",
  callers: [JUDGE_ROUTE],
});

const recordConsensus = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/epoch:recordJudgingConsensusTx.record",
  purpose: "Advance the session to `judged`, stamping the consensus with its acceptance instant (§4.4).",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `
    UPDATE swarm_sessions
       SET state = 'judged',
           consensus_recorded_at = COALESCE($1::text::timestamptz, clock_timestamp())
     WHERE id = $2 AND state = 'judging'
     RETURNING consensus_recorded_at`,
    params: [null, SAMPLE_UUID],
  },
});

const readSettlementInstants = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:finalizeEpoch.instants",
  purpose: "Compare the stored consensus and deadline instants in SQL, at microsecond precision (§4.4).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `
        SELECT (consensus_recorded_at IS NOT NULL AND consensus_recorded_at <= judging_deadline_at) AS consensus_eligible,
               (clock_timestamp() >= judging_deadline_at) AS deadline_reached
          FROM swarm_sessions WHERE id = $1`,
    params: [SAMPLE_UUID],
  },
});

const publishSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/epoch:finalizeEpoch.publish",
  purpose: "Publish the session with the judging outcome decided from stored instants (§4.4).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions
                SET state = 'published',
                    judging_outcome = $1,
                    published_at = COALESCE(published_at, clock_timestamp()),
                    version = version + 1
              WHERE id = $2`,
    params: ["judged", SAMPLE_UUID],
  },
});

export type RequestJudgingResult = {
  ok: true;
  status: number;
  sessionId: string;
  state: "judging";
  deadlineAt: string;
  transitioned: boolean;
};

/**
 * Step 2 under `enforce`: record the request and the ABSOLUTE deadline.
 *
 * §4.4: "the API records the request instant and the absolute deadline
 * (request instant plus the judging duration captured at turnover), moves the
 * session to `judging`, returns the deadline". §9: that deadline "is never
 * restarted by a rebuild" — which is why a repeated request returns the stored
 * instant rather than computing a fresh one. A scheduler that crashed between
 * the request and its response reconstructs the ORIGINAL timer from this value.
 *
 * ONE READING OF THE CLOCK (§4.2). The request instant is `clock_timestamp()`
 * read once, and the deadline is that same reading plus the session's captured
 * `judging_duration_seconds` — never the subject's current value, which an
 * admin may have changed since the epoch closed.
 *
 * NOTHING CAPTURED, NOTHING REQUESTED (§4.4: "Judge mode and judging duration
 * are captured at turnover"). A session whose `judge_mode` or
 * `judging_duration_seconds` is NULL (migration 0074) was closed before
 * capture existed — by the retired admin `close` verb, or by `closeWindow`
 * before it began capturing — and has no captured value to settle by. It is refused with `judging_not_captured`. It is
 * NOT settled from the subject's live column: that value is whatever an admin
 * set AFTER the close, so reading it here would let a later change reach a
 * settling session, which is exactly what capture-at-turnover forbids. A
 * `judge_mode` of `shadow` on a pre-D53 row is refused the same way — D53 (1)
 * left no write path that can act on it.
 *
 * Under `off` this is a reasoned refusal rather than a silent success: nothing
 * should be calling it, and saying so is how a scheduler bug surfaces instead
 * of a session sitting in a state nobody meant to reach.
 */
export async function requestJudging(sessionId: string): Promise<RequestJudgingResult | Refusal> {
  return sql.begin(async (tx) => {
    const [s] = await on(tx, lockSession)<Record<string, any>>`
      SELECT * FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`;
    if (!s) return refuse(404, "session_not_found");
    if (!judgingCaptured(s)) return refuse(409, "judging_not_captured");
    if (s.judge_mode === "off") return refuse(409, "judge_mode_off");
    if (s.judging_deadline_at) {
      return {
        ok: true as const,
        status: 200,
        sessionId,
        state: "judging" as const,
        deadlineAt: new Date(s.judging_deadline_at).toISOString(),
        transitioned: false,
      };
    }
    if (s.state !== "aggregated") return refuse(409, "session_not_aggregated");
    const [upd] = await on(tx, requestDeadline)<{ judging_deadline_at: Date }>`
      UPDATE swarm_sessions s
         SET state = 'judging',
             judging_requested_at = c.at,
             judging_deadline_at = c.at + make_interval(secs => s.judging_duration_seconds)
        FROM (SELECT clock_timestamp() AS at) c
       WHERE s.id = ${sessionId} AND s.state = 'aggregated'
         AND s.judging_duration_seconds IS NOT NULL
       RETURNING s.judging_deadline_at`;
    if (!upd) return refuse(409, "session_not_aggregated");
    return {
      ok: true as const,
      status: 200,
      sessionId,
      state: "judging" as const,
      deadlineAt: new Date(upd.judging_deadline_at).toISOString(),
      transitioned: true,
    };
  });
}

export type RecordConsensusResult = {
  ok: true;
  status: number;
  sessionId: string;
  state: string;
  recordedAt: string;
  /** True when the session was already published: recorded, but it decides nothing (§4.4). */
  lateEvidence: boolean;
};

/**
 * Record the judges' consensus with its ACCEPTANCE instant.
 *
 * §4.4: "the API records it with its acceptance instant, advances the session
 * to `judged` if its state guard permits, and publishes `session.judged`. A
 * consensus that lands after the session is already `published` is recorded as
 * late evidence and changes neither the lifecycle state nor the published
 * outcome."
 *
 * The instant stored here is the ONLY time this consensus will ever be judged
 * by. Nothing downstream looks at when an event arrived, when a timer fired, or
 * when finalize was called — §9: "An event's arrival time never decides an
 * outcome."
 *
 * A consensus reaches the API through `submitJudgement` alone; the
 * `epochs/consensus` admin route that took a bare judgement id is retired.
 *
 * Runs inside a transaction the caller already holds.
 *
 * `submitJudgement` needs it: the judgement row and the consensus it forms are
 * written in ONE transaction, so a crash between the two can never leave a
 * judge of record's judgement on file with no consensus recorded, or a
 * consensus pointing at a row that rolled back.
 *
 * ELIGIBILITY IS CHECKED HERE, NOT ONLY BY THE CALLER (§4.4). A consensus is
 * the judgement of the session's judge of record: an active member holding the
 * `judge` role, with no take in the session, passing the third-party gate,
 * chosen by member id (`judgeOfRecordTx`). A judgement by anyone else — a
 * second seated judge, a revoked judge, a judge that also filed a take, a row
 * that names no member at all — is refused as a consensus and stays on file as
 * the evidence it is.
 *
 * THE ACCEPTANCE INSTANT is `clock_timestamp()` at the write (§4.2), never the
 * transaction's `now()`: a consensus written by a transaction that began before
 * the deadline and committed after it was accepted after it.
 */
export async function recordJudgingConsensusTx(
  tx: DbHandle,
  sessionId: string,
  judgementId: number,
  /** The caller's one reading of the clock, when it already decided on it (§4.2). */
  present?: string,
): Promise<RecordConsensusResult | Refusal> {
  const [s] = await on(tx, lockSession)<Record<string, any>>`
    SELECT * FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`;
  if (!s) return refuse(404, "session_not_found");
  const [j] = await on(tx, readJudgement)<{ id: string; judged_by_member_id: string | null }>`
    SELECT id, judged_by_member_id FROM swarm_session_judgements
     WHERE id = ${judgementId} AND session_id = ${sessionId}`;
  if (!j) return refuse(404, "judgement_not_for_session");

  if (s.state === "published") {
    // Late evidence. The judgement row already exists and stays; nothing
    // about the session moves.
    const [late] = await onStatement(tx, clockTimestamp)<{ at: Date }>`SELECT clock_timestamp() AS at`;
    return {
      ok: true as const,
      status: 200,
      sessionId,
      state: "published",
      recordedAt: new Date(late.at).toISOString(),
      lateEvidence: true,
    };
  }
  const ofRecord = await judgeOfRecordTx(tx, sessionId);
  if (!j.judged_by_member_id || j.judged_by_member_id !== ofRecord) {
    return refuse(409, "judgement_not_from_judge_of_record");
  }
  if (s.consensus_recorded_at) {
    return {
      ok: true as const,
      status: 200,
      sessionId,
      state: s.state,
      recordedAt: new Date(s.consensus_recorded_at).toISOString(),
      lateEvidence: false,
    };
  }
  if (s.state !== "judging") return refuse(409, "session_not_judging");
  const [upd] = await on(tx, recordConsensus)<{ consensus_recorded_at: Date }>`
    UPDATE swarm_sessions
       SET state = 'judged',
           consensus_recorded_at = COALESCE(${present ?? null}::text::timestamptz, clock_timestamp())
     WHERE id = ${sessionId} AND state = 'judging'
     RETURNING consensus_recorded_at`;
  // §6.2: `session.judged`. A WAKE-UP and nothing more (§4.4) — the scheduler
  // finalizes the moment consensus lands instead of waiting out the deadline,
  // and finalize re-reads the stored instants either way. Written in this
  // transaction so it exists if and only if the consensus was recorded; late
  // evidence after publication publishes nothing, because nothing the clock
  // waits on changed.
  await appendStreamEvent(tx, "session.judged", {
    subjectId: s.subject_id,
    sessionId,
    payload: { judgementId, recordedAt: new Date(upd.consensus_recorded_at).toISOString() },
  });
  return {
    ok: true as const,
    status: 200,
    sessionId,
    state: "judged",
    recordedAt: new Date(upd.consensus_recorded_at).toISOString(),
    lateEvidence: false,
  };
}

export type FinalizeResult = {
  ok: true;
  status: number;
  sessionId: string;
  state: "published";
  outcome: JudgingOutcome;
  /** True when the outcome had already been decided and is being returned unchanged (§4.4). */
  replayed: boolean;
};

/**
 * Step 3: decide the judging outcome from STORED instants, then publish.
 *
 * §4.4 gives the whole decision in three lines, and this function is those
 * three lines and nothing else:
 *
 *   `judged`       — a consensus was recorded at or before the deadline;
 *   `no_consensus` — no consensus was recorded at or before the deadline;
 *   `not_judged`   — mode was `off`.
 *
 * TIME-GUARDED AS WELL AS STATE-GUARDED. "With no eligible consensus it refuses
 * finalize as a reasoned no-op until the deadline has passed by the database
 * clock, because absence of a consensus before the deadline proves nothing."
 * The comparison reads `clock_timestamp()` ONCE, on the locked row, at the
 * moment of the comparison (§4.2) — never the transaction's `now()`, which is
 * when the transaction began, and never the application's clock. Read once
 * and kept, so the answer cannot change halfway through deciding it.
 *
 * THE BOUNDARY INSTANT, exactly as §4.4 words it: a consensus recorded AT the
 * deadline is eligible (`<=`), and finalize is accepted AT the deadline
 * (`present >= deadline`). Both inclusive, and they are inclusive independently:
 * the first is about the consensus, the second about the caller.
 *
 * NOTHING IS FABRICATED. The `no_consensus` branch writes an outcome and
 * publishes. It does not write a judgement row, a certificate, a placeholder
 * opinion or a default verdict, and there is no `else` in this function that
 * could.
 */
export async function finalizeEpoch(sessionId: string): Promise<FinalizeResult | Refusal> {
  return sql.begin(async (tx) => {
    const [s] = await on(tx, lockSession)<Record<string, any>>`
      SELECT * FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`;
    if (!s) return refuse(404, "session_not_found");

    if (s.state === "published") {
      // Decided once. §4.4: "A repeated finalize returns the outcome already
      // decided; it never re-decides."
      return {
        ok: true as const,
        status: 200,
        sessionId,
        state: "published" as const,
        outcome: s.judging_outcome as JudgingOutcome,
        replayed: true,
      };
    }

    // Nothing captured at turnover → nothing to settle by (see requestJudging).
    // Checked AFTER the published replay, so an outcome already decided is
    // still returned, and BEFORE any branch reads the mode — a NULL mode used
    // to fall through to the `enforce` branch below.
    if (!judgingCaptured(s)) return refuse(409, "judging_not_captured");

    let outcome: JudgingOutcome;
    if (s.judge_mode === "off") {
      if (s.state !== "aggregated") return refuse(409, "session_not_publishable");
      outcome = "not_judged";
    } else {
      if (!s.judging_deadline_at) return refuse(409, "judging_not_requested");
      // Compared IN SQL, at microsecond precision — a JS Date would round both
      // instants to the millisecond and could call a consensus recorded half a
      // millisecond after the deadline "at" it — and in a statement of its own,
      // AFTER the row lock above is held, so the clock is read at the
      // comparison rather than before a lock wait.
      const [t] = await on(tx, readSettlementInstants)<{ consensus_eligible: boolean; deadline_reached: boolean }>`
        SELECT (consensus_recorded_at IS NOT NULL AND consensus_recorded_at <= judging_deadline_at) AS consensus_eligible,
               (clock_timestamp() >= judging_deadline_at) AS deadline_reached
          FROM swarm_sessions WHERE id = ${sessionId}`;
      if (t.consensus_eligible === true) {
        outcome = "judged";
      } else if (t.deadline_reached !== true) {
        // Not a failure — a reasoned no-op. The judges still have time.
        return refuse(409, "judging_deadline_not_reached");
      } else {
        outcome = "no_consensus";
      }
    }

    await on(tx, publishSession)`UPDATE swarm_sessions
                SET state = 'published',
                    judging_outcome = ${outcome},
                    published_at = COALESCE(published_at, clock_timestamp()),
                    version = version + 1
              WHERE id = ${sessionId}`;
    return {
      ok: true as const,
      status: 200,
      sessionId,
      state: "published" as const,
      outcome,
      replayed: false,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Did this session's close capture what settlement runs on (§4.4)? Turnover
 * writes both `judge_mode` (off | enforce) and
 * `judging_duration_seconds` in the transaction that closes the epoch; a
 * session missing either never closed as an epoch.
 */
function judgingCaptured(s: Record<string, any>): boolean {
  return (s.judge_mode === "off" || s.judge_mode === "enforce") && s.judging_duration_seconds != null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const readCollecting = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:currentCollecting",
  purpose: "Read a subject's open epoch, for the loser of an open race to return the winner's session (§4.1).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `
    SELECT id, window_closes_at FROM swarm_sessions
     WHERE subject_id = $1 AND state = 'collecting'`,
    params: ["grid-probe-subject"],
  },
});

const readJudgeMode = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:currentJudgeMode",
  purpose: "Read the judge mode a turnover captures onto the closing session (§4.4).",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT mode FROM swarm_judge_config WHERE id = 1" },
});

async function currentCollecting(
  h: DbHandle,
  subjectId: string,
): Promise<{ id: string; window_closes_at: Date } | null> {
  const [row] = await on(h, readCollecting)<{ id: string; window_closes_at: Date }>`
    SELECT id, window_closes_at FROM swarm_sessions
     WHERE subject_id = ${subjectId} AND state = 'collecting'`;
  return row ?? null;
}

/**
 * The operator's judge mode, reduced to the two D48 admits.
 *
 * D53 (1) removed `shadow` from every write path, so the config row says `off`
 * or `enforce`. Anything that is not `enforce` still captures `off` — the one
 * reading that neither creates a shadow judgement nor pretends an enforcement
 * the operator did not ask for — so a row written before D53 cannot reach a
 * session as a third mode.
 */
async function currentJudgeMode(h: DbHandle): Promise<JudgeMode> {
  const [cfg] = await on(h, readJudgeMode)<{ mode: string }>`SELECT mode FROM swarm_judge_config WHERE id = 1`;
  return cfg?.mode === "enforce" ? "enforce" : "off";
}

/** Migration 0068's partial unique index, by name — the only violation this module interprets. */
function isOneCollectingViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; message?: string };
  return e?.code === "23505" &&
    (e.constraint_name === "swarm_sessions_one_collecting_per_subject" ||
      Boolean(e.message?.includes("swarm_sessions_one_collecting_per_subject")));
}
// ─────────────────────────────────────────────────────────────────────────────
// §3 — the full read
// ─────────────────────────────────────────────────────────────────────────────

/** §3 part 1: an active subject and its three scheduling columns (§2.2, D53 (7)). */
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

/** §3 part 2: an open window, and the instant it closes at. */
export interface CollectingSession {
  sessionId: string;
  subjectId: string;
  windowClosesAt: string;
}

/** The four states §3 part 3 names: closed, but not yet `published`. */
export type SettlingState = "window_closed" | "aggregated" | "judging" | "judged";

/** §3 part 3: an unfinished settlement the rebuild has to resume. */
export interface SettlingSession {
  sessionId: string;
  subjectId: string;
  state: SettlingState;
  /** §3: "for `judging` its recorded deadline". The STORED instant, never a fresh one (§9). */
  judgingDeadlineAt: string | null;
  /**
   * Whether the subject is still active.
   *
   * Carried because §3 includes sessions "whose subject has since been
   * deactivated" and §4.5 says their settlement still has to finish. A
   * SETTLING session holds no boundary timer whatever its subject's status —
   * its window already closed. The boundary timer of an inactive subject's
   * still-open window comes from §3 part 2 (`collecting`), which lists it
   * too (D55 (4): the window runs to its close).
   */
  subjectActive: boolean;
}

export interface SchedulerFullRead {
  subjects: SchedulerSubject[];
  collecting: CollectingSession[];
  settling: SettlingSession[];
  /** §3 part 4, §6.3: the sequence of the last event committed before this snapshot. */
  cursor: number;
}

const SETTLING_STATES: readonly SettlingState[] = ["window_closed", "aggregated", "judging", "judged"];

const isoOrNull = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

/**
 * §3's four parts and the cursor, as one consistent snapshot.
 *
 * Read the module header for why this is one REPEATABLE READ transaction rather
 * than five statements. The cursor is taken INSIDE it, from the same snapshot
 * the rows came from.
 */
const snapshotReadOnly = registerStatement({
  role: "rm_app",
  shape: "snapshotReadOnly",
  site: "src/swarm/epoch:fullRead.snapshot",
  purpose: "Open the full read's one REPEATABLE READ, READ ONLY snapshot (scheduler spec §3).",
  callers: [STREAM_ROUTE],
});

const readActiveSubjects = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:fullRead.subjects",
  purpose: "Part 1 of the full read: every active subject with its three scheduling columns.",
  callers: [STREAM_ROUTE],
  probe: {
    statement: `
      SELECT id, name, epoch_duration_seconds, epoch_anchor, judging_duration_seconds FROM swarm_subjects
       WHERE status = 'active' ORDER BY id`,
  },
});

const readCollectingSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:fullRead.collecting",
  purpose: "Part 2 of the full read: every open window and the instant it closes at.",
  callers: [STREAM_ROUTE],
  probe: {
    statement: `
      SELECT id, subject_id, window_closes_at FROM swarm_sessions
       WHERE state = 'collecting' ORDER BY window_closes_at`,
  },
});

const SETTLING_PROBE = `
      SELECT s.id, s.subject_id, s.state, s.judging_deadline_at,
             COALESCE(t.status = 'active', false) AS subject_active
        FROM swarm_sessions s
        LEFT JOIN swarm_subjects t ON t.id = s.subject_id
       WHERE s.state = ANY($1)
       ORDER BY s.convened_at`;
const SETTLING_PARAMS = ["{window_closed,aggregated,judging,judged}"];

const readSettlingSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:fullRead.settling",
  purpose: "Part 3 of the full read: every closed but unpublished session, whose settlement the rebuild resumes.",
  callers: [STREAM_ROUTE],
  probe: { statement: SETTLING_PROBE, params: SETTLING_PARAMS },
});

const readSettlingSubjects = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:fullRead.settlingSubjects",
  purpose: "The subject half of part 3's join: whether each settling session's subject is still active.",
  callers: [STREAM_ROUTE],
  probe: { statement: SETTLING_PROBE, params: SETTLING_PARAMS },
});

export async function fullRead(): Promise<SchedulerFullRead> {
  return sql.begin(async (tx) => {
    await onStatement(tx, snapshotReadOnly)`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

    const subjects = await on(tx, readActiveSubjects)<
      { id: string; name: string; epoch_duration_seconds: number; epoch_anchor: Date; judging_duration_seconds: number }
    >`
      SELECT id, name, epoch_duration_seconds, epoch_anchor, judging_duration_seconds FROM swarm_subjects
       WHERE status = 'active' ORDER BY id`;

    const collecting = await on(tx, readCollectingSessions)<{ id: string; subject_id: string; window_closes_at: Date }>`
      SELECT id, subject_id, window_closes_at FROM swarm_sessions
       WHERE state = 'collecting' ORDER BY window_closes_at`;

    const settling = await on(tx, readSettlingSessions, readSettlingSubjects)<
      { id: string; subject_id: string; state: SettlingState; judging_deadline_at: Date | null; subject_active: boolean }
    >`
      SELECT s.id, s.subject_id, s.state, s.judging_deadline_at,
             COALESCE(t.status = 'active', false) AS subject_active
        FROM swarm_sessions s
        LEFT JOIN swarm_subjects t ON t.id = s.subject_id
       WHERE s.state = ANY(${SETTLING_STATES as unknown as string[]})
       ORDER BY s.convened_at`;

    // §6.3: "The full read takes its cursor from the counter value visible in
    // its own snapshot." Same REPEATABLE READ transaction as the rows above, so
    // every change they do not reflect carries a number above this one.
    const head = await streamHeadSequence(tx);

    return {
      subjects: subjects.map((s) => ({
        subjectId: s.id,
        name: s.name,
        epochDurationSeconds: Number(s.epoch_duration_seconds),
        epochAnchor: isoOrNull(s.epoch_anchor)!,
        judgingDurationSeconds: Number(s.judging_duration_seconds),
      })),
      collecting: collecting.map((c) => ({
        sessionId: String(c.id),
        subjectId: c.subject_id,
        windowClosesAt: isoOrNull(c.window_closes_at)!,
      })),
      settling: settling.map((s) => ({
        sessionId: String(s.id),
        subjectId: s.subject_id,
        state: s.state,
        judgingDeadlineAt: isoOrNull(s.judging_deadline_at),
        subjectActive: s.subject_active,
      })),
      cursor: head,
    };
  }) as Promise<SchedulerFullRead>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — serving events above a cursor
// ─────────────────────────────────────────────────────────────────────────────

export interface ServedStreamEvent {
  seq: number;
  kind: string;
  subjectId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  committedAt: string;
}

const readEventsAbove = registerQuery({
  role: "rm_app",
  object: "swarm_stream_events",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:eventsAbove",
  purpose: "Serve the events strictly above a subscriber's cursor, in order (§6.3).",
  callers: [STREAM_ROUTE],
  probe: {
    statement: `
    SELECT seq, kind, subject_id, session_id, payload, committed_at
      FROM swarm_stream_events
     WHERE seq > $1
     ORDER BY seq
     LIMIT $2`,
    params: [0, 500],
  },
});

const readFloor = registerQuery({
  role: "rm_app",
  object: "swarm_stream_events",
  privileges: ["SELECT"],
  site: "src/swarm/epoch:retainedFloor",
  purpose: "Read the lowest sequence still in the log, to tell a truncated cursor from a servable one (§6.3).",
  callers: [STREAM_ROUTE],
  probe: { statement: "SELECT MIN(seq) AS floor FROM swarm_stream_events" },
});

/**
 * Everything above `cursor`, in order.
 *
 * STRICTLY above, because §6.3 defines a duplicate as "a sequence number at or
 * below the last applied" — serving one at the cursor would hand every
 * subscriber a duplicate on every connect and make the consumer's duplicate
 * rule load-bearing for ordinary operation rather than for a real redelivery.
 */
export async function eventsAbove(cursor: number, limit = 500, h: DbHandle = sql): Promise<ServedStreamEvent[]> {
  const rows = await on(h, readEventsAbove)<
    { seq: string; kind: string; subject_id: string | null; session_id: string | null; payload: Record<string, unknown>; committed_at: Date }
  >`
    SELECT seq, kind, subject_id, session_id, payload, committed_at
      FROM swarm_stream_events
     WHERE seq > ${cursor}
     ORDER BY seq
     LIMIT ${limit}`;
  return rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    subjectId: r.subject_id,
    sessionId: r.session_id,
    payload: r.payload ?? {},
    committedAt: isoOrNull(r.committed_at)!,
  }));
}

/** The lowest sequence still in the log, or null when the log is empty. */
export async function retainedFloor(h: DbHandle = sql): Promise<number | null> {
  const [row] = await on(h, readFloor)<{ floor: string | null }>`SELECT MIN(seq) AS floor FROM swarm_stream_events`;
  return row.floor == null ? null : Number(row.floor);
}

/**
 * §6.3's resync reasons. Every one is a way the API cannot serve from where
 * the subscriber stands, and every one is SAID rather than skipped over:
 *
 *   "If the API cannot serve from the requested cursor — its buffer for this
 *    subscriber overflowed, the cursor is below the retained floor
 *    (`log_truncated`), or the cursor is above the log's head — it sends one
 *    `resync` frame and closes the connection ... The API never silently
 *    skips."
 *
 * `cursor_ahead_of_head` — the subscriber claims to have applied an event this
 * API has not committed. Nothing can be served from there. Answering with an
 * empty stream would be indistinguishable from "you are up to date", which is
 * exactly the silent skip.
 *
 * `log_truncated` — the next event this subscriber needs is below the retained
 * floor, pruned by the manual, receipted `rm_owner` command (`bun run prune`,
 * which keeps at least a 7-day window, D55 (12)), and is gone. Serving from the
 * floor instead would skip the missing ones, silently.
 *
 * `buffer_overflow` — this socket's outbound backlog passed its bound because
 * the subscriber stopped reading (D55 (11)). Dropping frames to make room would
 * be a skip, so the connection says so and closes.
 *
 * `unavailable` — the API could not read the log or the counter (a database
 * error). It cannot say what the subscriber missed, so it cannot claim the
 * subscriber is current; the subscriber rebuilds.
 *
 * A cursor of `floor - 1` is SERVABLE: the next event it needs is the floor
 * itself, and that is still here. A cursor of 0 against an unpruned log is
 * servable for the same reason, and is what a scheduler starting against a
 * fresh database presents. When the whole log has been pruned the floor is the
 * next number the counter will hand out, so only a cursor at the head is
 * servable.
 */
export type ResyncReason = "cursor_ahead_of_head" | "log_truncated" | "buffer_overflow" | "unavailable";

export async function resyncReasonFor(cursor: number, h: DbHandle = sql): Promise<ResyncReason | null> {
  const head = await streamHeadSequence(h);
  if (cursor > head) return "cursor_ahead_of_head";
  const floor = (await retainedFloor(h)) ?? head + 1;
  if (cursor < floor - 1) return "log_truncated";
  return null;
}

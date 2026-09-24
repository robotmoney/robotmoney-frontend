// W4.3 — the submission window and the one-collecting-session constraint
// (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §2.1, §4.2 and §9.
//
//   "The advertised instant is the contract participants are bound to, not the
//    state: a submission after `window_closes_at` is refused even if delayed
//    turnover has not yet moved the session out of `collecting`. Absences
//    (§4.3) are judged against the same instant, so accepted takes and
//    recorded absences can never disagree about who was on time."
//
//   "An active subject has at most one session in `collecting`. The database
//    enforces it with a uniqueness constraint."
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import {
  activeMember,
  activeSubject,
  refusedByDatabase,
  seat,
  sessionDate,
  sessionRow,
  submitTake,
} from "./support/epoch-fixtures.ts";

// Per TEST, not per file: seating members is global (SWARM_ROSTER_CAP is
// enforced on every transition-to-active), so a roster built by one test would
// make the next test's admission a spurious 409.
useCleanDatabasePerTest(import.meta.file);

async function openedEpoch(prefix: string, durationSeconds = 600) {
  const subjectId = await activeSubject(prefix, durationSeconds);
  const r = await epoch.openEpoch(subjectId);
  if (!r.ok) throw new Error(`openEpoch: ${JSON.stringify(r)}`);
  const s = await sessionRow(r.sessionId);
  return { subjectId, sessionId: r.sessionId, date: sessionDate(s) };
}

test("a take just before window_closes_at is accepted", async () => {
  const { subjectId, sessionId, date } = await openedEpoch("win_before");
  const m = await activeMember();
  const r = await submitTake(m, date, subjectId);
  expect(r.ok).toBe(true);
  const rows = await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`;
  expect(rows.length).toBe(1);
});

test("a take after window_closes_at is refused even though the session is still collecting", async () => {
  const { subjectId, sessionId, date } = await openedEpoch("win_after");
  const m = await activeMember();
  // Turnover is DELAYED: the instant has passed, the state has not moved.
  await sql`UPDATE swarm_sessions SET window_closes_at = now() - interval '1 second' WHERE id = ${sessionId}`;
  expect((await sessionRow(sessionId)).state).toBe("collecting");

  const r = await submitTake(m, date, subjectId);
  expect(r.ok).toBe(false);
  expect((r as { status: number }).status).toBe(409);
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);
});

/**
 * Hold the session row `FOR UPDATE` on a second connection — exactly what a
 * turnover closing the epoch holds — start `run` while it is held, and prove
 * `run` is WAITING on the row before letting go. Inside the hold, `during`
 * runs (it can sleep the database clock past an instant), and its last
 * reading of `clock_timestamp()` is returned as the release instant.
 */
async function whileSessionRowHeld<T>(
  sessionId: string,
  run: () => Promise<T>,
  during: (tx: typeof sql) => Promise<void>,
): Promise<{ result: T; sawWaiter: boolean; releasedAt: string }> {
  let pending!: Promise<T>;
  let sawWaiter = false;
  let releasedAt = "";
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`;
    pending = run();
    for (let i = 0; i < 300 && !sawWaiter; i += 1) {
      const [w] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()`;
      sawWaiter = Number(w?.n ?? 0) > 0;
      if (!sawWaiter) await Bun.sleep(10);
    }
    await during(tx as unknown as typeof sql);
    const [{ at }] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
    releasedAt = at;
  });
  return { result: await pending, sawWaiter, releasedAt };
}

test("ONE CLOCK: a take whose transaction began before window_closes_at but reaches the check after it is refused", async () => {
  // §4.2 / §10 "One clock": "a take arriving inside a transaction that
  // started before `window_closes_at` but reaches the check after it is
  // refused." The take's transaction opens and queues behind a turnover-shaped
  // row lock while the window is still open; the lock is held until the
  // DATABASE clock is past the close; then the take reaches its check. Under
  // `now()` — the transaction's start — it would still read as on time.
  const { subjectId, sessionId, date } = await openedEpoch("win_slow_tx");
  const m = await activeMember();
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() + interval '1500 milliseconds'
             WHERE id = ${sessionId}`;

  const { result, sawWaiter } = await whileSessionRowHeld(
    sessionId,
    () => submitTake(m, date, subjectId),
    async (tx) => {
      // The take passed every early check with the window still open, so it
      // is past its signature work and blocked inside its own transaction.
      await tx`SELECT pg_sleep(GREATEST(0, extract(epoch FROM (
                 (SELECT window_closes_at FROM swarm_sessions WHERE id = ${sessionId})
                   + interval '200 milliseconds' - clock_timestamp()))::float8))`;
    },
  );
  expect(sawWaiter, "the take must have been waiting inside its transaction").toBe(true);
  expect(result.ok).toBe(false);
  expect((result as { status: number; error: string })).toMatchObject({ status: 409, error: "submission window closed" });
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("red control for the one-clock case: in the same shape of transaction, now() is still before the close", async () => {
  // What the refusal above is refusing ON. A transaction that started before
  // the close and is checked after it sees `now()` BEFORE the close — a
  // `window_closes_at > now()` guard would accept — and `clock_timestamp()`
  // after it. The take path's guard is the second.
  const { sessionId } = await openedEpoch("win_red_control");
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() + interval '300 milliseconds'
             WHERE id = ${sessionId}`;
  const [row] = await sql.begin(async (tx) => {
    await tx`SELECT 1`;
    await tx`SELECT pg_sleep(0.5)`;
    return tx<{ by_now: boolean; by_clock: boolean }[]>`
      SELECT window_closes_at > now() AS by_now, window_closes_at > clock_timestamp() AS by_clock
        FROM swarm_sessions WHERE id = ${sessionId}`;
  });
  expect(row).toEqual({ by_now: true, by_clock: false });
});

test("received_at is the instant the take was ACCEPTED, read off the database clock, not its transaction's start", async () => {
  // The take INSERT sets `received_at` from the same single reading of
  // `clock_timestamp()` its window check used. A take that waited behind a
  // turnover-shaped lock and was then accepted carries an instant AFTER the
  // lock was released; the column's `now()` default would stamp the
  // transaction's start, before it.
  const { subjectId, sessionId, date } = await openedEpoch("win_received_at");
  const m = await activeMember();
  const { result, sawWaiter, releasedAt } = await whileSessionRowHeld(
    sessionId,
    () => submitTake(m, date, subjectId),
    async (tx) => {
      await tx`SELECT pg_sleep(0.3)`;
    },
  );
  expect(sawWaiter).toBe(true);
  expect(result.ok).toBe(true);
  const [row] = await sql<{ after_release: boolean; before_close: boolean }[]>`
    SELECT r.received_at >= ${releasedAt}::text::timestamptz AS after_release,
           r.received_at < s.window_closes_at AS before_close
      FROM swarm_recommendations r JOIN swarm_sessions s ON s.id = r.session_id
     WHERE r.session_id = ${sessionId}`;
  expect(row).toEqual({ after_release: true, before_close: true });
});

test("a past-close take is refused THROUGHOUT an exhausted turnover, and the next epoch takes it once turnover runs", async () => {
  // §4.6: "A subject whose turnover is exhausted keeps its collecting session
  // past `window_closes_at`; that is harmless, because §4.2 refuses
  // submissions by instant, not by state." §10 "Retry exhaustion": it
  // "refuses submissions after `window_closes_at` throughout". The scheduler's
  // side of exhaustion is system-scheduler-recovery.test.ts; this is the API's
  // side of the same state — collecting, past its close, no turnover.
  const { subjectId, sessionId, date } = await openedEpoch("win_exhausted");
  const m = await activeMember();
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${sessionId}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await submitTake(m, date, subjectId);
    expect(r).toMatchObject({ ok: false, status: 409, error: "submission window closed" });
    expect((await sessionRow(sessionId)).state).toBe("collecting");
    await Bun.sleep(50);
  }
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);

  // The rebuild's one turnover runs; the same member's next take lands on N+1.
  const turned = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);
  if (!turned.ok) return;
  const nextDate = sessionDate(await sessionRow(turned.openedSessionId));
  const accepted = await submitTake(m, nextDate, subjectId);
  expect(accepted.ok).toBe(true);
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${turned.openedSessionId}`).length).toBe(1);
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("a take after DEACTIVATION is refused, though the closed epoch's stored close is still in the future", async () => {
  // §4.2: takes are accepted "while a session is `collecting` and now is
  // before its `window_closes_at`". Deactivation (§4.5) closes the epoch and
  // does not move `window_closes_at`. RED CONTROL: before the INSERT carried
  // `s.state = 'collecting'`, this take returned 201 and one row landed in the
  // closed session, after its absences had been recorded.
  const { subjectId, sessionId, date } = await openedEpoch("win_deactivated");
  const m = await activeMember();
  const [subject] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const deactivated = await admin.deactivateSubjectAdmin(subjectId, Number(subject.version));
  expect(deactivated.ok).toBe(true);
  const [closed] = await sql<{ state: string; still_future: boolean }[]>`
    SELECT state, window_closes_at > clock_timestamp() AS still_future FROM swarm_sessions WHERE id = ${sessionId}`;
  expect(closed).toEqual({ state: "window_closed", still_future: true });

  const r = await submitTake(m, date, subjectId);
  expect(r).toMatchObject({ ok: false, status: 409, error: "submission window closed" });
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("a take that read N before an operator's EARLY turnover committed, and queued behind it, is refused — no row lands in N", async () => {
  // The race the take INSERT's `FOR SHARE` exists for. The turnover is held
  // open AFTER it has closed N and recorded its absences: the test takes the
  // stream-event advisory lock the turnover needs for `epoch.turned_over`.
  // While it waits, the take reads N as the newest session (N+1 is not yet
  // committed), passes every early check — the window is minutes from closing
  // — and blocks on N's row. Then the turnover commits. RED CONTROL: before
  // the INSERT carried `s.state = 'collecting'`, the take was then inserted
  // into N after its absences were recorded, so accepted takes and recorded
  // absences disagreed and the take post-dated aggregation's input.
  const { subjectId, sessionId, date } = await openedEpoch("win_early_turnover");
  const m = await activeMember();
  const waiting = async (locktypes: string[]) => {
    for (let i = 0; i < 500; i += 1) {
      const [w] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = ANY(${locktypes})`;
      if (Number(w?.n ?? 0) > 0) return true;
      await Bun.sleep(10);
    }
    return false;
  };

  let turnover!: ReturnType<typeof epoch.turnOverEpoch>;
  let take!: ReturnType<typeof submitTake>;
  let turnoverWaited = false;
  let takeWaited = false;
  await sql.begin(async (hold) => {
    await hold`SELECT pg_advisory_xact_lock(hashtextextended('swarm_stream_events', 0))`;
    turnover = epoch.turnOverEpoch(subjectId, sessionId);
    turnoverWaited = await waiting(["advisory"]);
    take = submitTake(m, date, subjectId);
    takeWaited = await waiting(["transactionid", "tuple"]);
  });
  const [turned, r] = await Promise.all([turnover, take]);
  expect(turnoverWaited, "the turnover must have closed N and be waiting to publish its event").toBe(true);
  expect(takeWaited, "the take must have been waiting on N's row behind the turnover").toBe(true);
  expect(turned.ok).toBe(true);
  expect(r).toMatchObject({ ok: false, status: 409, error: "submission window closed" });
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("accepted takes and recorded absences never disagree about who was on time", async () => {
  const { subjectId, sessionId, date } = await openedEpoch("win_absence");
  const onTime = await activeMember();
  const silent = await activeMember();
  await seat(sessionId, onTime);
  await seat(sessionId, silent);

  const accepted = await submitTake(onTime, date, subjectId);
  expect(accepted.ok).toBe(true);

  const turned = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);

  const absences = await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_agent_health_events
     WHERE session_id = ${sessionId} AND event_type = 'absent'`;
  expect(absences.map((a) => a.member_id).sort()).toEqual([silent.id]);
});

test("a take stamped after the window is not counted as present when absences are recorded", async () => {
  // The two halves are judged against the SAME instant. A row whose
  // `received_at` is after `window_closes_at` cannot arrive through the API at
  // all (the test above proves that), so it is planted here directly: the
  // assertion is that the absence query reads the instant rather than merely
  // asking whether a row exists.
  const { subjectId, sessionId, date } = await openedEpoch("win_stamp");
  const late = await activeMember();
  await seat(sessionId, late);
  const submitted = await submitTake(late, date, subjectId);
  expect(submitted.ok).toBe(true);
  const closes = (await sessionRow(sessionId)).window_closes_at;
  await sql`UPDATE swarm_recommendations
               SET received_at = ${closes}::timestamptz + interval '1 second'
             WHERE session_id = ${sessionId} AND member_id = ${late.id}`;

  const turned = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);

  const absences = await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_agent_health_events
     WHERE session_id = ${sessionId} AND event_type = 'absent'`;
  expect(absences.map((a) => a.member_id)).toEqual([late.id]);
});

test("the database refuses a second collecting session for one subject", async () => {
  const { subjectId } = await openedEpoch("win_unique");
  await refusedByDatabase(() =>
    sql`INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
        VALUES (${subjectId}, ${subjectId}, 'collecting', now() + interval '1 hour')`);
});

test("the constraint is per subject, so two subjects each keep their own open window", async () => {
  const a = await openedEpoch("win_two_a");
  const b = await openedEpoch("win_two_b");
  const open = await sql<{ subject_id: string }[]>`
    SELECT subject_id FROM swarm_sessions
     WHERE state = 'collecting' AND subject_id IN (${a.subjectId}, ${b.subjectId})`;
  expect(open.map((r) => r.subject_id).sort()).toEqual([a.subjectId, b.subjectId].sort());
});

test("the constraint does not block a closed epoch sitting beside its successor", async () => {
  const { subjectId, sessionId } = await openedEpoch("win_settling");
  const turned = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);
  const states = await sql<{ state: string }[]>`
    SELECT state FROM swarm_sessions WHERE subject_id = ${subjectId} ORDER BY convened_at`;
  expect(states.map((s) => s.state)).toEqual(["window_closed", "collecting"]);
});

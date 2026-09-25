// W4.2 turnover — issue #1026.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §4.3 and §10's "Epoch
// binding" gate.
//
//   "The API, in one transaction and behind the state guard: checks that the
//    named session is the subject's current `collecting` session; closes it
//    ...; opens epoch N+1; and records the turnover."
//
//   "Turnover is bound to the epoch, never to 'whatever is open.' If the named
//    session is no longer the current collecting one — because this call is a
//    retry after a lost response, because a stale timer fired after a
//    turnover this scheduler did not make, or because a second scheduler got
//    there first — the API returns the original turnover's result if it has one, or a
//    reasoned no-op. It never closes the successor."
//
// This is the single most important correctness property on the API side: the
// gate races two schedulers against one epoch, and a retry aimed at N must
// never reach N+1.
//
// D55 (2026-09-25): only `system-scheduler` turns an epoch over. There is no
// operator or admin early turnover, so the "turnover this scheduler did not
// make" below is a second scheduler's, never an operator's. The guarantees are
// the same ones the operator case was tested for.
//
// THE GRID (§2.2, amended 2026-09-24): "Epoch N+1 closes at the first grid
// instant after N's `window_closes_at` — on an unchanged grid, exactly
// `window_closes_at + epoch_duration`. If that instant has already passed, it
// closes at the first grid instant after now instead. Missed slots are
// skipped, never opened." Every grid equality below is compared IN SQL, at
// microsecond precision; a JS Date would round both sides to the millisecond
// and could call an off-grid close "on" it.
import { test, expect, beforeAll } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, collectingSessions, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";
import { inHouseJudge } from "./support/stub-judge.ts";
import { provisionSchedulerToken, schedulerHeaders } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

// Store-issued, like the real credential (smoke spec §3, D52 (1)); there is no
// env token and no insecure mode to fall back on.
let SCHEDULER = "";
beforeAll(async () => {
  SCHEDULER = await provisionSchedulerToken();
});

async function openedEpoch(prefix: string, durationSeconds = 600) {
  const subjectId = await activeSubject(prefix, durationSeconds);
  const r = await epoch.openEpoch(subjectId);
  if (!r.ok) throw new Error(`openEpoch failed: ${JSON.stringify(r)}`);
  return { subjectId, sessionId: r.sessionId };
}

/** k for a session's close on its subject's grid, and whether it is an integer — by Postgres. */
async function onGrid(sessionId: string): Promise<{ k: number; exact: boolean }> {
  const [row] = await sql<{ k: string; exact: boolean }[]>`
    SELECT extract(epoch FROM (s.window_closes_at - t.epoch_anchor)) / t.epoch_duration_seconds AS k,
           mod(extract(epoch FROM (s.window_closes_at - t.epoch_anchor)), t.epoch_duration_seconds) = 0 AS exact
      FROM swarm_sessions s JOIN swarm_subjects t ON t.id = s.subject_id
     WHERE s.id = ${sessionId}`;
  return { k: Number(row.k), exact: row.exact };
}

/**
 * Put N's close on the most recent grid instant at or before the database's
 * now — a boundary that has fired late — or `slots` whole slots before that.
 */
async function closeNOnPastGridInstant(sessionId: string, subjectId: string, slots = 0): Promise<void> {
  await sql`
    UPDATE swarm_sessions s
       SET window_closes_at = t.epoch_anchor + make_interval(secs => (
             (floor(extract(epoch FROM (clock_timestamp() - t.epoch_anchor)) / t.epoch_duration_seconds) - ${slots})
             * t.epoch_duration_seconds)::float8)
      FROM swarm_subjects t
     WHERE s.id = ${sessionId} AND t.id = ${subjectId}`;
}

test("turnover closes N and opens N+1, and N+1 closes EXACTLY one duration after N's close on an unchanged grid", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_basic", 900);
  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.replayed).toBe(false);
  expect(r.closedSessionId).toBe(sessionId);
  expect(r.openedSessionId).not.toBe(sessionId);

  const closed = await sessionRow(sessionId);
  expect(closed.state).toBe("window_closed");
  expect(closed.successor_session_id).toBe(r.openedSessionId);

  const opened = await sessionRow(r.openedSessionId);
  expect(opened.state).toBe("collecting");
  // §2.2: "on an unchanged grid, exactly `window_closes_at + epoch_duration`"
  // — measured from N's CLOSE, not from the instant the turnover ran. Here the
  // turnover commits while N's close is still ahead (a scheduler timer running
  // ahead of the database clock, §4.2), so the new window is LONGER than one
  // duration from its open: the grid, not the turnover instant, sets it.
  const [row] = await sql<{ exact: boolean; longer_than_one: boolean }[]>`
    SELECT n1.window_closes_at = n.window_closes_at + interval '900 seconds' AS exact,
           n1.window_closes_at - n1.convened_at > interval '900 seconds' AS longer_than_one
      FROM swarm_sessions n JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
     WHERE n.id = ${sessionId}`;
  expect(row).toEqual({ exact: true, longer_than_one: true });
  expect((await onGrid(r.openedSessionId)).exact).toBe(true);

  // There is no gap: exactly one collecting session for the subject, always.
  expect((await collectingSessions(subjectId)).length).toBe(1);
});

test("a turnover dispatched LATE still closes N+1 on the grid, one duration after N's close — not now + duration", async () => {
  // N's close is a grid instant in the past (the boundary fired late), but the
  // next one is still ahead: N+1 takes it.
  const { subjectId, sessionId } = await openedEpoch("to_late", 3600);
  await closeNOnPastGridInstant(sessionId, subjectId);
  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [row] = await sql<{ exact: boolean; not_now_plus: boolean }[]>`
    SELECT n1.window_closes_at = n.window_closes_at + interval '3600 seconds' AS exact,
           n1.window_closes_at < clock_timestamp() + interval '3600 seconds' AS not_now_plus
      FROM swarm_sessions n JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
     WHERE n.id = ${sessionId}`;
  expect(row).toEqual({ exact: true, not_now_plus: true });
});

test("NO DRIFT: after ten late turnovers every close equals epoch_anchor + k × epoch_duration exactly", async () => {
  // §10: "a turnover dispatched late still gives N+1 a close on the grid;
  // after ten epochs each close equals `epoch_anchor + k × epoch_duration`
  // exactly."
  //
  // HOW TEN LATE EPOCHS RUN WITHOUT WAITING TEN DURATIONS. Each round turns
  // over an epoch whose close is already 37 s behind the database clock. To
  // reach the next round, the subject — its anchor and every close — is moved
  // back by one duration, which is what one duration of real time passing
  // looks like to every comparison the API makes: they all read the same
  // clock against these stored instants. The grid relation between the
  // closes is untouched by the move, so k is read against the moved anchor.
  const D = 600;
  const { subjectId, sessionId: first } = await openedEpoch("to_nodrift", D);
  await sql`UPDATE swarm_subjects SET epoch_anchor = clock_timestamp() - interval '37 seconds' WHERE id = ${subjectId}`;
  await closeNOnPastGridInstant(first, subjectId);

  const chain: string[] = [first];
  for (let round = 0; round < 10; round += 1) {
    const r = await epoch.turnOverEpoch(subjectId, chain[chain.length - 1]!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);
    chain.push(r.openedSessionId);
    await sql`UPDATE swarm_subjects SET epoch_anchor = epoch_anchor - make_interval(secs => ${D}) WHERE id = ${subjectId}`;
    await sql`UPDATE swarm_sessions SET window_closes_at = window_closes_at - make_interval(secs => ${D})
               WHERE subject_id = ${subjectId}`;
  }

  const ks: number[] = [];
  for (const id of chain) {
    const pos = await onGrid(id);
    expect(pos.exact, `session ${id} closes off the grid`).toBe(true);
    ks.push(pos.k);
  }
  // k advances by EXACTLY one per turnover: no slot skipped (each was late by
  // under one duration), and no drift — a `now + duration` close would sit
  // off the grid by the lateness on every round and fail `exact` above.
  expect(ks.length).toBe(11);
  for (let i = 1; i < ks.length; i += 1) expect(ks[i]! - ks[i - 1]!).toBe(1);
});

test("GRID AFTER DOWNTIME: two missed slots, then ONE turnover lands on the first FUTURE grid instant", async () => {
  // §10: "restart after two missed slots; the one turnover on rebuild gives
  // N+1 the first future grid instant, never a past one and never
  // `now + duration`." N's close is two whole slots before the latest past
  // grid instant, so N.close + D and N.close + 2D both passed while nothing
  // turned it over.
  const D = 120;
  const { subjectId, sessionId } = await openedEpoch("to_downtime", D);
  await closeNOnPastGridInstant(sessionId, subjectId, 2);
  const [{ before }] = await sql<{ before: string }[]>`SELECT clock_timestamp()::text AS before`;

  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [row] = await sql<{ future: boolean; first: boolean; skipped: boolean; on_grid: boolean }[]>`
    SELECT n1.window_closes_at > ${before}::text::timestamptz AS future,
           n1.window_closes_at <= ${before}::text::timestamptz + make_interval(secs => ${D}) AS first,
           n1.window_closes_at = n.window_closes_at + make_interval(secs => ${3 * D}) AS skipped,
           mod(extract(epoch FROM (n1.window_closes_at - t.epoch_anchor)), t.epoch_duration_seconds) = 0 AS on_grid
      FROM swarm_sessions n
      JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
      JOIN swarm_subjects t ON t.id = n.subject_id
     WHERE n.id = ${sessionId}`;
  // Future, on the grid, the FIRST such instant (within one duration of the
  // present), and exactly three slots after N's close — the two missed slots
  // were skipped, not opened.
  expect(row).toEqual({ future: true, first: true, skipped: true, on_grid: true });
  // ONE turnover: two sessions for the subject, not four.
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(2);
});

test("ONE PRESENT, READ AT THE COMPARISON: a turnover that waited past the next grid instant never opens a closed window", async () => {
  // §4.2: "A derived instant, such as the next grid close, is computed once
  // per transaction from a single read of that clock." That one read has to
  // come AFTER the transaction holds the subject: a turnover queued behind
  // another transaction's lock across a grid instant would otherwise derive
  // its successor from a present that went stale while it waited, and open a
  // window whose close had already passed.
  const D = 2;
  const { subjectId, sessionId } = await openedEpoch("to_one_present", D);
  // N's close is the latest past grid instant; G1 = N.close + D is the next.
  await closeNOnPastGridInstant(sessionId, subjectId);

  let pending!: ReturnType<typeof epoch.turnOverEpoch>;
  let sawWaiter = false;
  let releasedAt = "";
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM swarm_subjects WHERE id = ${subjectId} FOR UPDATE`;
    pending = epoch.turnOverEpoch(subjectId, sessionId);
    for (let i = 0; i < 200 && !sawWaiter; i += 1) {
      const [w] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()`;
      sawWaiter = Number(w?.n ?? 0) > 0;
      if (!sawWaiter) await Bun.sleep(10);
    }
    // Hold the lock until G1 has passed by the database clock.
    await tx`
      SELECT pg_sleep(GREATEST(0, extract(epoch FROM (
        (SELECT window_closes_at FROM swarm_sessions WHERE id = ${sessionId})
          + make_interval(secs => ${D}) + interval '200 milliseconds' - clock_timestamp()))::float8))`;
    const [{ at }] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
    releasedAt = at;
  });
  expect(sawWaiter, "the turnover must have queued behind the subject lock").toBe(true);
  const r = await pending;
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [row] = await sql<{ after_release: boolean; second_slot: boolean }[]>`
    SELECT n1.window_closes_at > ${releasedAt}::text::timestamptz AS after_release,
           n1.window_closes_at = n.window_closes_at + make_interval(secs => ${2 * D}) AS second_slot
      FROM swarm_sessions n JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
     WHERE n.id = ${sessionId}`;
  // G1 passed while the turnover waited, so the successor takes the slot after
  // it: a window that is still open when the turnover commits.
  expect(row).toEqual({ after_release: true, second_slot: true });
});

test("a refused turnover closes NOTHING: an inactive subject's collecting epoch stays exactly as it was", async () => {
  // §5: a refusal is a reasoned no-op. The subject-status check used to run
  // AFTER the UPDATE that closed N, and a refusal returned from inside
  // `sql.begin` COMMITS — so "refused" and "closed, absences recorded" were
  // one and the same outcome.
  const { subjectId, sessionId } = await openedEpoch("to_refuse_inactive");
  await sql`UPDATE swarm_subjects SET status = 'inactive' WHERE id = ${subjectId}`;
  const head = await epoch.streamHeadSequence();

  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toBe("subject_not_active");

  const s = await sessionRow(sessionId);
  expect(s.state).toBe("collecting");
  expect(s.judge_mode).toBeNull();
  expect(s.judging_duration_seconds).toBeNull();
  expect(s.successor_session_id).toBeNull();
  expect((await sql`SELECT 1 FROM swarm_agent_health_events WHERE session_id = ${sessionId}`).length).toBe(0);
  expect((await sql`SELECT 1 FROM swarm_stream_events WHERE seq > ${head}`).length).toBe(0);
  expect(await epoch.streamHeadSequence()).toBe(head);
});

test("HTTP: POST epochs/turnover without expectedSessionId is a 400 and changes nothing", async () => {
  // §4.3: turnover is bound to a named epoch. The route refuses a call that
  // names none before it reaches the transition, and nothing moves.
  const { subjectId, sessionId } = await openedEpoch("to_http_unbound");
  const head = await epoch.streamHeadSequence();
  const post = (body: unknown) => {
    const req = new Request("http://x/api/swarm/admin/epochs/turnover", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...schedulerHeaders(SCHEDULER) },
      body: JSON.stringify(body),
    });
    return handleSwarmAdmin(req, new URL(req.url));
  };

  for (const body of [{ subjectId }, { subjectId, expectedSessionId: "" }, { subjectId, expectedSessionId: null }]) {
    const res = await post(body);
    expect(res?.status).toBe(400);
    expect((res!.body as { error: string }).error).toBe("subjectId and expectedSessionId required");
  }
  // Naming an epoch that does not exist is a reasoned refusal, not a 400 —
  // and it closes nothing either.
  const unknown = await post({ subjectId, expectedSessionId: "00000000-0000-4000-8000-000000000000" });
  expect(unknown?.status).toBe(404);
  expect((unknown!.body as { error: string }).error).toBe("expected_session_not_found");

  expect((await sessionRow(sessionId)).state).toBe("collecting");
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(1);
  expect((await sql`SELECT 1 FROM swarm_stream_events WHERE seq > ${head}`).length).toBe(0);
  expect(await epoch.streamHeadSequence()).toBe(head);

  // And the bound call, through the same route, does turn it over.
  const bound = await post({ subjectId, expectedSessionId: sessionId });
  expect(bound?.status).toBe(200);
  expect((await sessionRow(sessionId)).state).toBe("window_closed");
});

test("the successor's brief is published in the same call, so the epoch is usable at once", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_brief");
  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [brief] = await sql`SELECT body FROM swarm_briefs WHERE session_id = ${r.openedSessionId}`;
  expect(brief).toBeDefined();
});

test("dropping a successful turnover's response and retrying replays it, never turning over again", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_retry");
  const first = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const retry = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(retry.ok).toBe(true);
  if (!retry.ok) return;
  expect(retry.replayed).toBe(true);
  expect(retry.closedSessionId).toBe(first.closedSessionId);
  expect(retry.openedSessionId).toBe(first.openedSessionId);

  // N+1 is NEVER closed by a retry aimed at N.
  expect((await sessionRow(first.openedSessionId)).state).toBe("collecting");
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(2);
});

test("a stale timer that fires after a turnover this scheduler did not make is a replay, not a second turnover", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_stale");
  // Another caller turns N over first — a second scheduler (D55: never an
  // operator) — through the same endpoint with the same expected_session_id.
  const other = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(other.ok).toBe(true);
  if (!other.ok) return;
  // This scheduler's own timer, still holding the OLD epoch, fires afterwards.
  const stale = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(stale.ok).toBe(true);
  if (!stale.ok) return;
  expect(stale.openedSessionId).toBe(other.openedSessionId);
  expect((await sessionRow(other.openedSessionId)).state).toBe("collecting");
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(2);
});

test("two schedulers racing the same epoch yield exactly one successor", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_race");
  const [a, b] = await Promise.all([
    epoch.turnOverEpoch(subjectId, sessionId),
    epoch.turnOverEpoch(subjectId, sessionId),
  ]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  expect(a.openedSessionId).toBe(b.openedSessionId);
  // One did the work; the other replayed its result.
  expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(2);
  expect((await collectingSessions(subjectId)).length).toBe(1);
});

test("expected_session_id is mandatory: a turnover that names nothing closes nothing", async () => {
  // §4.3: "Turnover is bound to the epoch, never to 'whatever is open.'" An
  // omitted, empty or malformed id must be refused rather than fall back to the
  // subject's current collecting session — that fallback IS the unbound
  // turnover the spec forbids.
  const { subjectId, sessionId } = await openedEpoch("to_unbound");
  for (const bad of ["", "   ", "not-a-uuid", undefined as unknown as string, null as unknown as string]) {
    const r = await epoch.turnOverEpoch(subjectId, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expected_session_not_found");
  }
  expect((await sessionRow(sessionId)).state).toBe("collecting");
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(1);
});

test("already done and not allowed are DIFFERENT answers, and a caller can tell them apart", async () => {
  // §5: "Where the transition has already happened, the guard returns the
  // original result rather than a bare refusal, so a caller can tell 'already
  // done' from 'not allowed.'" The two cases are asserted separately because a
  // guard that answered both with the same no-op would satisfy neither.
  const done = await openedEpoch("to_already_done");
  const first = await epoch.turnOverEpoch(done.subjectId, done.sessionId);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const again = await epoch.turnOverEpoch(done.subjectId, done.sessionId);
  // ALREADY DONE: ok, replayed, and carrying the ORIGINAL turnover's result.
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.replayed).toBe(true);
  expect(again.closedSessionId).toBe(first.closedSessionId);
  expect(again.openedSessionId).toBe(first.openedSessionId);
  expect(again.windowClosesAt).toBe(first.windowClosesAt);
  expect(again.judgeMode).toBe(first.judgeMode);

  // NOT ALLOWED: a refusal with a reason, and no result to replay.
  const blocked = await openedEpoch("to_not_allowed");
  await sql`UPDATE swarm_sessions SET state = 'window_closed' WHERE id = ${blocked.sessionId}`;
  const refused = await epoch.turnOverEpoch(blocked.subjectId, blocked.sessionId);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error).toBe("epoch_not_collecting");
});

test("naming an epoch that is not this subject's, or does not exist, is a reasoned no-op", async () => {
  const a = await openedEpoch("to_foreign_a");
  const b = await openedEpoch("to_foreign_b");

  const crossed = await epoch.turnOverEpoch(a.subjectId, b.sessionId);
  expect(crossed.ok).toBe(false);
  if (crossed.ok) return;
  expect(crossed.error).toBe("expected_session_not_for_subject");

  const missing = await epoch.turnOverEpoch(a.subjectId, "00000000-0000-4000-8000-000000000000");
  expect(missing.ok).toBe(false);
  if (missing.ok) return;
  expect(missing.error).toBe("expected_session_not_found");

  // Neither subject turned over.
  expect((await sessionRow(a.sessionId)).state).toBe("collecting");
  expect((await sessionRow(b.sessionId)).state).toBe("collecting");
});

test("naming an already-settled epoch that never opened a successor is a reasoned no-op, not a new epoch", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_settled");
  // Deactivation closes the epoch WITHOUT a successor (spec §4.5). A stale
  // boundary timer arriving afterwards must not resurrect the subject.
  await sql`UPDATE swarm_sessions SET state = 'window_closed' WHERE id = ${sessionId}`;
  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toBe("epoch_not_collecting");
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(1);
});

test("the judge mode in force is captured on the closing epoch, and a later change does not reach it", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_mode");
  await setJudgeMode("enforce");

  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.judgeMode).toBe("enforce");
  expect((await sessionRow(sessionId)).judge_mode).toBe("enforce");

  // An admin changing the mode afterwards affects LATER sessions only.
  await setJudgeMode("off");
  expect((await sessionRow(sessionId)).judge_mode).toBe("enforce");
  const second = await epoch.turnOverEpoch(subjectId, r.openedSessionId);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.judgeMode).toBe("off");
});

test("the judging duration in force is captured on the closing epoch, and a later change does not reach it", async () => {
  // §4.4: "Judge mode and judging duration are captured at turnover … An admin
  // changing either afterwards affects later sessions, never one already
  // settling." The capture is the SESSION column (migration 0074), never a
  // live read of the subject.
  const { subjectId, sessionId } = await openedEpoch("to_judging_duration");
  await sql`UPDATE swarm_subjects SET judging_duration_seconds = 240 WHERE id = ${subjectId}`;
  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect((await sessionRow(sessionId)).judging_duration_seconds).toBe(240);
  // Still collecting: nothing is captured on the successor until IT closes.
  expect((await sessionRow(r.openedSessionId)).judging_duration_seconds).toBeNull();

  await sql`UPDATE swarm_subjects SET judging_duration_seconds = 60 WHERE id = ${subjectId}`;
  expect((await sessionRow(sessionId)).judging_duration_seconds).toBe(240);
  const second = await epoch.turnOverEpoch(subjectId, r.openedSessionId);
  expect(second.ok).toBe(true);
  expect((await sessionRow(r.openedSessionId)).judging_duration_seconds).toBe(60);
});

// ─────────────────────────────────────────────────────────────────────────────
// §9, criterion 92 — the event and its number commit WITH the transition
// ─────────────────────────────────────────────────────────────────────────────
//
// "Each event row and its global sequence are written in the same transaction
// as the transition, proved by aborting a transition and finding no event."
//
// THE FAILURE FIRES AFTER THE APPEND, AT COMMIT. A failure planted anywhere
// before `appendStreamEvent` proves nothing about the event: it was never
// written, whatever transaction it would have been in. So the abort here is a
// DEFERRABLE INITIALLY DEFERRED constraint trigger on `swarm_stream_events`
// itself. It fires only once the event row EXISTS, and only when the
// transaction that wrote it tries to COMMIT. If the event were written in a
// transaction of its own, that transaction would commit it (and fail on its
// own), and the transition's state change would stand; if it were written
// after the transition committed, the state change would stand. Only "one
// transaction" leaves both the event and the state change gone, with the
// counter where it was. The trigger lives in this file's own database
// (useCleanDatabase) and is dropped in `finally`.

/** Run `transition` with every event insert refused at COMMIT; return the error it raised. */
async function abortedAtCommit(transition: () => Promise<unknown>): Promise<string | null> {
  await sql.unsafe(`
    CREATE FUNCTION rm_test_refuse_at_commit() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN RAISE EXCEPTION 'planted commit-time failure after event %', NEW.seq; END $t$;
    CREATE CONSTRAINT TRIGGER rm_test_refuse_at_commit AFTER INSERT ON swarm_stream_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rm_test_refuse_at_commit();`);
  try {
    await transition();
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await sql.unsafe(`DROP TRIGGER rm_test_refuse_at_commit ON swarm_stream_events;
                      DROP FUNCTION rm_test_refuse_at_commit();`);
  }
}

const eventCount = async (): Promise<number> =>
  Number(((await sql`SELECT count(*)::int AS n FROM swarm_stream_events`) as unknown as { n: number }[])[0]!.n);

test("a turnover aborted at COMMIT, after its event was written, leaves no event, no number and no turnover", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_abort_commit");
  const head = await epoch.streamHeadSequence();
  const events = await eventCount();

  const error = await abortedAtCommit(() => epoch.turnOverEpoch(subjectId, sessionId));
  // The planted trigger names the number the event was given: the append DID
  // happen, inside the transaction that then failed.
  expect(error).toBe(`planted commit-time failure after event ${head + 1}`);

  expect(await epoch.streamHeadSequence()).toBe(head);
  expect(await eventCount()).toBe(events);
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("collecting");
  expect(s.successor_session_id).toBeNull();
  expect((await collectingSessions(subjectId)).length).toBe(1);

  // The same call with nothing planted succeeds and takes the SAME number: the
  // aborted attempt left no hole.
  const r = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(r.ok).toBe(true);
  expect(await epoch.streamHeadSequence()).toBe(head + 1);
});

test("a subject.changed edit (deactivation) aborted at COMMIT leaves the subject active and its epoch open", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_abort_deactivate");
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const head = await epoch.streamHeadSequence();

  const error = await abortedAtCommit(() => admin.deactivateSubjectAdmin(subjectId, version));
  expect(error).toBe(`planted commit-time failure after event ${head + 1}`);

  expect(await epoch.streamHeadSequence()).toBe(head);
  const [subject] = await sql<{ status: string; version: number }[]>`
    SELECT status, version FROM swarm_subjects WHERE id = ${subjectId}`;
  expect(subject).toEqual({ status: "active", version });
  expect((await sessionRow(sessionId)).state).toBe("collecting");
});

test("a subject.changed edit (activation) aborted at COMMIT leaves the subject inactive", async () => {
  const { subjectId } = await openedEpoch("to_abort_activate");
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  expect((await admin.deactivateSubjectAdmin(subjectId, version)).status).toBe(200);
  const head = await epoch.streamHeadSequence();

  const error = await abortedAtCommit(() => admin.activateSubjectAdmin(subjectId, version + 1));
  expect(error).toBe(`planted commit-time failure after event ${head + 1}`);

  expect(await epoch.streamHeadSequence()).toBe(head);
  const [{ status }] = await sql<{ status: string }[]>`SELECT status FROM swarm_subjects WHERE id = ${subjectId}`;
  expect(status).toBe("inactive");
});

test("a consensus aborted at COMMIT publishes no session.judged and leaves the session judging", async () => {
  await setJudgeMode("enforce");
  const { subjectId, sessionId: open } = await openedEpoch("to_abort_judged");
  const turned = await epoch.turnOverEpoch(subjectId, open);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  const sessionId = turned.closedSessionId;
  await epoch.aggregateEpoch(sessionId);
  const requested = await epoch.requestJudging(sessionId);
  if (!requested.ok) throw new Error("requestJudging failed");
  const judge = await inHouseJudge();
  const [j] = await sql<{ id: string }[]>`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion,
       judged_by, judged_by_member_id)
    VALUES (${sessionId}, 'enforce', 'model', 'test/epoch-fixture-judge', 'ph', 'id', 1, 1, '{"verdict":"ok"}'::jsonb,
            ${judge.id}, ${judge.id})
    RETURNING id`;
  const head = await epoch.streamHeadSequence();

  const error = await abortedAtCommit(() => epoch.recordJudgingConsensus(sessionId, Number(j.id)));
  expect(error).toBe(`planted commit-time failure after event ${head + 1}`);

  expect(await epoch.streamHeadSequence()).toBe(head);
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("judging");
  expect(s.consensus_recorded_at).toBeNull();
  await setJudgeMode("off");
});

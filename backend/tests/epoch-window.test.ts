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

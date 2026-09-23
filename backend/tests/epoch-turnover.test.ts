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
//    retry after a lost response, because a stale timer fired after an
//    operator's early turnover, or because a second scheduler got there first
//    — the API returns the original turnover's result if it has one, or a
//    reasoned no-op. It never closes the successor."
//
// This is the single most important correctness property on the API side: the
// gate races two schedulers against one epoch, and a retry aimed at N must
// never reach N+1.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/epoch.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, collectingSessions, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

async function openedEpoch(prefix: string, durationSeconds = 600) {
  const subjectId = await activeSubject(prefix, durationSeconds);
  const r = await epoch.openEpoch(subjectId);
  if (!r.ok) throw new Error(`openEpoch failed: ${JSON.stringify(r)}`);
  return { subjectId, sessionId: r.sessionId };
}

test("turnover closes N and opens N+1, and the new window is the open instant plus the duration", async () => {
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
  expect(new Date(opened.window_closes_at).getTime() - new Date(opened.convened_at).getTime()).toBe(900 * 1000);

  // There is no gap: exactly one collecting session for the subject, always.
  expect((await collectingSessions(subjectId)).length).toBe(1);
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

test("a stale timer that fires after an operator's early turnover is a replay, not a second turnover", async () => {
  const { subjectId, sessionId } = await openedEpoch("to_stale");
  // The operator ends the window early through the same endpoint.
  const operator = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(operator.ok).toBe(true);
  if (!operator.ok) return;
  // The scheduler's own timer, still holding the OLD epoch, fires afterwards.
  const stale = await epoch.turnOverEpoch(subjectId, sessionId);
  expect(stale.ok).toBe(true);
  if (!stale.ok) return;
  expect(stale.openedSessionId).toBe(operator.openedSessionId);
  expect((await sessionRow(operator.openedSessionId)).state).toBe("collecting");
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

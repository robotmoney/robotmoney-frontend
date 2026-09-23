// W4.2 open + W4.2 deactivate (API side) — issue #1026.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §4.1 and §4.5.
//
//   "Opening an epoch is one API call that does three things atomically:
//    create the session, publish its brief, and set `window_closes_at = now +
//    epoch duration`. The session is `collecting` from its first instant.
//    There is no `scheduled` state and no 'brief opens later.' The uniqueness
//    constraint in §2.1 makes two concurrent first-openings for one subject
//    yield one session; the second call returns it."
//
//   "Deactivating a subject through the admin API closes its open epoch
//    (recording absences as in §4.3) and opens no new one."
//
// NOT ASSERTED HERE. "Activating a subject ... opens an epoch with no operator
// action" is the SCHEDULER's rebuild (spec §3), whose test file is
// scripts/tests/unit/system-scheduler-rebuild.test.ts and whose container is
// W4.6 — a later worker. This file proves only what that worker will call.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as epoch from "../src/swarm/epoch.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, collectingSessions, sessionRow } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

test("opening an epoch creates the session, publishes its brief and sets the window in one transaction", async () => {
  const subjectId = await activeSubject("open_one", 1800);
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;

  const s = await sessionRow(r.sessionId);
  // `collecting` from its FIRST instant — never `scheduled`.
  expect(s.state).toBe("collecting");
  expect(s.window_closes_at).not.toBeNull();

  // window_closes_at = the open instant + the subject's duration, exactly.
  const opened = new Date(s.convened_at).getTime();
  const closes = new Date(s.window_closes_at).getTime();
  expect(closes - opened).toBe(1800 * 1000);

  // The brief is published in the same call: both the current-view row and the
  // immutable revision exist, and the brief advertises the same instant.
  const [brief] = await sql`SELECT body FROM swarm_briefs WHERE session_id = ${r.sessionId}`;
  expect(brief).toBeDefined();
  expect(new Date((brief as any).body.windowClosesAt).getTime()).toBe(closes);
  const revisions = await sql`SELECT revision FROM swarm_brief_revisions WHERE session_id = ${r.sessionId}`;
  expect(revisions.length).toBe(1);
});

test("a session is never left behind without its brief when the open fails", async () => {
  // The atomicity claim, proved by a failure rather than by reading the code:
  // a subject that does not exist must leave no session row at all.
  const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm_sessions`;
  const r = await epoch.openEpoch("no_such_subject_at_all");
  expect(r.ok).toBe(false);
  const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm_sessions`;
  expect(after[0].n).toBe(before[0].n);
});

test("two concurrent first-openings for one subject yield one collecting session", async () => {
  const subjectId = await activeSubject("open_race", 600);
  const [a, b] = await Promise.all([epoch.openEpoch(subjectId), epoch.openEpoch(subjectId)]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  // The second call RETURNS the first's session rather than failing.
  expect(a.sessionId).toBe(b.sessionId);
  expect((await collectingSessions(subjectId)).length).toBe(1);
  // Exactly one of them created it.
  expect([a.created, b.created].filter(Boolean).length).toBe(1);
});

test("the database, not the code, enforces at most one collecting session per subject", async () => {
  const subjectId = await activeSubject("open_constraint", 600);
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(true);
  await expect(
    sql`INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
        VALUES (${subjectId}, ${subjectId}, 'collecting', now() + interval '1 hour')`,
  ).rejects.toThrow();
});

test("an inactive subject cannot have an epoch opened", async () => {
  const subjectId = await activeSubject("open_inactive", 600);
  await sql`UPDATE swarm_subjects SET status = 'inactive' WHERE id = ${subjectId}`;
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toBe("subject_not_active");
  expect((await collectingSessions(subjectId)).length).toBe(0);
});

test("deactivating a subject closes its open epoch and opens no successor", async () => {
  const subjectId = await activeSubject("open_deactivate", 600);
  const opened = await epoch.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;

  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const r = await admin.deactivateSubjectAdmin(subjectId, version);
  expect(r.status).toBe(200);

  const closed = await sessionRow(opened.sessionId);
  expect(closed.state).toBe("window_closed");
  // No successor: the closed epoch settles, nothing new opens.
  expect(closed.successor_session_id).toBeNull();
  expect((await collectingSessions(subjectId)).length).toBe(0);
  const all = await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`;
  expect(all.length).toBe(1);
});

test("deactivating a subject with no open epoch is an ordinary deactivation", async () => {
  const subjectId = await activeSubject("open_deactivate_idle", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const r = await admin.deactivateSubjectAdmin(subjectId, version);
  expect(r.status).toBe(200);
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(0);
});

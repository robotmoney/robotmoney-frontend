// W4.2 open + W4.2 deactivate (API side) — issue #1026.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §2.2, §4.1 and §4.5, as
// amended 2026-09-24 (§13, D52).
//
//   §4.1: "Opening an epoch is one API call that does three things atomically:
//    create the session, publish its brief, and set `window_closes_at` to the
//    first grid instant after now (§2.2). The session is `collecting` from its
//    first instant. There is no `scheduled` state and no 'brief opens later.'
//    The uniqueness constraint in §2.1 makes two concurrent first-openings for
//    one subject yield one session; the second call returns it."
//
//   §2.2 (first epoch): "An epoch opened with no predecessor … closes at the
//    first grid instant at least half of `epoch_duration` after now; if the
//    next instant is nearer than that, it closes at the one after."
//
//   "Deactivating a subject through the admin API closes its open epoch
//    (recording absences as in §4.3) and opens no new one."
//
// HOW THE GRID IS CONTROLLED. The anchor is a column on the subject, so a test
// puts a grid instant exactly where it needs one — "one second from now" — by
// writing `epoch_anchor` relative to the DATABASE clock, the clock the API
// reads. Every equality below is compared IN SQL at microsecond precision,
// never through a JS Date, because "exactly on the grid" is a claim about
// microseconds.
//
// NOT ASSERTED HERE. "Activating a subject ... opens an epoch with no operator
// action" is the SCHEDULER's rebuild (spec §3); its runtime proof is
// scripts/tests/integration/scheduler-api-runtime.test.ts. This file proves
// only what that scheduler calls.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as epoch from "../src/swarm/domain.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, collectingSessions, refusedByDatabase, rid, sessionRow } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

/** Where the session's close sits on its subject's grid, computed by Postgres. */
async function gridPosition(sessionId: string) {
  const [row] = await sql<{ k: string; on_grid: boolean; ahead_of_open: string; brief_matches: boolean }[]>`
    SELECT extract(epoch FROM (s.window_closes_at - t.epoch_anchor)) / t.epoch_duration_seconds AS k,
           mod(extract(epoch FROM (s.window_closes_at - t.epoch_anchor)), t.epoch_duration_seconds) = 0 AS on_grid,
           extract(epoch FROM (s.window_closes_at - s.convened_at)) AS ahead_of_open,
           date_trunc('milliseconds', s.window_closes_at)
             = ((b.body->>'windowClosesAt')::timestamptz) AS brief_matches
      FROM swarm_sessions s
      JOIN swarm_subjects t ON t.id = s.subject_id
      LEFT JOIN swarm_briefs b ON b.session_id = s.id
     WHERE s.id = ${sessionId}`;
  return { k: Number(row.k), onGrid: row.on_grid, aheadOfOpen: Number(row.ahead_of_open), briefMatches: row.brief_matches };
}

test("opening an epoch creates the session, publishes its brief and sets a GRID close in one transaction", async () => {
  const subjectId = await activeSubject("open_one", 1800);
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;

  const s = await sessionRow(r.sessionId);
  // `collecting` from its FIRST instant — never `scheduled`.
  expect(s.state).toBe("collecting");
  expect(s.window_closes_at).not.toBeNull();

  // On the subject's grid: the close is anchor + k × duration for an integer k
  // (the schema's default anchor, 1970-01-01, puts a 30-minute grid on the
  // half hour). NOT `now + duration`, which is on the grid only by accident.
  const pos = await gridPosition(r.sessionId);
  expect(pos.onGrid).toBe(true);
  expect(Number.isInteger(pos.k)).toBe(true);
  // The first-epoch floor: between half a duration and one and a half after
  // the open instant, never a sliver.
  expect(pos.aheadOfOpen).toBeGreaterThanOrEqual(900);
  expect(pos.aheadOfOpen).toBeLessThan(2701); // 1.5 durations, plus the open transaction's own few ms

  // The brief is published in the same call: both the current-view row and the
  // immutable revision exist, and the brief advertises the same instant.
  expect(pos.briefMatches).toBe(true);
  expect(new Date(r.windowClosesAt).getTime()).toBe(new Date(s.window_closes_at).getTime());
  const revisions = await sql`SELECT revision FROM swarm_brief_revisions WHERE session_id = ${r.sessionId}`;
  expect(revisions.length).toBe(1);
});

test("FIRST-EPOCH FLOOR: opened one second before a grid instant, the window runs to the FOLLOWING instant", async () => {
  // §10: "activate a subject one second before a grid instant; its first
  // window closes at the following instant instead, is at least half a
  // duration long, and no session is published with every member absent
  // because nobody could submit in time."
  const subjectId = await activeSubject("open_floor", 600);
  await sql`UPDATE swarm_subjects SET epoch_anchor = clock_timestamp() + interval '1 second' WHERE id = ${subjectId}`;
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [row] = await sql<{ at_following: boolean; length: string }[]>`
    SELECT s.window_closes_at = t.epoch_anchor + interval '600 seconds' AS at_following,
           extract(epoch FROM (s.window_closes_at - s.convened_at)) AS length
      FROM swarm_sessions s JOIN swarm_subjects t ON t.id = s.subject_id
     WHERE s.id = ${r.sessionId}`;
  // Not the instant one second away (a one-second window nobody can submit
  // into), but the one after it.
  expect(row.at_following).toBe(true);
  expect(Number(row.length)).toBeGreaterThanOrEqual(300);
});

test("FIRST-EPOCH FLOOR: a grid instant more than half a duration away is the close itself", async () => {
  // The other side of "at least half": 400s away on a 600s grid is far
  // enough, so the window closes AT it rather than being pushed a slot on.
  const subjectId = await activeSubject("open_floor_far", 600);
  await sql`UPDATE swarm_subjects SET epoch_anchor = clock_timestamp() + interval '400 seconds' WHERE id = ${subjectId}`;
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [row] = await sql<{ at_anchor: boolean }[]>`
    SELECT s.window_closes_at = t.epoch_anchor AS at_anchor
      FROM swarm_sessions s JOIN swarm_subjects t ON t.id = s.subject_id
     WHERE s.id = ${r.sessionId}`;
  expect(row.at_anchor).toBe(true);
});

test("a first epoch is never opened into the past, whatever the anchor", async () => {
  // An anchor years back and one years ahead both yield a FUTURE close on the
  // grid: the rule measures from the present the transaction read, and the
  // anchor only fixes the phase.
  for (const [prefix, anchor] of [["open_past_anchor", "2001-01-01T00:00:07Z"], ["open_future_anchor", "2031-06-01T12:00:03Z"]]) {
    const subjectId = await activeSubject(prefix, 3600);
    await sql`UPDATE swarm_subjects SET epoch_anchor = ${anchor}::timestamptz WHERE id = ${subjectId}`;
    const r = await epoch.openEpoch(subjectId);
    expect(r.ok).toBe(true);
    if (!r.ok) continue;
    const [row] = await sql<{ future: boolean; on_grid: boolean }[]>`
      SELECT s.window_closes_at > clock_timestamp() + interval '1799 seconds' AS future,
             mod(extract(epoch FROM (s.window_closes_at - t.epoch_anchor)), 3600) = 0 AS on_grid
        FROM swarm_sessions s JOIN swarm_subjects t ON t.id = s.subject_id
       WHERE s.id = ${r.sessionId}`;
    expect(row).toEqual({ future: true, on_grid: true });
  }
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
  expect(a.windowClosesAt).toBe(b.windowClosesAt);
  expect((await collectingSessions(subjectId)).length).toBe(1);
  // Exactly one of them created it.
  expect([a.created, b.created].filter(Boolean).length).toBe(1);
});

test("the database, not the code, enforces at most one collecting session per subject", async () => {
  const subjectId = await activeSubject("open_constraint", 600);
  const r = await epoch.openEpoch(subjectId);
  expect(r.ok).toBe(true);
  await refusedByDatabase(() =>
    sql`INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
        VALUES (${subjectId}, ${subjectId}, 'collecting', now() + interval '1 hour')`);
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

test("creating a subject through the admin route opens NO session: the scheduler opens its first epoch", async () => {
  // §3: "Nothing else opens a first epoch." Creation publishes
  // `subject.changed` and stops there; there is no `scheduled` row waiting,
  // and no epoch until `openEpoch` is called.
  const id = rid("open_created");
  const created = await admin.createSubjectAdmin({ id, name: "created subject", epochDuration: 600 });
  expect(created.status).toBe(201);
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${id}`).length).toBe(0);

  const r = await epoch.openEpoch(id);
  expect(r.ok).toBe(true);
  const rows = await sql<{ state: string }[]>`SELECT state FROM swarm_sessions WHERE subject_id = ${id}`;
  expect(rows.map((x) => x.state)).toEqual(["collecting"]);
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
  // And it settles like any other epoch: the mode and judging duration in
  // force as it closed are captured on it (§4.4, §4.5).
  expect(closed.judge_mode).not.toBeNull();
  expect(closed.judging_duration_seconds).toBe(900);
  expect((await collectingSessions(subjectId)).length).toBe(0);
  const all = await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`;
  expect(all.length).toBe(1);
});

test("re-activating a subject opens NO session until the scheduler acts, and the scheduler's open is a fresh on-grid epoch", async () => {
  // §2.4: "Activating a subject opens its first epoch (§3)" — and §3 says who:
  // "An active subject with no session in `collecting` is opened immediately
  // as part of the rebuild — ... a subject deactivated and re-activated.
  // Nothing else opens a first epoch." D55 (4): activation is a subject edit
  // through the admin API, never an epoch route.
  const subjectId = await activeSubject("open_reactivate", 600);
  const first = await epoch.openEpoch(subjectId);
  if (!first.ok) throw new Error("openEpoch failed");
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  expect((await admin.deactivateSubjectAdmin(subjectId, version)).status).toBe(200);
  const before = (await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length;

  const activated = await admin.activateSubjectAdmin(subjectId, version + 1);
  expect(activated.status).toBe(200);
  expect((activated as any).subject.status).toBe("active");
  expect((activated as any).subject.version).toBe(version + 2);
  // Zero new sessions: the flip published an event and stopped there.
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(before);
  expect((await collectingSessions(subjectId)).length).toBe(0);

  // The scheduler's act — `openEpoch`, what it calls on `subject.changed` —
  // opens exactly one, closing on the subject's grid.
  const reopened = await epoch.openEpoch(subjectId);
  expect(reopened.ok).toBe(true);
  if (!reopened.ok) return;
  expect(reopened.sessionId).not.toBe(first.sessionId);
  expect((await collectingSessions(subjectId)).length).toBe(1);
  const [grid] = await sql<{ exact: boolean }[]>`
    SELECT (extract(epoch FROM (s.window_closes_at - t.epoch_anchor)) / t.epoch_duration_seconds)
             = floor(extract(epoch FROM (s.window_closes_at - t.epoch_anchor)) / t.epoch_duration_seconds) AS exact
      FROM swarm_sessions s JOIN swarm_subjects t ON t.id = s.subject_id
     WHERE s.id = ${reopened.sessionId}`;
  expect(grid.exact).toBe(true);
});

test("activation is refused for an active subject, a stale version and an unknown subject — and opens nothing", async () => {
  const subjectId = await activeSubject("open_activate_refused", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const already = await admin.activateSubjectAdmin(subjectId, version);
  expect({ status: already.status, error: already.error }).toEqual({ status: 409, error: "already_active" });
  expect((await admin.deactivateSubjectAdmin(subjectId, version)).status).toBe(200);
  const stale = await admin.activateSubjectAdmin(subjectId, version);
  expect({ status: stale.status, error: stale.error }).toEqual({ status: 409, error: "stale_version" });
  expect((await admin.activateSubjectAdmin(rid("open_activate_missing"), 1)).status).toBe(404);
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(0);
});

test("deactivating a subject with no open epoch is an ordinary deactivation", async () => {
  const subjectId = await activeSubject("open_deactivate_idle", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const r = await admin.deactivateSubjectAdmin(subjectId, version);
  expect(r.status).toBe(200);
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(0);
});

// ── nextSessionAt (criterion 108) ───────────────────────────────────────────
//
// `nextSessionAt` is a published field outside agents read (contract
// swarm.d.ts, scripts/lib/agent-endpoints.ts). It used to be the next fire of
// a `job_schedules` row; under the epoch model it is the earliest open
// window's close, because turnover opens N+1 in the transaction that closes N.
// The shape — an ISO instant or null, never omitted — does not change.

test("GET /api/swarm/sessions answers nextSessionAt from the EPOCH, never from job_schedules.next_run_at", async () => {
  // Isolate the swarm's earliest window to this one epoch.
  await sql`UPDATE swarm_sessions SET state = 'window_closed' WHERE state = 'collecting'`;
  const subjectId = await activeSubject("open_next_at", 3600);
  const opened = await epoch.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;

  // Conflicting schedule rows, EARLIER than the epoch's close: every enabled
  // `job_schedules` row is made to say "next run in five minutes", the shape
  // the retired cron scheduler's session-opening row had. (Its own kind is
  // gone from the system — migration 0072 deleted it and
  // no-swarm-cron.test.ts keeps the name out of the tree — so the conflict is
  // planted on the rows that remain.) If the field still read the table, this
  // is what the answer would be.
  const stale = new Date(Date.now() + 5 * 60_000);
  const planted = await sql`UPDATE job_schedules SET enabled = true, next_run_at = ${stale} RETURNING id`;
  expect(planted.length).toBeGreaterThan(0);

  for (const url of ["http://test/api/swarm/sessions", "http://test/api/swarm/sessions?full=1"]) {
    const req = new Request(url);
    const res = await handleSwarm(req, new URL(req.url));
    expect((res as { status: number }).status).toBe(200);
    const body = (res as { body: { nextSessionAt: string | null } }).body;
    expect("nextSessionAt" in body).toBe(true);
    // The published shape: an ISO-8601 instant string.
    expect(typeof body.nextSessionAt).toBe("string");
    expect(body.nextSessionAt).toBe(opened.windowClosesAt);
    expect(body.nextSessionAt).not.toBe(stale.toISOString());
  }
});

test("nextSessionAt is NULL — present, never omitted — when no window is open, whatever job_schedules says", async () => {
  // The null branch of getNextSwarmSession (domain.ts): "no known next
  // session", the honest answer while no subject has an open window — here,
  // because the only open epoch's subject was deactivated (§4.5), which closes
  // the epoch and opens no successor.
  await sql`UPDATE swarm_sessions SET state = 'window_closed' WHERE state = 'collecting'`;
  const subjectId = await activeSubject("open_next_null", 3600);
  const opened = await epoch.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  // RED CONTROL: with the window open, the field names its close.
  expect(await epoch.getNextSwarmSessionAt()).toBe(opened.windowClosesAt);

  const [subject] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const deactivated = await admin.deactivateSubjectAdmin(subjectId, Number(subject!.version));
  expect(deactivated.ok).toBe(true);
  expect(await collectingSessions(subjectId)).toEqual([]);

  // Schedule rows that WOULD answer if the field still read them.
  const planted = await sql`UPDATE job_schedules SET enabled = true, next_run_at = ${new Date(Date.now() + 5 * 60_000)} RETURNING id`;
  expect(planted.length).toBeGreaterThan(0);

  expect(await epoch.getNextSwarmSessionAt()).toBeNull();
  expect(await epoch.getNextSwarmSession()).toBeNull();
  for (const url of ["http://test/api/swarm/sessions", "http://test/api/swarm/sessions?full=1"]) {
    const req = new Request(url);
    const res = await handleSwarm(req, new URL(req.url));
    expect((res as { status: number }).status).toBe(200);
    const body = (res as { body: { nextSessionAt: string | null } }).body;
    expect("nextSessionAt" in body).toBe(true);
    expect(body.nextSessionAt).toBeNull();
  }
});

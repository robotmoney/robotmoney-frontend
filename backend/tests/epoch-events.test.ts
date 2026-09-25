// The scheduler event log, written transactionally by the transitions
// (issue #1026 W4, spec §6.2 and §9).
//
// AUTHORITY, verbatim:
//
//   §9: "Every change to what the clock waits on is an event on the stream,
//    sequenced in the transaction that made the change."
//
//   §6.3: "Sequence numbers are monotonic across the API's event log, not per
//    connection." and "A gap — a sequence number that is not the last applied
//    plus one — means the copy is no longer provably current."
//
// TWO ASSERTIONS PER TRANSITION, because one of them alone proves nothing.
// Committing a transition and finding its event proves the event is written;
// ABORTING one and finding no event proves it is written in the transition's
// own transaction rather than beside it. Only the pair rules out the shape
// where a crash between commit and publish silently loses an event.
//
// NOT ASSERTED HERE. Serving the log — the cursor handed back with a full read,
// the subscription, the keepalive carrying the head sequence, the resync
// notice, unacked job pushes — is W4.4's, and nothing in this file depends on
// it.
import { test, expect, beforeAll } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, rid, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";
import { inHouseJudge } from "./support/stub-judge.ts";
import { provisionOperatorToken } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

// Store-issued, like the real credential (smoke spec §3, D52 (1)); there is no
// env token and no insecure mode to fall back on.
let OPERATOR = "";
beforeAll(async () => {
  OPERATOR = await provisionOperatorToken();
});

interface EventRow {
  seq: string;
  kind: string;
  subject_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
}

const eventsAbove = (seq: number) =>
  sql<EventRow[]>`SELECT seq, kind, subject_id, session_id, payload FROM swarm_stream_events
                   WHERE seq > ${seq} ORDER BY seq`;

test("the sequence is global, gapless and ascending across every kind of change", async () => {
  const head = await epoch.streamHeadSequence();
  const subjectId = await activeSubject("ev_seq", 600);
  const opened = await epoch.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  await epoch.turnOverEpoch(subjectId, opened.sessionId);

  const rows = await eventsAbove(head);
  expect(rows.length).toBeGreaterThan(0);
  // Every number is the previous one plus exactly one — the property §6.3
  // defines a gap against. A sequence-backed column would not guarantee it.
  rows.forEach((row, i) => expect(Number(row.seq)).toBe(head + i + 1));
});

test("turnover publishes epoch.turned_over naming both epochs, above the prior head", async () => {
  const subjectId = await activeSubject("ev_turnover", 900);
  const opened = await epoch.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;

  const head = await epoch.streamHeadSequence();
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  expect(turned.ok).toBe(true);
  if (!turned.ok) return;

  const rows = await eventsAbove(head);
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("epoch.turned_over");
  expect(Number(rows[0].seq)).toBeGreaterThan(head);
  expect(rows[0].subject_id).toBe(subjectId);
  expect(rows[0].payload.closedSessionId).toBe(opened.sessionId);
  expect(rows[0].payload.openedSessionId).toBe(turned.openedSessionId);
});

test("a replayed turnover publishes nothing — the event belongs to the turnover, not to the call", async () => {
  const subjectId = await activeSubject("ev_replay", 900);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  await epoch.turnOverEpoch(subjectId, opened.sessionId);

  const head = await epoch.streamHeadSequence();
  const replay = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  expect(replay.ok).toBe(true);
  if (!replay.ok) return;
  expect(replay.replayed).toBe(true);
  expect((await eventsAbove(head)).length).toBe(0);
});

test("a transition whose transaction aborts leaves no event and no state change", async () => {
  const subjectId = await activeSubject("ev_abort", 900);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const head = await epoch.streamHeadSequence();

  // Make the successor's brief insert fail, so the turnover transaction rolls
  // back AFTER it has closed the epoch and written its event. A real abort of a
  // real transition, not a hand-rolled transaction that imitates one.
  await sql.unsafe(`
    CREATE FUNCTION rm_test_refuse_brief() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN RAISE EXCEPTION 'planted failure'; END $t$;
    CREATE TRIGGER rm_test_refuse_brief BEFORE INSERT ON swarm_briefs
      FOR EACH ROW EXECUTE FUNCTION rm_test_refuse_brief();`);
  try {
    let threw = false;
    try {
      await epoch.turnOverEpoch(subjectId, opened.sessionId);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  } finally {
    await sql.unsafe(`DROP TRIGGER rm_test_refuse_brief ON swarm_briefs; DROP FUNCTION rm_test_refuse_brief();`);
  }

  // Nothing happened: no event, and the epoch is still collecting.
  expect((await eventsAbove(head)).length).toBe(0);
  expect(await epoch.streamHeadSequence()).toBe(head);
  const s = await sessionRow(opened.sessionId);
  expect(s.state).toBe("collecting");
  expect(s.successor_session_id).toBeNull();
});

test("recording a consensus publishes session.judged; late evidence after publication publishes nothing", async () => {
  await setJudgeMode("enforce");
  const subjectId = await activeSubject("ev_judged", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  const sessionId = turned.closedSessionId;
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);

  const head = await epoch.streamHeadSequence();
  const judgementId = await plantJudgement(sessionId);
  const recorded = await epoch.recordJudgingConsensus(sessionId, judgementId);
  expect(recorded.ok).toBe(true);

  const rows = await eventsAbove(head);
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("session.judged");
  expect(rows[0].session_id).toBe(sessionId);

  // Publish, then let a second consensus land. Nothing the clock waits on
  // changed, so nothing is published.
  await epoch.finalizeEpoch(sessionId);
  expect((await sessionRow(sessionId)).state).toBe("published");
  const afterPublish = await epoch.streamHeadSequence();
  const late = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId));
  expect(late.ok).toBe(true);
  if (late.ok) expect(late.lateEvidence).toBe(true);
  expect((await eventsAbove(afterPublish)).length).toBe(0);
});

test("a subject's duration change publishes subject.changed, and so do create and deactivate", async () => {
  const head = await epoch.streamHeadSequence();
  const id = rid("ev_subject");
  const created = await admin.createSubjectAdmin({ id, name: "event subject" });
  expect(created.status).toBe(201);

  const version = (created as any).subject.version as number;
  const updated = await admin.updateSubjectAdmin(id, version, { epochDuration: 90 });
  expect(updated.status).toBe(200);

  const deactivated = await admin.deactivateSubjectAdmin(id, (updated as any).subject.version);
  expect(deactivated.status).toBe(200);

  const rows = await eventsAbove(head);
  expect(rows.map((r) => r.kind)).toEqual(["subject.changed", "subject.changed", "subject.changed"]);
  expect(rows.map((r) => r.payload.reason)).toEqual(["activated", "updated", "deactivated"]);
  expect(rows.every((r) => r.subject_id === id)).toBe(true);
  expect(rows[1].payload.epochDurationSeconds).toBe(90);
  // The event carries all three scheduling columns (§2.2, §6.2), so the
  // scheduler's re-read can be checked against what changed.
  expect(Object.keys(rows[1].payload).sort()).toEqual(
    ["epochAnchor", "epochDurationSeconds", "judgingDurationSeconds", "reason"],
  );
});

test("re-activation publishes subject.changed with reason `activated`, in the same transaction as the flip", async () => {
  // §6.2: `subject.changed` — "a scheduling column changed (§2.2), or subject
  // activated / deactivated"; the scheduler "on activation opens its first
  // epoch (§3)". The event is the ONLY thing activation does besides the flip:
  // no session appears (epoch-open.test.ts owns that half).
  const id = await activeSubject("ev_activate", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${id}`;
  expect((await admin.deactivateSubjectAdmin(id, version)).status).toBe(200);
  const head = await epoch.streamHeadSequence();

  const activated = await admin.activateSubjectAdmin(id, version + 1);
  expect(activated.status).toBe(200);
  const rows = await eventsAbove(head);
  expect(rows.map((r) => [r.kind, r.subject_id, r.payload.reason])).toEqual([["subject.changed", id, "activated"]]);
  expect(Number(rows[0].seq)).toBe(head + 1);
  expect(Object.keys(rows[0].payload).sort()).toEqual(
    ["epochAnchor", "epochDurationSeconds", "judgingDurationSeconds", "reason"],
  );
  expect(rows[0].payload.epochDurationSeconds).toBe(600);

  // A refused activation (already active) publishes nothing.
  const again = await admin.activateSubjectAdmin(id, version + 2);
  expect(again.status).toBe(409);
  expect((await eventsAbove(head)).length).toBe(1);
});

test("the admin route activates a subject, versioned, and opens no session", async () => {
  const id = await activeSubject("ev_activate_route", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${id}`;
  expect((await admin.deactivateSubjectAdmin(id, version)).status).toBe(200);
  const path = ROUTES.swarm.admin.subjectActivate.replace(":id", encodeURIComponent(id));
  const call = (token: string | null, body: unknown) =>
    handleSwarmAdmin(
      new Request(`http://test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Admin-Token": token } : {}) },
        body: JSON.stringify(body),
      }),
      new URL(`http://test${path}`),
    );
  // An admin edit: no credential, no activation.
  expect((await call(null, { expectedVersion: version + 1 }))?.status).toBe(403);
  expect((await call(OPERATOR, {}))?.status).toBe(400);
  const res = await call(OPERATOR, { expectedVersion: version + 1 });
  expect(res?.status).toBe(200);
  const [{ status }] = await sql<{ status: string }[]>`SELECT status FROM swarm_subjects WHERE id = ${id}`;
  expect(status).toBe("active");
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${id}`).length).toBe(0);
});

test("a change to the anchor or the judging duration alone publishes subject.changed too", async () => {
  // §6.2: `subject.changed` is caused by "a scheduling column changed" — any
  // of the three, not only the duration.
  const id = await activeSubject("ev_other_columns", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${id}`;
  const head = await epoch.streamHeadSequence();
  const anchored = await admin.updateSubjectAdmin(id, version, { epochAnchor: "2026-01-01T22:45:00Z" });
  expect(anchored.status).toBe(200);
  const judged = await admin.updateSubjectAdmin(id, version + 1, { judgingDurationSeconds: 300 });
  expect(judged.status).toBe(200);
  const rows = await eventsAbove(head);
  expect(rows.map((r) => r.kind)).toEqual(["subject.changed", "subject.changed"]);
  expect(rows[0].payload.epochAnchor).toBe("2026-01-01T22:45:00.000Z");
  expect(rows[1].payload.judgingDurationSeconds).toBe(300);
});

test("a refused subject edit publishes nothing", async () => {
  const id = await activeSubject("ev_refused", 600);
  const head = await epoch.streamHeadSequence();
  const stale = await admin.updateSubjectAdmin(id, 999, { epochDuration: 120 });
  expect(stale.status).toBe(409);
  expect((await eventsAbove(head)).length).toBe(0);
});

/**
 * A judgement row authored by the session's judge of record — the only author
 * `recordJudgingConsensus` accepts as a consensus (§4.4). The in-house judge
 * is seated once and reused, so it stays the lowest-id eligible judge.
 */
async function plantJudgement(sessionId: string): Promise<number> {
  const judge = await inHouseJudge();
  const [j] = await sql<{ id: string }[]>`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion,
       judged_by, judged_by_member_id)
    VALUES (${sessionId}, 'enforce', 'model', 'test/epoch-fixture-judge', 'ph', 'id', 1, 1, '{"verdict":"ok"}'::jsonb,
            ${judge.id}, ${judge.id})
    RETURNING id`;
  return Number(j.id);
}

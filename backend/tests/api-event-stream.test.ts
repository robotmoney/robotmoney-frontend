// W4.4 — the SERVING side of the scheduler event stream (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §3.1, §3.2 and above
// all §6.3, quoted where each test enforces it.
//
// WHAT THIS FILE OWNS AND WHAT IT DOES NOT. backend/tests/epoch-events.test.ts
// owns the WRITE path — that every transition writes its event in its own
// transaction, and that the numbers are gapless. Nothing here re-asserts that.
// This file owns what the API HANDS TO A SUBSCRIBER: the full read's four parts
// and its cursor, the handoff between the two, the frames the subscription
// carries, the resync notice, the keepalive's head sequence, and the job
// pushes. The CONSUMER's obligations on receiving all of that — ignore a
// duplicate, rebuild on a gap, never replay after a drop — are a different
// contract with a different subject and live in
// scripts/tests/unit/system-scheduler-stream.test.ts.
//
// THE DIVISION IS NOT COSMETIC. §6.3's keepalive clause is the clearest case:
// the API's whole duty is to put the head sequence on the frame, and it can be
// asserted here exactly. Whether a scheduler behind that number rebuilds is
// something no server-side test can observe, so claiming it here would be
// overstating what the assertion proves.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import * as stream from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { handleSchedulerStream } from "../src/api/routes/swarm-stream.ts";
import { provisionAutomationToken } from "../src/db/automation-tokens.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";
import { inHouseJudge } from "./support/stub-judge.ts";

useCleanDatabase(import.meta.file);

// Nothing waved through: no env automation token, no insecure mode. The
// provisioned per-instance token is then the only thing that can authorize, so
// a rights assertion below means what it says.
const LOCKED = { adminToken: "admin-secret", automationToken: null, allowInsecure: false };

const get = (path: string, token: string | null) =>
  new Request(`http://test${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

const post = (path: string, token: string | null, body: unknown) =>
  new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

interface Frame {
  type: string;
  data: Record<string, any>;
}

/**
 * Read frames off a live SSE body until `want` of them have arrived, then
 * cancel.
 *
 * Cancelling rather than waiting for an end is the point: a subscription has no
 * end, and a test that waited for one would hang instead of failing. The reader
 * is released in a `finally` so a failed expectation still tears the connection
 * down and the suite does not leak a held database handle.
 */
async function readFrames(res: Response, want: number, budgetMs = 5000): Promise<Frame[]> {
  const frames: Frame[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let buffer = "";
  try {
    while (frames.length < want && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (type && data) frames.push({ type, data: JSON.parse(data) });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

/** A judging session on its own subject, with its deadline stored by the API. */
async function judgingSession(prefix: string): Promise<{ subjectId: string; sessionId: string; deadlineAt: string }> {
  await setJudgeMode("enforce");
  const subjectId = await activeSubject(prefix, 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  const sessionId = turned.closedSessionId;
  await epoch.aggregateEpoch(sessionId);
  const requested = await epoch.requestJudging(sessionId);
  if (!requested.ok) throw new Error("requestJudging failed");
  return { subjectId, sessionId, deadlineAt: requested.deadlineAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — the full read's four parts
// ─────────────────────────────────────────────────────────────────────────────

test("the full read returns every active subject with its duration", async () => {
  const a = await activeSubject("fr_dur_a", 300);
  const b = await activeSubject("fr_dur_b", 900);
  const read = await stream.fullRead();
  const byId = new Map(read.subjects.map((s) => [s.subjectId, s]));
  expect(byId.get(a)?.epochDurationSeconds).toBe(300);
  expect(byId.get(b)?.epochDurationSeconds).toBe(900);
});

test("the full read returns every collecting session with its window_closes_at", async () => {
  const subjectId = await activeSubject("fr_collecting", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");

  const read = await stream.fullRead();
  const row = read.collecting.find((c) => c.sessionId === opened.sessionId);
  expect(row).toBeDefined();
  expect(row!.subjectId).toBe(subjectId);
  expect(row!.windowClosesAt).toBe(opened.windowClosesAt);
});

test("the full read returns every closed-but-unpublished session with its state", async () => {
  // §3 step 3 names four states, and a rebuild that missed any one of them
  // would leave that settlement stalled for ever. So all four are built and all
  // four are demanded, rather than one standing in for the set.
  const wanted = new Map<string, stream.SettlingState>();

  const closed = await activeSubject("fr_window_closed", 600);
  const o1 = await epoch.openEpoch(closed);
  if (!o1.ok) throw new Error("openEpoch failed");
  const t1 = await epoch.turnOverEpoch(closed, o1.sessionId);
  if (!t1.ok) throw new Error("turnOverEpoch failed");
  wanted.set(t1.closedSessionId, "window_closed");

  const aggregated = await activeSubject("fr_aggregated", 600);
  const o2 = await epoch.openEpoch(aggregated);
  if (!o2.ok) throw new Error("openEpoch failed");
  const t2 = await epoch.turnOverEpoch(aggregated, o2.sessionId);
  if (!t2.ok) throw new Error("turnOverEpoch failed");
  await epoch.aggregateEpoch(t2.closedSessionId);
  wanted.set(t2.closedSessionId, "aggregated");

  const judging = await judgingSession("fr_judging");
  wanted.set(judging.sessionId, "judging");

  const judged = await judgingSession("fr_judged");
  const judgementId = await plantJudgement(judged.sessionId);
  await epoch.recordJudgingConsensus(judged.sessionId, judgementId);
  wanted.set(judged.sessionId, "judged");

  const read = await stream.fullRead();
  const seen = new Map(read.settling.map((s) => [s.sessionId, s.state]));
  for (const [sessionId, state] of wanted) expect(seen.get(sessionId)).toBe(state);
});

test("a judging session carries its STORED deadline, not a fresh one", async () => {
  const { sessionId, deadlineAt } = await judgingSession("fr_deadline");
  const read = await stream.fullRead();
  const row = read.settling.find((s) => s.sessionId === sessionId);
  // §3: "for `judging` its recorded deadline", and §9: it "is never restarted
  // by a rebuild". A full read that recomputed it would restart every deadline
  // on every scheduler start, which is exactly the failure the clause forbids.
  expect(row!.judgingDeadlineAt).toBe(deadlineAt);
  expect(new Date(deadlineAt).getTime()).toBe(new Date((await sessionRow(sessionId)).judging_deadline_at).getTime());
});

test("a published session is NOT in the full read", async () => {
  await setJudgeMode("off");
  const subjectId = await activeSubject("fr_published", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  await epoch.aggregateEpoch(turned.closedSessionId);
  await epoch.finalizeEpoch(turned.closedSessionId);

  const read = await stream.fullRead();
  expect(read.settling.some((s) => s.sessionId === turned.closedSessionId)).toBe(false);
});

test("a deactivated subject's unfinished settlement is still in the full read", async () => {
  // §3: "This includes sessions whose subject has since been deactivated;
  // deactivation closes an epoch but settlement still has to finish." Dropping
  // it would strand the session in `window_closed` for ever, with no timer and
  // no owner.
  const subjectId = await activeSubject("fr_deactivated", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const [subject] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const done = await admin.deactivateSubjectAdmin(subjectId, subject.version);
  expect(done.status).toBe(200);

  const read = await stream.fullRead();
  expect(read.subjects.some((s) => s.subjectId === subjectId)).toBe(false);
  const row = read.settling.find((s) => s.sessionId === opened.sessionId);
  expect(row).toBeDefined();
  expect(row!.state).toBe("window_closed");
  expect(row!.subjectActive).toBe(false);
});

test("the full read's cursor is the head sequence as of the snapshot", async () => {
  const subjectId = await activeSubject("fr_cursor", 600);
  await epoch.openEpoch(subjectId);
  const read = await stream.fullRead();
  expect(read.cursor).toBe(await epoch.streamHeadSequence());
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — the read/stream handoff
// ─────────────────────────────────────────────────────────────────────────────

test("a turnover committed between the full read and the subscription arrives ABOVE the cursor", async () => {
  // §10's "Handoff" gate, and the reason the cursor exists at all: "Writes that
  // land while the read is in flight are therefore either in the snapshot or on
  // the stream, never lost between the two."
  const subjectId = await activeSubject("fr_handoff", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");

  const read = await stream.fullRead();
  expect(read.collecting.some((c) => c.sessionId === opened.sessionId)).toBe(true);

  // A turnover this reader did not make — a second scheduler's (D55: never an
  // operator's) — commits in the gap between the two calls.
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");

  const missed = await stream.eventsAbove(read.cursor);
  const event = missed.find((e) => e.kind === "epoch.turned_over" && e.subjectId === subjectId);
  expect(event).toBeDefined();
  expect(event!.seq).toBeGreaterThan(read.cursor);
  expect(event!.payload.closedSessionId).toBe(opened.sessionId);
});

test("events at or below the cursor are not served — the consumer never sees a duplicate to ignore", async () => {
  const subjectId = await activeSubject("fr_dupes", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  await epoch.turnOverEpoch(subjectId, opened.sessionId);

  const head = await epoch.streamHeadSequence();
  const served = await stream.eventsAbove(head);
  expect(served).toEqual([]);
  expect((await stream.eventsAbove(head - 1)).map((e) => e.seq)).toEqual([head]);
});

test("events are served in ascending sequence order", async () => {
  const subjectId = await activeSubject("fr_order", 600);
  const cursor = await epoch.streamHeadSequence();
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const t = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!t.ok) throw new Error("turnOverEpoch failed");
  await epoch.turnOverEpoch(subjectId, t.openedSessionId);

  const seqs = (await stream.eventsAbove(cursor)).map((e) => e.seq);
  expect(seqs.length).toBeGreaterThanOrEqual(2);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — resync. "The API never silently skips."
// ─────────────────────────────────────────────────────────────────────────────

test("a cursor the API cannot serve from is answered with a resync reason, never a silent skip", async () => {
  const head = await epoch.streamHeadSequence();
  expect(await stream.resyncReasonFor(head)).toBeNull();
  expect(await stream.resyncReasonFor(0)).toBeNull();
  // Ahead of the head: this subscriber claims to have applied an event the API
  // has not committed. Nothing can be served from there, and serving from the
  // head instead would be the silent skip §6.3 forbids.
  expect(await stream.resyncReasonFor(head + 5)).toBe("cursor_ahead_of_head");
});

test("a cursor below the retained log's floor is a resync, not an empty answer", async () => {
  const subjectId = await activeSubject("fr_truncated", 600);
  await epoch.openEpoch(subjectId);
  const floor = (await stream.retainedFloor())!;
  expect(floor).toBeGreaterThan(0);
  // A cursor at floor-1 is servable: the next event the subscriber needs is
  // still in the log. One below THAT is not, and the difference is the whole
  // "its retained log does not reach that far" clause.
  expect(await stream.resyncReasonFor(floor - 1)).toBeNull();
  if (floor >= 2) expect(await stream.resyncReasonFor(floor - 2)).toBe("log_truncated");
});

test("the subscription sends a resync frame and nothing else when it cannot serve the cursor", async () => {
  const head = await epoch.streamHeadSequence();
  const res = stream.openSchedulerStream(head + 99, { keepaliveMs: 50, pollMs: 10 });
  const frames = await readFrames(res, 1);
  expect(frames[0].type).toBe("resync");
  expect(frames[0].data.reason).toBe("cursor_ahead_of_head");
  expect(frames.some((f) => f.type === "event")).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — the subscription's frames
// ─────────────────────────────────────────────────────────────────────────────

test("the subscription delivers events above the cursor, in order, as event frames", async () => {
  const subjectId = await activeSubject("sub_events", 600);
  const cursor = await epoch.streamHeadSequence();
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  await epoch.turnOverEpoch(subjectId, opened.sessionId);

  const res = stream.openSchedulerStream(cursor, { keepaliveMs: 5000, pollMs: 10 });
  const frames = await readFrames(res, 1);
  const events = frames.filter((f) => f.type === "event");
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0].data.seq).toBe(cursor + 1);
  expect(events[0].data.kind).toBe("epoch.turned_over");
});

test("an event committed WHILE the subscription is live is delivered on it", async () => {
  const subjectId = await activeSubject("sub_live", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const cursor = await epoch.streamHeadSequence();

  const res = stream.openSchedulerStream(cursor, { keepaliveMs: 5000, pollMs: 10 });
  const pending = readFrames(res, 1);
  await epoch.turnOverEpoch(subjectId, opened.sessionId);
  const frames = await pending;
  expect(frames[0].type).toBe("event");
  expect(frames[0].data.kind).toBe("epoch.turned_over");
  expect(frames[0].data.seq).toBe(cursor + 1);
});

test("EVERY keepalive carries the sequence of the last event the API committed", async () => {
  // §6.3: "Each keepalive from the API includes the sequence number of the last
  // event it committed." This is the API's entire share of the final-event-loss
  // gate — the consumer's share is asserted in
  // scripts/tests/unit/system-scheduler-stream.test.ts, and neither test claims
  // the other's half.
  const subjectId = await activeSubject("sub_keepalive", 600);
  await epoch.openEpoch(subjectId);
  const head = await epoch.streamHeadSequence();

  const res = stream.openSchedulerStream(head, { keepaliveMs: 20, pollMs: 10 });
  const frames = await readFrames(res, 2);
  const keepalives = frames.filter((f) => f.type === "keepalive");
  expect(keepalives.length).toBeGreaterThanOrEqual(2);
  for (const k of keepalives) expect(k.data.head).toBe(head);
});

test("the keepalive's head moves with the log, so a quiet subscriber still learns the number", async () => {
  const subjectId = await activeSubject("sub_keepalive_moves", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const before = await epoch.streamHeadSequence();

  // Subscribe from a cursor ABOVE nothing — then commit an event this
  // subscriber is not served (it is served, but the point is the number on the
  // keepalive frame tracks the log rather than the connection).
  const res = stream.openSchedulerStream(before, { keepaliveMs: 20, pollMs: 10 });
  await readFrames(res, 1);
  await epoch.turnOverEpoch(subjectId, opened.sessionId);
  const after = await epoch.streamHeadSequence();
  expect(after).toBeGreaterThan(before);

  const res2 = stream.openSchedulerStream(after, { keepaliveMs: 20, pollMs: 10 });
  const frames = await readFrames(res2, 1);
  expect(frames[0].type).toBe("keepalive");
  expect(frames[0].data.head).toBe(after);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — job pushes
// ─────────────────────────────────────────────────────────────────────────────

test("a job carries kind, target and an idempotency key", async () => {
  const key = `job_${crypto.randomUUID()}`;
  const created = await stream.pushJob({ kind: "reconcile_subject", target: "sub-1", idempotencyKey: key });
  expect(created.created).toBe(true);

  const pending = await stream.unackedJobs();
  const job = pending.find((j) => j.idempotencyKey === key);
  expect(job).toEqual({ kind: "reconcile_subject", target: "sub-1", idempotencyKey: key });
});

test("pushing the same idempotency key twice creates one job", async () => {
  const key = `job_${crypto.randomUUID()}`;
  await stream.pushJob({ kind: "reconcile_subject", target: "sub-2", idempotencyKey: key });
  const again = await stream.pushJob({ kind: "reconcile_subject", target: "sub-2", idempotencyKey: key });
  expect(again.created).toBe(false);
  expect((await stream.unackedJobs()).filter((j) => j.idempotencyKey === key).length).toBe(1);
});

test("an unacked job is pushed on connect, and again on reconnect", async () => {
  const key = `job_${crypto.randomUUID()}`;
  await stream.pushJob({ kind: "reconcile_subject", target: "sub-3", idempotencyKey: key });
  const head = await epoch.streamHeadSequence();
  // Every job the file has pushed and not acked is outstanding, so the frames
  // are matched by key rather than by position — asserting "the first frame" here
  // would be asserting the order of the tests above, not the contract.
  const outstanding = (await stream.unackedJobs()).length;
  expect(outstanding).toBeGreaterThanOrEqual(1);

  const first = await readFrames(stream.openSchedulerStream(head, { keepaliveMs: 30, pollMs: 10 }), outstanding);
  expect(first.filter((f) => f.type === "job").map((f) => f.data.idempotencyKey)).toContain(key);

  // §6.3: "On reconnect the API re-pushes anything unacked." The job was never
  // acked, so a second connection must see it again — an at-most-once push
  // would lose the work of a scheduler that died holding it.
  const second = await readFrames(stream.openSchedulerStream(head, { keepaliveMs: 30, pollMs: 10 }), outstanding);
  expect(second.filter((f) => f.type === "job").map((f) => f.data.idempotencyKey)).toContain(key);
});

test("an acked job is not pushed again", async () => {
  const key = `job_${crypto.randomUUID()}`;
  await stream.pushJob({ kind: "reconcile_subject", target: "sub-4", idempotencyKey: key });
  expect(await stream.ackJob(key)).toEqual({ known: true, acked: true, alreadyAcked: false });
  expect((await stream.unackedJobs()).some((j) => j.idempotencyKey === key)).toBe(false);
});

test("a second ack of the same key is a no-op, and an unknown key is refused", async () => {
  const key = `job_${crypto.randomUUID()}`;
  await stream.pushJob({ kind: "reconcile_subject", target: "sub-5", idempotencyKey: key });
  await stream.ackJob(key);
  expect(await stream.ackJob(key)).toEqual({ known: true, acked: false, alreadyAcked: true });
  expect(await stream.ackJob("never_pushed")).toEqual({ known: false, acked: false, alreadyAcked: false });
});

test("an acked job keeps its row, so a re-push of the same key cannot re-run it", async () => {
  // The key is the whole idempotency guarantee, and it has to outlive the ack:
  // a row deleted on ack would let the identical key be accepted as new work.
  const key = `job_${crypto.randomUUID()}`;
  await stream.pushJob({ kind: "reconcile_subject", target: "sub-6", idempotencyKey: key });
  await stream.ackJob(key);
  const repush = await stream.pushJob({ kind: "reconcile_subject", target: "sub-6", idempotencyKey: key });
  expect(repush.created).toBe(false);
  expect((await stream.unackedJobs()).some((j) => j.idempotencyKey === key)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication (scheduler spec §7, smoke spec §3)
// ─────────────────────────────────────────────────────────────────────────────

test("the full read needs read_subjects AND read_sessions, and the scheduler's token has both", async () => {
  const { token } = await provisionAutomationToken("rm_stream_reader", ["read_subjects", "read_sessions"]);
  const ok = await handleSchedulerStream(get("/api/swarm/scheduler/full-read", token), url("/api/swarm/scheduler/full-read"), LOCKED);
  expect((ok as { status: number }).status).toBe(200);

  const { token: partial } = await provisionAutomationToken("rm_stream_partial", ["read_subjects"]);
  const refused = await handleSchedulerStream(
    get("/api/swarm/scheduler/full-read", partial),
    url("/api/swarm/scheduler/full-read"),
    LOCKED,
  );
  expect((refused as { status: number }).status).toBe(403);
});

test("an unknown bearer reads nothing from the stream", async () => {
  const refused = await handleSchedulerStream(
    get("/api/swarm/scheduler/full-read", "rmat_forged"),
    url("/api/swarm/scheduler/full-read"),
    LOCKED,
  );
  expect((refused as { status: number }).status).toBe(403);
});

test("the analytics producer's and the operator's tokens read nothing from the stream — rights are per holder", async () => {
  // Smoke spec §3: the scheduler's rights are "read subjects and sessions,
  // perform lifecycle transitions"; the other two holders on the SAME instance
  // hold only their own (migration 0078). A valid, store-issued token of the
  // wrong holder is refused exactly like a forged one.
  const producer = await provisionAutomationToken("rm_stream_holders", ["analytics_ingestion"], {
    holder: "analytics-producer",
  });
  const operator = await provisionAutomationToken("rm_stream_holders", ["admin"], { holder: "operator" });
  for (const token of [producer.token, operator.token]) {
    const refused = await handleSchedulerStream(
      get("/api/swarm/scheduler/full-read", token),
      url("/api/swarm/scheduler/full-read"),
      LOCKED,
    );
    expect((refused as { status: number }).status).toBe(403);
  }
});

test("the ack route needs lifecycle_transitions, not merely a read right", async () => {
  const key = `job_${crypto.randomUUID()}`;
  await stream.pushJob({ kind: "reconcile_subject", target: "sub-7", idempotencyKey: key });
  const { token: reader } = await provisionAutomationToken("rm_ack_reader", ["read_sessions"]);
  const refused = await handleSchedulerStream(
    post("/api/swarm/scheduler/jobs/ack", reader, { idempotencyKey: key }),
    url("/api/swarm/scheduler/jobs/ack"),
    LOCKED,
  );
  expect((refused as { status: number }).status).toBe(403);
  expect((await stream.unackedJobs()).some((j) => j.idempotencyKey === key)).toBe(true);

  const { token: driver } = await provisionAutomationToken("rm_ack_driver", ["lifecycle_transitions"]);
  const ok = await handleSchedulerStream(
    post("/api/swarm/scheduler/jobs/ack", driver, { idempotencyKey: key }),
    url("/api/swarm/scheduler/jobs/ack"),
    LOCKED,
  );
  expect((ok as { status: number }).status).toBe(200);
  expect((await stream.unackedJobs()).some((j) => j.idempotencyKey === key)).toBe(false);
});

test("the route serves the same four parts and cursor the module does", async () => {
  const { token } = await provisionAutomationToken("rm_stream_route", ["read_subjects", "read_sessions"]);
  const res = (await handleSchedulerStream(
    get("/api/swarm/scheduler/full-read", token),
    url("/api/swarm/scheduler/full-read"),
    LOCKED,
  )) as { status: number; body: any };
  expect(res.status).toBe(200);
  expect(Object.keys(res.body).sort()).toEqual(["collecting", "cursor", "settling", "subjects"]);
  expect(typeof res.body.cursor).toBe("number");
});

test("the subscribe route returns an event-stream response", async () => {
  const { token } = await provisionAutomationToken("rm_stream_sub", ["read_subjects", "read_sessions"]);
  const head = await epoch.streamHeadSequence();
  const res = await handleSchedulerStream(
    get(`/api/swarm/scheduler/subscribe?cursor=${head}`, token),
    url(`/api/swarm/scheduler/subscribe?cursor=${head}`),
    LOCKED,
  );
  expect(res).toBeInstanceOf(Response);
  expect((res as Response).headers.get("Content-Type")).toBe("text/event-stream");
  await (res as Response).body?.cancel();
});

test("the stream routes own only their own paths", async () => {
  expect(await handleSchedulerStream(get("/api/swarm/members", null), url("/api/swarm/members"), LOCKED)).toBeNull();
});

const url = (p: string) => new URL(`http://test${p}`);

// Authored by the session's judge of record: `recordJudgingConsensus` refuses
// a consensus from anyone else (§4.4, issue #1026 wave 2).
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

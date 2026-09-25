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
// carries, the resync notice, the keepalive's head sequence, the counter row
// that numbers the log, and the absence of job pushes (§6.3 as amended by D52).
// The CONSUMER's obligations on receiving all of that — ignore a
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
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
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

/**
 * Like `readFrames`, but the connection stays open after the first `want`
 * frames so a case can change the world and then keep reading the SAME
 * connection. `more` reads until `n` frames, the end of the stream, or the
 * budget, and says which it was: `done` is true only when the server ended the
 * stream. It releases the reader either way.
 */
async function readFramesKeepOpen(res: Response, want: number, budgetMs = 5000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pull = async (n: number, budget: number): Promise<{ frames: Frame[]; done: boolean }> => {
    const frames: Frame[] = [];
    const deadline = Date.now() + budget;
    while (frames.length < n && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
      if (next === null) break;
      if (next.done) return { frames, done: true };
      buffer += decoder.decode(next.value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (type && data) frames.push({ type, data: JSON.parse(data) });
      }
    }
    return { frames, done: false };
  };
  const first = await pull(want, budgetMs);
  return {
    frames: first.frames,
    async more(n: number, budget = 5000): Promise<{ frames: Frame[]; done: boolean }> {
      try {
        const rest = await pull(n, budget);
        // A frame count reached exactly as the stream ended still ends it.
        if (!rest.done) {
          const tail = await Promise.race([reader.read(), Bun.sleep(100).then(() => null)]);
          if (tail?.done) return { ...rest, done: true };
        }
        return rest;
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
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
  // Made non-vacuous by a real prune: rm_owner (the only role that may, D53
  // (2)) removes the oldest rows inside a transaction, so the floor is above 1
  // and the refusal below is about a cursor the log truly no longer reaches.
  // Rolled back afterwards, so the rest of the file keeps its whole log.
  const subjectId = await activeSubject("fr_truncated", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  await epoch.turnOverEpoch(subjectId, opened.sessionId);
  await sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      const head = await epoch.streamHeadSequence(tx);
      expect(head).toBeGreaterThanOrEqual(3);
      await tx`DELETE FROM swarm_stream_events WHERE seq <= ${head - 2}`;
      const floor = (await stream.retainedFloor(tx))!;
      expect(floor).toBe(head - 1);
      // A cursor at floor-1 is servable: the next event the subscriber needs
      // is still in the log. One below THAT is not, and the difference is the
      // whole "retained at least as far back as the oldest cursor" clause.
      expect(await stream.resyncReasonFor(floor - 1, tx)).toBeNull();
      expect(await stream.resyncReasonFor(floor - 2, tx)).toBe("log_truncated");
      expect(await stream.resyncReasonFor(0, tx)).toBe("log_truncated");
      // The head is the counter's, not the log's: pruning moved nothing.
      expect(await epoch.streamHeadSequence(tx)).toBe(head);
      throw new Error("roll the prune back");
    })
    .catch((e: Error) => {
      if (e.message !== "roll the prune back") throw e;
    });
  expect(await stream.retainedFloor()).toBe(1);
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
// §6.3 — no job pushes (amended 2026-09-24, D52; criteria 94 and 105)
// ─────────────────────────────────────────────────────────────────────────────
//
// "No job pushes. The stream carries change events only. Every piece of work
// the scheduler does follows from an event or a timer; there is no ad-hoc job
// kind for the API to push, ack or redeliver." Each case below fails on the
// code that had them: the module exported pushJob/unackedJobs/ackJob, the
// subscription sent every unacked job as a `job` frame, the ack route answered,
// and migration 0070's table held the keys.

test("the domain module has no job surface: no push, no outstanding list, no ack", () => {
  for (const name of ["pushJob", "unackedJobs", "ackJob"]) {
    expect({ name, exported: name in stream }).toEqual({ name, exported: false });
  }
});

test("the pushed-job table is gone, dropped by a forward migration rather than a deleted 0070", async () => {
  // Criterion 105: 0070 may have reached a shared database, so its file stays
  // and 0079 drops the table. Both are recorded in the ledger of every
  // migrated database.
  const [table] = await sql<{ reg: string | null }[]>`SELECT to_regclass('public.swarm_scheduler_jobs')::text AS reg`;
  expect(table.reg).toBeNull();
  const ledger = (await sql<{ name: string }[]>`
    SELECT name FROM schema_migrations
     WHERE name IN ('0070_swarm_scheduler_jobs.sql', '0079_drop_swarm_scheduler_jobs.sql') ORDER BY name`).map((r) => r.name);
  expect(ledger).toEqual(["0070_swarm_scheduler_jobs.sql", "0079_drop_swarm_scheduler_jobs.sql"]);
});

test("the contract has no job-ack route, and the old path is not served", async () => {
  expect("jobAck" in ROUTES.swarm.scheduler).toBe(false);
  const { token } = await provisionAutomationToken("rm_no_job_ack", ["lifecycle_transitions"]);
  // `null` is "not mine": the router answers it with its ordinary 404.
  expect(
    await handleSchedulerStream(
      post("/api/swarm/scheduler/jobs/ack", token, { idempotencyKey: "job_never_pushed" }),
      url("/api/swarm/scheduler/jobs/ack"),
      LOCKED,
    ),
  ).toBeNull();
});

test("a live subscription carries only event, keepalive and resync frames — never a job", async () => {
  const subjectId = await activeSubject("sub_frame_kinds", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const cursor = await epoch.streamHeadSequence();
  const res = stream.openSchedulerStream(cursor, { keepaliveMs: 20, pollMs: 10 });
  const pending = readFrames(res, 4);
  await epoch.turnOverEpoch(subjectId, opened.sessionId);
  const frames = await pending;
  expect(frames.length).toBe(4);
  expect(frames.filter((f) => !["event", "keepalive", "resync"].includes(f.type))).toEqual([]);
  expect(frames.some((f) => f.type === "event" && f.data.kind === "epoch.turned_over")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — one counter row: gapless, in commit order, no hole on rollback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One event-writing transaction held open on its own connection: it appends,
 * reports the number it was given, then waits to be told to commit or roll
 * back. Two of these are how the counter row's lock is observed directly.
 */
function heldAppend(subjectId: string, label: string) {
  let decide!: (commit: boolean) => void;
  const decision = new Promise<boolean>((resolve) => (decide = resolve));
  let reportSeq!: (seq: number) => void;
  const seq = new Promise<number>((resolve) => (reportSeq = resolve));
  const done = sql
    .begin(async (tx) => {
      const n = await epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", label } });
      reportSeq(n);
      if (!(await decision)) throw new Error("rolled back on purpose");
    })
    .then(
      () => "committed" as const,
      (e: Error) => {
        if (e.message !== "rolled back on purpose") throw e;
        return "rolled_back" as const;
      },
    );
  return { seq, decide, done };
}

/** Resolves to `undefined` if `p` has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, Bun.sleep(ms).then(() => undefined)]);

test("a second event-writing transaction waits on the counter row, and numbers follow commit order", async () => {
  // §6.3: "The row lock serializes event-writing transactions, so numbers are
  // assigned in commit order." B cannot even take a number while A holds the
  // row, so B's number can never commit before A's.
  const subjectId = await activeSubject("seq_commit_order", 600);
  const before = await epoch.streamHeadSequence();
  const a = heldAppend(subjectId, "a");
  const seqA = await a.seq;
  expect(seqA).toBe(before + 1);

  const b = heldAppend(subjectId, "b");
  expect(await within(b.seq, 300), "B must block on the counter row while A is open").toBeUndefined();

  a.decide(true);
  expect(await a.done).toBe("committed");
  const seqB = await b.seq;
  expect(seqB).toBe(seqA + 1);
  b.decide(true);
  expect(await b.done).toBe("committed");

  const served = (await stream.eventsAbove(before)).filter((e) => e.subjectId === subjectId);
  expect(served.map((e) => [e.seq, e.payload.label])).toEqual([
    [seqA, "a"],
    [seqB, "b"],
  ]);
});

test("a rolled-back transition leaves no hole: the next writer takes the same number", async () => {
  const subjectId = await activeSubject("seq_rollback", 600);
  const before = await epoch.streamHeadSequence();
  const a = heldAppend(subjectId, "rolled-back");
  const seqA = await a.seq;
  const b = heldAppend(subjectId, "kept");
  expect(await within(b.seq, 300)).toBeUndefined();

  a.decide(false);
  expect(await a.done).toBe("rolled_back");
  // The number A held is handed to B, because A's increment rolled back with it.
  expect(await b.seq).toBe(seqA);
  b.decide(true);
  expect(await b.done).toBe("committed");

  expect(await epoch.streamHeadSequence()).toBe(before + 1);
  const served = await stream.eventsAbove(before);
  expect(served.map((e) => e.seq)).toEqual([before + 1]);
  expect(served[0].payload.label).toBe("kept");
});

test("the full read's cursor is the counter visible in its own snapshot, not a transition still in flight", async () => {
  // §6.3: "The full read takes its cursor from the counter value visible in
  // its own snapshot." A transition that has taken a number but not committed
  // is not in the snapshot, so it must not be in the cursor either — or the
  // subscriber would treat it as applied and drop it as a duplicate.
  const subjectId = await activeSubject("fr_inflight", 600);
  const before = await epoch.streamHeadSequence();
  const inflight = heldAppend(subjectId, "inflight");
  const seq = await inflight.seq;
  expect(seq).toBe(before + 1);

  const read = await within(stream.fullRead(), 2_000);
  expect(read, "the full read must not wait on the counter row's lock").toBeDefined();
  expect(read!.cursor).toBe(before);

  inflight.decide(true);
  await inflight.done;
  // Committed after the read: above its cursor, so on the stream.
  expect((await stream.eventsAbove(read!.cursor)).map((e) => e.seq)).toEqual([seq]);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — the stream never claims the subscriber is current when it cannot say
// ─────────────────────────────────────────────────────────────────────────────

test("MODULE ONLY: a full queue on the response itself is answered with a resync and a close, nothing skipped before it", async () => {
  // §6.3: "its buffer for this subscriber overflowed ... it says so." The
  // subscriber below reads nothing while five events are waiting; the
  // connection may hold three frames. What it then reads is the events it was
  // sent, in order and gapless from the cursor, then the reason, then the end.
  //
  // WHAT THIS DOES NOT PROVE. The Response is read in-process, with no server
  // in between. Behind the real Bun.serve the queue is drained eagerly and
  // this limit is never reached (StreamOptions.bufferFrames); what bounds a
  // stalled subscriber there is the server's idle timeout, proved through a
  // real server and a socket that never reads further down this file.
  const subjectId = await activeSubject("sub_overflow", 600);
  const cursor = await epoch.streamHeadSequence();
  const session = await epoch.openEpoch(subjectId);
  if (!session.ok) throw new Error("openEpoch failed");
  let open = session.sessionId;
  for (let i = 0; i < 5; i++) {
    const t = await epoch.turnOverEpoch(subjectId, open);
    if (!t.ok) throw new Error("turnOverEpoch failed");
    open = t.openedSessionId;
  }
  expect((await epoch.streamHeadSequence()) - cursor).toBeGreaterThanOrEqual(5);

  const res = stream.openSchedulerStream(cursor, { keepaliveMs: 5_000, pollMs: 10, bufferFrames: 3 });
  await Bun.sleep(200); // the loop runs while nobody reads
  const frames = await readFrames(res, 100, 2_000);
  const last = frames[frames.length - 1];
  expect(last.type).toBe("resync");
  expect(last.data.reason).toBe("buffer_overflow");
  const events = frames.filter((f) => f.type === "event").map((f) => f.data.seq);
  expect(events.length).toBeGreaterThan(0);
  expect(events).toEqual(events.map((_, i) => cursor + 1 + i));
  expect(frames.filter((f) => f.type === "resync").length).toBe(1);
});

test("a cursor above the head is a resync and the connection ENDS — no stream of nothing", async () => {
  const head = await epoch.streamHeadSequence();
  const res = stream.openSchedulerStream(head + 7, { keepaliveMs: 20, pollMs: 10 });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const frames = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  expect(frames).toEqual(["resync"]);
  expect(text).toContain('"reason":"cursor_ahead_of_head"');
});

test("a database error ends the connection with resync `unavailable`, never a keepalive with a guessed head", async () => {
  // The code this replaces answered a failed head read with the connection's
  // own `sent` number — a keepalive that told a subscriber behind the real
  // head that it was current. The counter row is made unreadable for the
  // length of the case and restored in `finally`.
  const head = await epoch.streamHeadSequence();
  const res = stream.openSchedulerStream(head, { keepaliveMs: 20, pollMs: 10 });
  const first = await readFramesKeepOpen(res, 1);
  expect(first.frames[0].type).toBe("keepalive");
  await sql`ALTER TABLE swarm_stream_head RENAME TO swarm_stream_head_hidden`;
  try {
    const rest = await first.more(10, 2_000);
    expect(rest.done, "the connection must end").toBe(true);
    const last = rest.frames[rest.frames.length - 1];
    expect(last.type).toBe("resync");
    expect(last.data).toEqual({ reason: "unavailable", head: null });
    // A keepalive queued before the rename carries the real head; none carries
    // a stand-in, and nothing follows the resync.
    for (const f of rest.frames.slice(0, -1)) expect(f).toEqual({ type: "keepalive", data: { head } });
  } finally {
    await sql`ALTER TABLE swarm_stream_head_hidden RENAME TO swarm_stream_head`;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 / criterion 92 — killed after commit, still found
// ─────────────────────────────────────────────────────────────────────────────

test("SUBSCRIBER HALF: a turnover committed and never delivered — its reader cancelled — is served to a resubscribe from the old cursor", async () => {
  // "Each event row and its global sequence are written in the same
  // transaction as the transition ... proved ... by killing a publisher after
  // commit and still finding it." The event's durability is the commit's, not
  // the connection's: nothing the dead connection did or did not send decides
  // whether a later subscriber sees it.
  const subjectId = await activeSubject("sub_killed", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const cursor = await epoch.streamHeadSequence();

  const doomed = stream.openSchedulerStream(cursor, { keepaliveMs: 5_000, pollMs: 10 });
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  // Killed before it read a single frame.
  await doomed.body!.cancel();

  const again = stream.openSchedulerStream(cursor, { keepaliveMs: 5_000, pollMs: 10 });
  const frames = await readFrames(again, 1);
  expect(frames[0].type).toBe("event");
  expect(frames[0].data.seq).toBe(cursor + 1);
  expect(frames[0].data.kind).toBe("epoch.turned_over");
  expect(frames[0].data.payload.closedSessionId).toBe(opened.sessionId);
});

/**
 * Run `code` in a child `bun` process against THIS file's database, and
 * SIGKILL it while its transaction is inside COMMIT.
 *
 * THE HOOK. A DEFERRABLE INITIALLY DEFERRED constraint trigger on `table`
 * sleeps inside the committing transaction, after every statement of it has
 * run. The parent sees that backend waiting on `PgSleep`, kills the child
 * there, and then waits for the backend to finish: Postgres completes a COMMIT
 * whose client has gone (nothing checks the socket during the sleep), so the
 * transaction commits while the process that sent it is already dead. Anything
 * that process would have done after its COMMIT returned — a second write, a
 * publish — never happens.
 */
async function killedInsideCommit(table: string, code: string): Promise<{ stdout: string }> {
  await sql.unsafe(`
    CREATE FUNCTION rm_test_sleep_at_commit() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN PERFORM pg_sleep(1.5); RETURN NULL; END $t$;
    CREATE CONSTRAINT TRIGGER rm_test_sleep_at_commit AFTER INSERT ON ${table}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rm_test_sleep_at_commit();`);
  const sleeping = async (): Promise<number> =>
    Number(
      ((await sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event = 'PgSleep'`) as unknown as {
        n: number;
      }[])[0]!.n,
    );
  const child = Bun.spawn(["bun", "-e", code], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let caught = false;
    for (let i = 0; i < 1_500 && !caught; i++) {
      if ((await sleeping()) > 0) caught = true;
      else await Bun.sleep(10);
    }
    if (!caught) {
      child.kill("SIGKILL");
      throw new Error(`the child never reached its COMMIT: ${await new Response(child.stderr).text()}`);
    }
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    // The orphaned backend finishes its sleep and its COMMIT on its own.
    for (let i = 0; i < 500 && (await sleeping()) > 0; i++) await Bun.sleep(10);
    expect(await sleeping()).toBe(0);
    return { stdout: await new Response(child.stdout).text() };
  } finally {
    await sql.unsafe(`DROP TRIGGER IF EXISTS rm_test_sleep_at_commit ON ${table};
                      DROP FUNCTION IF EXISTS rm_test_sleep_at_commit();`);
  }
}

const DOMAIN_MODULE = join(import.meta.dir, "..", "src", "swarm", "domain.ts");
const CLIENT_MODULE = join(import.meta.dir, "..", "src", "db", "client.ts");

test("PUBLISHER HALF: a turnover whose process is SIGKILLed inside its COMMIT still has its event and number", async () => {
  // Criterion 92: "... by killing a publisher after commit and still finding
  // it." The turnover runs in a child process that is killed before
  // turnOverEpoch returns, so only what was written INSIDE the transaction can
  // be in the log afterwards. The red control below shows the harness would
  // lose an event written after the commit.
  const subjectId = await activeSubject("sub_publisher_killed", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const head = await epoch.streamHeadSequence();

  const { stdout } = await killedInsideCommit(
    "swarm_sessions",
    `const d = await import(${JSON.stringify(DOMAIN_MODULE)});
     console.log("started");
     const r = await d.turnOverEpoch(${JSON.stringify(subjectId)}, ${JSON.stringify(opened.sessionId)});
     console.log("returned " + JSON.stringify(r));
     process.exit(0);`,
  );
  expect(stdout).toContain("started");
  expect(stdout, "the child must die before turnOverEpoch returns").not.toContain("returned");

  // A fresh read, from this process: the transition, its event and its number.
  expect(await epoch.streamHeadSequence()).toBe(head + 1);
  const [event] = await epoch.eventsAbove(head);
  expect(event).toMatchObject({ seq: head + 1, kind: "epoch.turned_over", subjectId });
  expect(event!.payload.closedSessionId).toBe(opened.sessionId);
  expect((await sessionRow(opened.sessionId)).state).not.toBe("collecting");
  // And a subscriber from the old cursor is served it.
  const frames = await readFrames(stream.openSchedulerStream(head, { keepaliveMs: 5_000, pollMs: 10 }), 1);
  expect(frames[0]).toMatchObject({ type: "event", data: { seq: head + 1, kind: "epoch.turned_over" } });
});

test("RED CONTROL for the publisher kill: an event written AFTER the commit is lost under the same kill", async () => {
  // The same harness on a writer built the wrong way: its state change commits
  // in one transaction and its event would be appended in a second one after
  // it. Killed inside the first COMMIT, the state change stands and the event
  // never exists — which is exactly what the case above would see if the
  // turnover published after committing.
  await sql.unsafe("CREATE TABLE rm_test_kill_marker (id int PRIMARY KEY)");
  try {
    const head = await epoch.streamHeadSequence();
    const { stdout } = await killedInsideCommit(
      "rm_test_kill_marker",
      `const d = await import(${JSON.stringify(DOMAIN_MODULE)});
       const { sql } = await import(${JSON.stringify(CLIENT_MODULE)});
       console.log("started");
       await sql.begin(async (tx) => { await tx\`INSERT INTO rm_test_kill_marker VALUES (1)\`; });
       await sql.begin((tx) => d.appendStreamEvent(tx, "subject.changed", { payload: { reason: "after_commit" } }));
       console.log("returned");
       process.exit(0);`,
    );
    expect(stdout).not.toContain("returned");
    expect(((await sql`SELECT id FROM rm_test_kill_marker`) as unknown as { id: number }[]).map((r) => r.id)).toEqual([1]);
    expect(await epoch.streamHeadSequence()).toBe(head);
    expect(await epoch.eventsAbove(head)).toEqual([]);
  } finally {
    await sql.unsafe("DROP TABLE rm_test_kill_marker");
  }
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

test("a bearer rotated while the subscription is open closes it at the next keepalive", async () => {
  // Smoke spec §3: provisioning a holder's token again REPLACES the row's hash,
  // so the old bearer authorizes nothing from that instant — including a
  // subscription it opened before the rotation. The route re-checks the bearer
  // every keepalive interval (a busy stream too: the next case); without that,
  // a revoked credential would keep reading the stream for the life of the
  // socket.
  const rights = ["read_subjects", "read_sessions"] as const;
  const { token } = await provisionAutomationToken("rm_stream_rotated", [...rights]);
  const head = await epoch.streamHeadSequence();
  const path = `/api/swarm/scheduler/subscribe?cursor=${head}`;
  const timing = { ...LOCKED, streamTiming: { keepaliveMs: 20, pollMs: 10 } };

  // Control: an unrotated bearer is served keepalive after keepalive.
  const kept = (await handleSchedulerStream(get(path, token), url(path), timing)) as Response;
  const steady = await readFrames(kept, 4, 2_000);
  expect(steady.map((f) => f.type)).toEqual(["keepalive", "keepalive", "keepalive", "keepalive"]);

  const res = (await handleSchedulerStream(get(path, token), url(path), timing)) as Response;
  const open = await readFramesKeepOpen(res, 1);
  expect(open.frames.map((f) => f.type)).toEqual(["keepalive"]);

  await provisionAutomationToken("rm_stream_rotated", [...rights]); // the rotation
  const after = await open.more(20, 2_000);
  expect(after.done, "the subscription must END, not keep serving the rotated bearer").toBe(true);
  // At most one keepalive can already have been queued before the check that
  // saw the rotation; nothing follows it.
  expect(after.frames.filter((f) => f.type === "keepalive").length).toBeLessThanOrEqual(1);
});

test("a bearer rotated while events are FLOWING closes the subscription too — traffic never postpones the check", async () => {
  // The re-check used to ride the keepalive, which goes out only when a poll
  // finds nothing. Here an event commits every few milliseconds, so no poll is
  // ever idle for a keepalive interval: under the old placement the rotated
  // bearer read on for as long as the traffic lasted.
  const rights = ["read_subjects", "read_sessions"] as const;
  const { token } = await provisionAutomationToken("rm_stream_rotated_busy", [...rights]);
  const head = await epoch.streamHeadSequence();
  const path = `/api/swarm/scheduler/subscribe?cursor=${head}`;
  let why = null as string | null; // assigned in a callback; the cast stops TS narrowing it to null
  const timing = {
    ...LOCKED,
    streamTiming: { keepaliveMs: 100, pollMs: 10, onEnd: (w: string) => void (why = w) },
  };
  let pumping = true;
  let pumped = 0;
  const pump = (async () => {
    while (pumping) {
      await sql.begin((tx) => epoch.appendStreamEvent(tx, "subject.changed", { payload: { reason: "pump", i: pumped } }));
      pumped += 1;
      await Bun.sleep(5);
    }
  })();
  try {
    const res = (await handleSchedulerStream(get(path, token), url(path), timing)) as Response;
    const open = await readFramesKeepOpen(res, 5);
    expect(open.frames.map((f) => f.type)).toEqual(["event", "event", "event", "event", "event"]);

    await provisionAutomationToken("rm_stream_rotated_busy", [...rights]); // the rotation
    const pumpedAtRotation = pumped;
    const after = await open.more(1_000_000, 3_000);
    expect(after.done, "the subscription must END while events are still flowing").toBe(true);
    expect(why).toBe("unauthorized");
    // It ended mid-traffic, not at an idle keepalive.
    expect(after.frames.filter((f) => f.type === "keepalive")).toEqual([]);
    expect(pumped).toBeGreaterThan(pumpedAtRotation);
  } finally {
    pumping = false;
    await pump;
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 overflow, behind the REAL server
// ─────────────────────────────────────────────────────────────────────────────

/** The body of a raw HTTP/1.1 response read off a socket: headers dropped, chunked encoding undone, a cut final chunk kept as far as it got. */
function dechunk(raw: string): string {
  const start = raw.indexOf("\r\n\r\n");
  if (start === -1) return "";
  let rest = raw.slice(start + 4);
  let body = "";
  for (;;) {
    const eol = rest.indexOf("\r\n");
    if (eol === -1) break;
    const size = parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size) || size === 0) break;
    body += rest.slice(eol + 2, eol + 2 + size);
    if (rest.length < eol + 2 + size + 2) break; // the connection was cut inside this chunk
    rest = rest.slice(eol + 2 + size + 2);
  }
  return body;
}

/** Every COMPLETE frame in an SSE body; a frame the cut left unfinished is not one. */
function completeFrames(body: string): Frame[] {
  const pieces = body.split("\n\n");
  pieces.pop(); // whatever follows the last terminator is unfinished (or empty)
  const frames: Frame[] = [];
  for (const raw of pieces) {
    const type = /^event: (.+)$/m.exec(raw)?.[1];
    const data = /^data: (.+)$/m.exec(raw)?.[1];
    if (type && data) frames.push({ type, data: JSON.parse(data) });
  }
  return frames;
}

test("BEHIND Bun.serve, a subscriber that stops reading is cut by the idle timeout, the loop ends, and nothing is skipped", async () => {
  // A child process opens a raw socket, sends the subscribe request and then
  // never reads. ~26 MB of events are waiting: more than the loopback socket
  // buffers hold, so its window closes and the server's writes stop making
  // progress. Bun.serve drains the body regardless (StreamOptions.bufferFrames),
  // so the only bound it honours is `idleTimeout`: it closes the connection,
  // the stream is cancelled, and the loop ends. The API server runs with the
  // 10 s default; this server uses 2 s so the case finishes in time.
  //
  // WHAT IT PROVES, AND WHAT NOT. The connection's memory is bounded by the
  // idle timeout and its loop stops; whatever the subscriber did receive is a
  // gapless prefix; a resubscribe from its last number gets the rest. It
  // does NOT deliver a `resync buffer_overflow` frame first — the peer is not
  // reading, and the server gives this code no signal to send one on.
  const { token } = await provisionAutomationToken("rm_stream_stalled", ["read_subjects", "read_sessions"]);
  const cursor = await epoch.streamHeadSequence();
  const N = 400;
  const big = "x".repeat(64 * 1024);
  await sql.begin(async (tx) => {
    for (let i = 0; i < N; i++) await epoch.appendStreamEvent(tx, "subject.changed", { payload: { reason: "flood", i, big } });
  });

  let why = null as string | null; // assigned in a callback; the cast stops TS narrowing it to null
  let endedAt = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 2,
    async fetch(req) {
      const u = new URL(req.url);
      const r = await handleSchedulerStream(req, u, {
        ...LOCKED,
        streamTiming: {
          keepaliveMs: 500,
          pollMs: 10,
          onEnd: (w) => {
            why = w;
            endedAt = Date.now();
          },
        },
      });
      if (r instanceof Response) return r;
      return Response.json(r?.body ?? { error: "not found" }, { status: r?.status ?? 404 });
    },
  });
  const pauseMs = 8_000;
  const client = Bun.spawn(
    [
      "bun",
      "-e",
      `import { connect } from "node:net";
       const chunks = [];
       const s = connect(${server.port}, "127.0.0.1", () => {
         s.write("GET /api/swarm/scheduler/subscribe?cursor=${cursor} HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: Bearer ${token}\\r\\n\\r\\n");
         s.pause();
         setTimeout(() => s.resume(), ${pauseMs});
       });
       s.on("data", (c) => chunks.push(c));
       const done = () => { process.stdout.write(Buffer.concat(chunks)); process.exit(0); };
       s.on("close", done);
       s.on("error", () => {});`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const startedAt = Date.now();
  try {
    for (let i = 0; i < 1_500 && why === null; i++) await Bun.sleep(10);
    expect(why, "the server must end the stalled connection").toBe("cancelled");
    expect(endedAt - startedAt, "it ended while the peer was still not reading").toBeLessThan(pauseMs);
    const raw = await new Response(client.stdout).text();
    await client.exited;
    const frames = completeFrames(dechunk(raw));
    const seqs = frames.filter((f) => f.type === "event").map((f) => f.data.seq as number);
    // A prefix, gapless from the cursor, and not the whole flood: it was cut.
    expect(seqs).toEqual(seqs.map((_, i) => cursor + 1 + i));
    expect(seqs.length).toBeLessThan(N);
    expect(frames.filter((f) => f.type === "resync")).toEqual([]);
    const last = seqs.length ? seqs[seqs.length - 1]! : cursor;
    const again = await readFrames(stream.openSchedulerStream(last, { keepaliveMs: 5_000, pollMs: 10 }), 1);
    expect(again[0]).toMatchObject({ type: "event", data: { seq: last + 1 } });
  } finally {
    client.kill("SIGKILL");
    server.stop(true);
  }
}, 30_000);

test("an event pruned from the MIDDLE while a connection is open is a resync `log_truncated` and a close, never a jump", async () => {
  // The mid-stream half of §6.3's "never silently skips": the connection has
  // served up to `cursor + 2`; then one owner transaction commits two numbers
  // and prunes the first, so the next poll finds `cursor + 4` where the
  // subscriber needs `cursor + 3`. Serving it would skip `cursor + 3`.
  const subjectId = await activeSubject("sub_mid_gap", 600);
  const cursor = await epoch.streamHeadSequence();
  for (const n of [1, 2]) {
    await sql.begin((tx) => epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", n } }));
  }
  const res = stream.openSchedulerStream(cursor, { keepaliveMs: 5_000, pollMs: 10 });
  const open = await readFramesKeepOpen(res, 2);
  expect(open.frames.map((f) => f.data.seq)).toEqual([cursor + 1, cursor + 2]);

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    const gone = await epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", n: 3 } });
    await epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", n: 4 } });
    await tx`DELETE FROM swarm_stream_events WHERE seq = ${gone}`;
  });
  const rest = await open.more(5, 2_000);
  expect(rest.done, "the connection must end").toBe(true);
  expect(rest.frames).toEqual([{ type: "resync", data: { reason: "log_truncated", head: cursor + 4 } }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 Retention — a pruned cursor is a resync. LAST IN THIS FILE ON PURPOSE:
// it commits a prune, and every case above reads a log that starts at 1.
// ─────────────────────────────────────────────────────────────────────────────

test("a subscription from a cursor rm_owner has pruned below is a resync and a close, never a skip to the floor", async () => {
  const subjectId = await activeSubject("sub_pruned", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  await epoch.turnOverEpoch(subjectId, opened.sessionId);
  const head = await epoch.streamHeadSequence();
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx`DELETE FROM swarm_stream_events WHERE seq <= ${head - 1}`;
  });
  expect(await stream.retainedFloor()).toBe(head);

  // Servable: the next event it needs (the floor) is still there.
  const served = await readFrames(stream.openSchedulerStream(head - 1, { keepaliveMs: 5_000, pollMs: 10 }), 1);
  expect(served[0]).toMatchObject({ type: "event", data: { seq: head } });

  // Not servable: `head - 1` is gone. One frame, the reason, then the end.
  const res = stream.openSchedulerStream(head - 2, { keepaliveMs: 20, pollMs: 10 });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  expect([...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(["resync"]);
  expect(text).toContain('"reason":"log_truncated"');
});

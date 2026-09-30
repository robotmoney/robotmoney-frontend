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
// THE SUBSCRIPTION IS A WEBSOCKET (D55 (11)). Every subscription case below
// runs over a real socket: a Bun.serve carrying the api's own upgrade and
// handler (routes/swarm-stream.ts), and at the end the api process itself.
// Frames are the JSON the API sends; closes carry SCHEDULER_STREAM_CLOSE.
//
// THE DIVISION IS NOT COSMETIC. §6.3's keepalive clause is the clearest case:
// the API's whole duty is to put the head sequence on the frame, and it can be
// asserted here exactly. Whether a scheduler behind that number rebuilds is
// something no server-side test can observe, so claiming it here would be
// overstating what the assertion proves.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import * as epoch from "../src/swarm/domain.ts";
import * as stream from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import {
  handleSchedulerStream,
  schedulerStreamWebSocket,
  upgradeSchedulerStream,
  type SchedulerStreamSocketData,
} from "../src/api/routes/swarm-stream.ts";
import { provisionAutomationToken } from "../src/db/automation-tokens.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";
import { inHouseJudge } from "./support/stub-judge.ts";
import { bootApi, writeTokenFile, type ApiProcess } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

// There is no env automation token and no insecure mode (D52 (1)): the
// provisioned per-instance token is the only thing that can authorize, so a
// rights assertion below means what it says.

const get = (path: string, token: string | null) =>
  new Request(`http://test${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

const post = (path: string, token: string | null, body: unknown) =>
  new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** One frame off the socket: the JSON the API sent, discriminated by `type`. */
interface Frame {
  type: string;
  [field: string]: any;
}

type Timing = NonNullable<Parameters<typeof upgradeSchedulerStream>[3]>["streamTiming"];

/**
 * A REAL server: `Bun.serve` carrying the api's own upgrade and WebSocket
 * handler (routes/swarm-stream.ts), with the connection timing a case needs.
 * The api's own server (backend/src/api/index.ts) passes no timing; the cases
 * that boot that process are at the end of this file.
 */
function streamServer(timing: Timing = {}) {
  const server = Bun.serve<SchedulerStreamSocketData, never>({
    port: 0,
    fetch: (req, srv) => upgradeSchedulerStream(req, new URL(req.url), srv, { streamTiming: timing }),
    websocket: schedulerStreamWebSocket,
  });
  return {
    ws: `ws://127.0.0.1:${server.port}`,
    http: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

interface Subscription {
  readonly frames: Frame[];
  /** Resolves with the close code and reason, whoever closed. */
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Wait until `n` frames have arrived, the socket closed, or the budget ran out; the frames so far. */
  next(n: number, budgetMs?: number): Promise<Frame[]>;
  /** Close from the subscriber's side. */
  end(): void;
}

/**
 * Subscribe from `cursor` over a real WebSocket, presenting `token` the one
 * way the API reads it: the upgrade's `Authorization: Bearer` header. Rejects
 * when the upgrade is refused (the socket closes before it opens).
 */
function subscribeWs(
  base: string,
  cursor: number,
  token: string | null,
  opts: { query?: string; headers?: Record<string, string> } = {},
): Promise<Subscription> {
  const frames: Frame[] = [];
  let closedResolve!: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => (closedResolve = r));
  let isClosed = false;
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers };
  const ws = new WebSocket(`${base}${ROUTES.swarm.scheduler.subscribe}?cursor=${cursor}${opts.query ?? ""}`, {
    headers,
  } as unknown as string[]);
  ws.onmessage = (e) => void frames.push(JSON.parse(String(e.data)) as Frame);
  return new Promise<Subscription>((resolve, reject) => {
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        frames,
        closed,
        async next(n, budgetMs = 5_000) {
          const deadline = Date.now() + budgetMs;
          while (frames.length < n && !isClosed && Date.now() < deadline) await Bun.sleep(5);
          return frames.slice();
        },
        end: () => ws.close(1000, "done"),
      });
    };
    ws.onclose = (e) => {
      isClosed = true;
      closedResolve({ code: e.code, reason: e.reason });
      if (!opened) reject(new Error(`upgrade refused (close ${e.code})`));
    };
  });
}

/** Read `want` frames from a fresh subscription, then close it. */
async function framesFrom(base: string, cursor: number, want: number, budgetMs = 5_000): Promise<Frame[]> {
  const sub = await subscribeWs(base, cursor, TOKEN);
  try {
    return (await sub.next(want, budgetMs)).slice(0, want);
  } finally {
    sub.end();
  }
}

/** A subscribe request as `upgradeSchedulerStream` sees it, and whether it was upgraded. */
async function upgradeAttempt(query: string, headers: Record<string, string>) {
  let upgraded = false;
  const req = new Request(`http://test${ROUTES.swarm.scheduler.subscribe}${query}`, {
    headers: { Upgrade: "websocket", Connection: "Upgrade", ...headers },
  });
  const res = await upgradeSchedulerStream(req, new URL(req.url), {
    upgrade: () => {
      upgraded = true;
      return true;
    },
  });
  return { upgraded, status: res?.status ?? 101, body: res ? await res.text() : "" };
}

// The scheduler's own token (holder `system-scheduler`, all three rights), as
// the stream admits it. Provisioned once; the rotation cases use their own.
let TOKEN = "";
beforeAll(async () => {
  TOKEN = (await provisionAutomationToken("rm_stream_ws", ["read_subjects", "read_sessions", "lifecycle_transitions"], { db: fixtureDb })).token;
});

/** A free loopback port, never :48787. */
function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => (port === 48787 ? reject(new Error("refusing :48787")) : resolve(port)));
    });
  });
}

// Two real servers every subscription case shares: keepalives every 20 ms,
// and keepalives that effectively never come.
let FAST: ReturnType<typeof streamServer>;
let QUIET: ReturnType<typeof streamServer>;
beforeAll(() => {
  FAST = streamServer({ keepaliveMs: 20, pollMs: 10 });
  QUIET = streamServer({ keepaliveMs: 5_000, pollMs: 10 });
});
afterAll(() => {
  FAST?.stop();
  QUIET?.stop();
});

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

test("a deactivated subject's open window, and then its unfinished settlement, are both in the full read", async () => {
  // §3 parts 2 and 3 (as corrected with D55 (4)): "Every session in
  // `collecting` … including one whose subject has since been deactivated",
  // and every closed-but-unpublished one, "including sessions whose subject
  // has since been deactivated; a window left open by a deactivation still
  // turns over at its boundary, and its settlement still has to finish."
  // Dropping either would strand the session — a window nobody closes, or a
  // `window_closed` epoch nobody settles.
  const subjectId = await activeSubject("fr_deactivated", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const [subject] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  const done = await admin.deactivateSubjectAdmin(subjectId, subject.version);
  expect(done.status).toBe(200);

  let read = await stream.fullRead();
  expect(read.subjects.some((s) => s.subjectId === subjectId)).toBe(false);
  expect(read.collecting.find((c) => c.sessionId === opened.sessionId)).toEqual({
    sessionId: opened.sessionId,
    subjectId,
    windowClosesAt: opened.windowClosesAt,
  });
  expect(read.settling.some((s) => s.sessionId === opened.sessionId)).toBe(false);

  // The boundary turnover closes it with no successor; now it is settling.
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  expect(turned.ok && turned.openedSessionId).toBeNull();
  read = await stream.fullRead();
  expect(read.collecting.some((c) => c.subjectId === subjectId)).toBe(false);
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
  await epoch.turnOverEpoch(subjectId, t.openedSessionId!);

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

test("the subscription sends ONE resync frame when it cannot serve the cursor, then closes with the resync code", async () => {
  // D55 (11): "an explicit close code". The frame names the reason; the close
  // code says it was a resync; nothing is served in between.
  const head = await epoch.streamHeadSequence();
  const sub = await subscribeWs(FAST.ws, head + 99, TOKEN);
  const closed = await sub.closed;
  expect(sub.frames).toEqual([{ type: "resync", reason: "cursor_ahead_of_head", head }]);
  expect(closed).toEqual({ code: stream.SCHEDULER_STREAM_CLOSE.resync, reason: "resync: cursor_ahead_of_head" });
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

  const frames = await framesFrom(QUIET.ws, cursor, 1);
  const events = frames.filter((f) => f.type === "event");
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0].seq).toBe(cursor + 1);
  expect(events[0].kind).toBe("epoch.turned_over");
});

test("an event committed WHILE the subscription is live is delivered on it", async () => {
  const subjectId = await activeSubject("sub_live", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const cursor = await epoch.streamHeadSequence();

  const sub = await subscribeWs(QUIET.ws, cursor, TOKEN);
  try {
    await epoch.turnOverEpoch(subjectId, opened.sessionId);
    const frames = await sub.next(1);
    expect(frames[0].type).toBe("event");
    expect(frames[0].kind).toBe("epoch.turned_over");
    expect(frames[0].seq).toBe(cursor + 1);
  } finally {
    sub.end();
  }
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

  const frames = await framesFrom(FAST.ws, head, 2);
  const keepalives = frames.filter((f) => f.type === "keepalive");
  expect(keepalives.length).toBeGreaterThanOrEqual(2);
  for (const k of keepalives) expect(k.head).toBe(head);
});

test("the keepalive's head moves with the log, so a quiet subscriber still learns the number", async () => {
  const subjectId = await activeSubject("sub_keepalive_moves", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const before = await epoch.streamHeadSequence();

  await framesFrom(FAST.ws, before, 1);
  await epoch.turnOverEpoch(subjectId, opened.sessionId);
  const after = await epoch.streamHeadSequence();
  expect(after).toBeGreaterThan(before);

  const frames = await framesFrom(FAST.ws, after, 1);
  expect(frames[0]).toEqual({ type: "keepalive", head: after });
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
  const { token } = await provisionAutomationToken("rm_no_job_ack", ["lifecycle_transitions"], { db: fixtureDb });
  // `null` is "not mine": the router answers it with its ordinary 404.
  expect(
    await handleSchedulerStream(
      post("/api/swarm/scheduler/jobs/ack", token, { idempotencyKey: "job_never_pushed" }),
      url("/api/swarm/scheduler/jobs/ack"),
    ),
  ).toBeNull();
});

test("a live subscription carries only event, keepalive and resync frames — never a job", async () => {
  const subjectId = await activeSubject("sub_frame_kinds", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const cursor = await epoch.streamHeadSequence();
  const sub = await subscribeWs(FAST.ws, cursor, TOKEN);
  try {
    await epoch.turnOverEpoch(subjectId, opened.sessionId);
    const frames = (await sub.next(4)).slice(0, 4);
    expect(frames.length).toBe(4);
    expect(frames.filter((f) => !["event", "keepalive", "resync"].includes(f.type))).toEqual([]);
    expect(frames.some((f) => f.type === "event" && f.kind === "epoch.turned_over")).toBe(true);
  } finally {
    sub.end();
  }
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

test("the COUNTER ROW numbers every event, not MAX(seq) + 1: with the whole log pruned, the next event continues from the head", async () => {
  // §6.3: "Each event takes its number by incrementing one counter row inside
  // the transaction that makes the change." Criterion 93 asked whether the
  // MAX + 1 wave 3 first built is equivalent; it is not, and this is the case
  // that tells them apart. rm_owner prunes EVERY row (its own transaction, on
  // this file's copy, rolled back), so MAX(seq) + 1 would restart at 1 and
  // hand a subscriber at the head numbers it has already applied — which it
  // would drop as duplicates. The counter row hands out head + 1.
  const subjectId = await activeSubject("seq_counter_row", 600);
  await sql.begin((tx) => epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe" } }));
  const head = await epoch.streamHeadSequence();
  await sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx`DELETE FROM swarm_stream_events`;
      const [{ max }] = await tx<{ max: string | null }[]>`SELECT MAX(seq) AS max FROM swarm_stream_events`;
      expect(max).toBeNull();
      const n = await epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "after prune" } });
      expect(n).toBe(head + 1);
      // RED CONTROL: what MAX + 1 would have handed out here.
      expect(Number(max ?? 0) + 1).not.toBe(n);
      const [row] = await tx<{ seq: string }[]>`SELECT seq FROM swarm_stream_head`;
      expect(Number(row!.seq)).toBe(head + 1);
      throw new Error("roll the prune back");
    })
    .catch((e: Error) => {
      if (e.message !== "roll the prune back") throw e;
    });
  expect(await epoch.streamHeadSequence()).toBe(head);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — the stream never claims the subscriber is current when it cannot say
// ─────────────────────────────────────────────────────────────────────────────

test("a cursor above the head is a resync and the socket CLOSES — no stream of nothing", async () => {
  const head = await epoch.streamHeadSequence();
  const sub = await subscribeWs(FAST.ws, head + 7, TOKEN);
  const closed = await sub.closed;
  expect(sub.frames.map((f) => f.type)).toEqual(["resync"]);
  expect(sub.frames[0].reason).toBe("cursor_ahead_of_head");
  expect(closed.code).toBe(stream.SCHEDULER_STREAM_CLOSE.resync);
});

test("a database error ends the socket with resync `unavailable`, never a keepalive with a guessed head", async () => {
  // The code this replaces answered a failed head read with the connection's
  // own `sent` number — a keepalive that told a subscriber behind the real
  // head that it was current. The counter row is made unreadable for the
  // length of the case and restored in `finally`.
  const head = await epoch.streamHeadSequence();
  const sub = await subscribeWs(FAST.ws, head, TOKEN);
  const first = await sub.next(1);
  expect(first[0]).toEqual({ type: "keepalive", head });
  await fixtureDb`ALTER TABLE swarm_stream_head RENAME TO swarm_stream_head_hidden`;
  try {
    const closed = await Promise.race([sub.closed, Bun.sleep(3_000).then(() => null)]);
    expect(closed, "the socket must close").not.toBeNull();
    expect(closed!.code).toBe(stream.SCHEDULER_STREAM_CLOSE.resync);
    const last = sub.frames[sub.frames.length - 1]!;
    expect(last).toEqual({ type: "resync", reason: "unavailable", head: null });
    // A keepalive queued before the rename carries the real head; none carries
    // a stand-in, and nothing follows the resync.
    for (const f of sub.frames.slice(0, -1)) expect(f).toEqual({ type: "keepalive", head });
  } finally {
    await fixtureDb`ALTER TABLE swarm_stream_head_hidden RENAME TO swarm_stream_head`;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 / criterion 92 — killed after commit, still found
// ─────────────────────────────────────────────────────────────────────────────

test("SUBSCRIBER HALF: a turnover committed and never delivered — its socket closed — is served to a resubscribe from the old cursor", async () => {
  // "Each event row and its global sequence are written in the same
  // transaction as the transition ... proved ... by killing a publisher after
  // commit and still finding it." The event's durability is the commit's, not
  // the connection's: nothing the dead connection did or did not send decides
  // whether a later subscriber sees it.
  const subjectId = await activeSubject("sub_killed", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const cursor = await epoch.streamHeadSequence();

  const doomed = await subscribeWs(QUIET.ws, cursor, TOKEN);
  doomed.end();
  await doomed.closed;
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");

  const frames = await framesFrom(QUIET.ws, cursor, 1);
  expect(frames[0].type).toBe("event");
  expect(frames[0].seq).toBe(cursor + 1);
  expect(frames[0].kind).toBe("epoch.turned_over");
  expect(frames[0].payload.closedSessionId).toBe(opened.sessionId);
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
// The trigger holds a transaction-level advisory lock while it sleeps, and the probe
// reads pg_locks: the runtime pool acts as rm_app, which may not see another login's
// wait_event in pg_stat_activity (a different session user), but pg_locks is open.
async function killedInsideCommit(table: string, code: string): Promise<{ stdout: string }> {
  await fixtureDb.unsafe(`
    CREATE FUNCTION rm_test_sleep_at_commit() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN PERFORM pg_advisory_xact_lock(9182731); PERFORM pg_sleep(1.5); RETURN NULL; END $t$;
    CREATE CONSTRAINT TRIGGER rm_test_sleep_at_commit AFTER INSERT ON ${table}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rm_test_sleep_at_commit();`);
  const sleeping = async (): Promise<number> =>
    Number(
      ((await sql`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND objid = 9182731 AND granted AND pid <> pg_backend_pid()`) as unknown as {
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
    await fixtureDb.unsafe(`DROP TRIGGER IF EXISTS rm_test_sleep_at_commit ON ${table};
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
  const frames = await framesFrom(QUIET.ws, head, 1);
  expect(frames[0]).toMatchObject({ type: "event", seq: head + 1, kind: "epoch.turned_over" });
});

test("RED CONTROL for the publisher kill: an event written AFTER the commit is lost under the same kill", async () => {
  // The same harness on a writer built the wrong way: its state change commits
  // in one transaction and its event would be appended in a second one after
  // it. Killed inside the first COMMIT, the state change stands and the event
  // never exists — which is exactly what the case above would see if the
  // turnover published after committing.
  await fixtureDb.unsafe("CREATE TABLE rm_test_kill_marker (id int PRIMARY KEY)");
  await fixtureDb.unsafe("GRANT SELECT, INSERT ON rm_test_kill_marker TO rm_app");
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
    await fixtureDb.unsafe("DROP TABLE rm_test_kill_marker");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication (scheduler spec §7, smoke spec §3)
// ─────────────────────────────────────────────────────────────────────────────

test("the full read needs read_subjects AND read_sessions, and the scheduler's token has both", async () => {
  const { token } = await provisionAutomationToken("rm_stream_reader", ["read_subjects", "read_sessions"], { db: fixtureDb });
  const ok = await handleSchedulerStream(get("/api/swarm/scheduler/full-read", token), url("/api/swarm/scheduler/full-read"));
  expect((ok as { status: number }).status).toBe(200);

  const { token: partial } = await provisionAutomationToken("rm_stream_partial", ["read_subjects"], { db: fixtureDb });
  const refused = await handleSchedulerStream(
    get("/api/swarm/scheduler/full-read", partial),
    url("/api/swarm/scheduler/full-read"),
  );
  expect((refused as { status: number }).status).toBe(403);
});

test("an unknown bearer reads nothing from the stream", async () => {
  const refused = await handleSchedulerStream(
    get("/api/swarm/scheduler/full-read", "rmat_forged"),
    url("/api/swarm/scheduler/full-read"),
  );
  expect((refused as { status: number }).status).toBe(403);
});

test("the analytics producer's and the operator's tokens read nothing from the stream — rights are per holder", async () => {
  // Smoke spec §3: the scheduler's rights are "read subjects and sessions,
  // perform lifecycle transitions"; the other two holders on the SAME instance
  // hold only their own (migration 0078). A valid, store-issued token of the
  // wrong holder is refused exactly like a forged one.
  const producer = await provisionAutomationToken("rm_stream_holders", ["analytics_ingestion"], {
    db: fixtureDb, holder: "analytics-producer",
  });
  const operator = await provisionAutomationToken("rm_stream_holders", ["admin"], { db: fixtureDb, holder: "operator" });
  for (const token of [producer.token, operator.token]) {
    const refused = await handleSchedulerStream(
      get("/api/swarm/scheduler/full-read", token),
      url("/api/swarm/scheduler/full-read"),
    );
    expect((refused as { status: number }).status).toBe(403);
  }
});

test("a token rotated while the subscription is open closes the socket at the next keepalive, with the token-revoked code", async () => {
  // Smoke spec §3: provisioning a holder's token again REPLACES the row's hash,
  // so the old bearer authorizes nothing from that instant — including a
  // socket it opened before the rotation. D55 (11): "The socket re-authorizes
  // the scheduler's token against the token store at every keepalive. It
  // closes when the token is revoked or rotated."
  const rights = ["read_subjects", "read_sessions"] as const;
  const { token } = await provisionAutomationToken("rm_stream_rotated", [...rights], { db: fixtureDb });
  const head = await epoch.streamHeadSequence();

  // Control: an unrotated token is served keepalive after keepalive.
  const kept = await subscribeWs(FAST.ws, head, token);
  const steady = (await kept.next(4, 2_000)).slice(0, 4);
  kept.end();
  expect(steady.map((f) => f.type)).toEqual(["keepalive", "keepalive", "keepalive", "keepalive"]);

  const sub = await subscribeWs(FAST.ws, head, token);
  expect((await sub.next(1)).map((f) => f.type)).toEqual(["keepalive"]);
  const before = sub.frames.length;
  await provisionAutomationToken("rm_stream_rotated", [...rights], { db: fixtureDb }); // the rotation
  const closed = await Promise.race([sub.closed, Bun.sleep(2_000).then(() => null)]);
  expect(closed, "the socket must CLOSE, not keep serving the rotated token").toEqual({
    code: stream.SCHEDULER_STREAM_CLOSE.tokenRevoked,
    reason: "token revoked or rotated",
  });
  // At most one keepalive can already have been queued before the check that
  // saw the rotation; nothing follows it, and no resync frame is sent.
  const after = sub.frames.slice(before);
  expect(after.filter((f) => f.type === "keepalive").length).toBeLessThanOrEqual(1);
  expect(after.filter((f) => f.type !== "keepalive")).toEqual([]);
});

test("a token REVOKED while the subscription is open closes the socket at the next keepalive", async () => {
  // Revocation removes the token's row (rm_owner, on this file's own copy:
  // no runtime role may delete, D55 (6)). The next re-check finds no grant.
  const { token } = await provisionAutomationToken("rm_stream_revoked", ["read_subjects", "read_sessions"], { db: fixtureDb });
  const head = await epoch.streamHeadSequence();
  const sub = await subscribeWs(FAST.ws, head, token);
  await sub.next(1);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx`DELETE FROM automation_tokens WHERE instance = 'rm_stream_revoked'`;
  });
  const closed = await Promise.race([sub.closed, Bun.sleep(2_000).then(() => null)]);
  expect(closed?.code).toBe(stream.SCHEDULER_STREAM_CLOSE.tokenRevoked);
});

test("a token rotated while events are FLOWING closes the socket too — traffic never postpones the check", async () => {
  // The re-check used to ride the keepalive, which goes out only when a poll
  // finds nothing. Here an event commits every few milliseconds, so no poll is
  // ever idle for a keepalive interval: under the old placement the rotated
  // token read on for as long as the traffic lasted.
  const rights = ["read_subjects", "read_sessions"] as const;
  const { token } = await provisionAutomationToken("rm_stream_rotated_busy", [...rights], { db: fixtureDb });
  const head = await epoch.streamHeadSequence();
  let why = null as string | null; // assigned in a callback; the cast stops TS narrowing it to null
  const server = streamServer({ keepaliveMs: 100, pollMs: 10, onEnd: (w) => void (why = w) });
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
    const sub = await subscribeWs(server.ws, head, token);
    const open = (await sub.next(5)).slice(0, 5);
    expect(open.map((f) => f.type)).toEqual(["event", "event", "event", "event", "event"]);

    const at = sub.frames.length;
    await provisionAutomationToken("rm_stream_rotated_busy", [...rights], { db: fixtureDb }); // the rotation
    const pumpedAtRotation = pumped;
    const closed = await Promise.race([sub.closed, Bun.sleep(3_000).then(() => null)]);
    expect(closed?.code, "the socket must CLOSE while events are still flowing").toBe(stream.SCHEDULER_STREAM_CLOSE.tokenRevoked);
    expect(why).toBe("unauthorized");
    // It ended mid-traffic, not at an idle keepalive.
    expect(sub.frames.slice(at).filter((f) => f.type === "keepalive")).toEqual([]);
    expect(pumped).toBeGreaterThan(pumpedAtRotation);
  } finally {
    pumping = false;
    await pump;
    server.stop();
  }
});

test("the route serves the same four parts and cursor the module does", async () => {
  const { token } = await provisionAutomationToken("rm_stream_route", ["read_subjects", "read_sessions"], { db: fixtureDb });
  const res = (await handleSchedulerStream(
    get("/api/swarm/scheduler/full-read", token),
    url("/api/swarm/scheduler/full-read"),
  )) as { status: number; body: any };
  expect(res.status).toBe(200);
  expect(Object.keys(res.body).sort()).toEqual(["collecting", "cursor", "settling", "subjects"]);
  expect(typeof res.body.cursor).toBe("number");
});

// ─────────────────────────────────────────────────────────────────────────────
// D55 (11) — a WebSocket, and the token only in the upgrade's Authorization header
// ─────────────────────────────────────────────────────────────────────────────

test("the subscribe route is a WebSocket: a plain GET is 426, and an upgrade opens a socket", async () => {
  const head = await epoch.streamHeadSequence();
  const path = `/api/swarm/scheduler/subscribe?cursor=${head}`;
  const plain = await handleSchedulerStream(get(path, TOKEN), url(path));
  expect(plain).toBeInstanceOf(Response);
  expect((plain as Response).status).toBe(426);
  expect((plain as Response).headers.get("Upgrade")).toBe("websocket");
  expect((await upgradeAttempt(`?cursor=${head}`, { Authorization: `Bearer ${TOKEN}` })).upgraded).toBe(true);
  const sub = await subscribeWs(FAST.ws, head, TOKEN);
  expect((await sub.next(1))[0]).toEqual({ type: "keepalive", head });
  sub.end();
});

test("the token travels ONLY in the upgrade's Authorization header: a token in the URL, or in any other header, is refused and nothing is upgraded", async () => {
  const head = await epoch.streamHeadSequence();
  const auth = { Authorization: `Bearer ${TOKEN}` };
  // Control: the same request with the header and a clean URL is upgraded, so
  // each refusal below is about the one thing that differs.
  expect(await upgradeAttempt(`?cursor=${head}`, auth)).toMatchObject({ upgraded: true, status: 101 });

  // A token in the query string is refused before it is looked up — with the
  // header present too, and under any parameter name.
  for (const q of [`&token=${TOKEN}`, `&access_token=${TOKEN}`, `&automation_token=${TOKEN}`, `&auth=${TOKEN}`]) {
    const r = await upgradeAttempt(`?cursor=${head}${q}`, auth);
    expect({ q, upgraded: r.upgraded, status: r.status }).toEqual({ q, upgraded: false, status: 400 });
    expect(r.body).toContain("Authorization header");
    expect(r.body).not.toContain(TOKEN);
  }
  expect(await upgradeAttempt(`?cursor=${head}&token=${TOKEN}`, {})).toMatchObject({ upgraded: false, status: 400 });

  // The HTTP calls' header does not open the socket; neither does no header.
  expect(await upgradeAttempt(`?cursor=${head}`, { "X-Automation-Token": TOKEN })).toMatchObject({ upgraded: false, status: 401 });
  expect(await upgradeAttempt(`?cursor=${head}`, {})).toMatchObject({ upgraded: false, status: 401 });

  // Over a real socket: a client that puts the token in the URL never opens one.
  await expect(subscribeWs(FAST.ws, head, null, { query: `&token=${TOKEN}` })).rejects.toThrow("upgrade refused");
  await expect(subscribeWs(FAST.ws, head, null, { headers: { "X-Automation-Token": TOKEN } })).rejects.toThrow("upgrade refused");
});

test("only the scheduler's own token with both read rights opens the socket: forged, other holders' and narrowed tokens are 403", async () => {
  const head = await epoch.streamHeadSequence();
  const producer = await provisionAutomationToken("rm_stream_holders_ws", ["analytics_ingestion"], { db: fixtureDb, holder: "analytics-producer" });
  const operator = await provisionAutomationToken("rm_stream_holders_ws", ["admin"], { db: fixtureDb, holder: "operator" });
  const narrowed = await provisionAutomationToken("rm_stream_narrow_ws", ["read_subjects"], { db: fixtureDb });
  for (const token of ["rmat_forged", producer.token, operator.token, narrowed.token]) {
    const r = await upgradeAttempt(`?cursor=${head}`, { Authorization: `Bearer ${token}` });
    expect({ upgraded: r.upgraded, status: r.status }).toEqual({ upgraded: false, status: 403 });
  }
  // And a missing or malformed cursor is 400, after the credential.
  expect(await upgradeAttempt(`?cursor=`, { Authorization: `Bearer ${TOKEN}` })).toMatchObject({ upgraded: false, status: 400 });
  expect(await upgradeAttempt(`?cursor=-1`, { Authorization: `Bearer ${TOKEN}` })).toMatchObject({ upgraded: false, status: 400 });
});

test("the stream routes own only their own paths", async () => {
  expect(await handleSchedulerStream(get("/api/swarm/members", null), url("/api/swarm/members"))).toBeNull();
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
// §6.3 overflow, behind a REAL socket: resync, then close — never a silent skip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A client in its OWN process that opens the socket, prints `open`, and then —
 * once the parent has SIGSTOPped it and let it go again — reads everything and
 * prints what it got: the event numbers, every non-event frame, and the close.
 * A stopped process reads nothing, so the loopback buffers fill and the
 * server's backlog grows: a subscriber that stopped reading, for real.
 */
function stalledClient(wsBase: string, cursor: number, token: string) {
  return Bun.spawn(
    [
      "bun",
      "-e",
      `const ws = new WebSocket(${JSON.stringify(`${wsBase}${ROUTES.swarm.scheduler.subscribe}?cursor=${cursor}`)},
         { headers: { Authorization: ${JSON.stringify(`Bearer ${token}`)} } });
       const seqs = []; const other = [];
       ws.onopen = () => console.error("open");
       ws.onmessage = (e) => { const f = JSON.parse(e.data); if (f.type === "event") seqs.push(f.seq); else other.push(f); };
       ws.onclose = (e) => { console.log(JSON.stringify({ seqs, other, code: e.code, reason: e.reason })); process.exit(0); };`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}

async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string, budgetMs = 15_000): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + budgetMs;
  try {
    while (!text.includes(needle)) {
      const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
      if (next === null || next.done) throw new Error(`never saw ${JSON.stringify(needle)}; got: ${text}`);
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** ~26 MB of events, more than the loopback buffers hold. */
async function flood(n = 400): Promise<void> {
  const big = "x".repeat(64 * 1024);
  await sql.begin(async (tx) => {
    for (let i = 0; i < n; i++) await epoch.appendStreamEvent(tx, "subject.changed", { payload: { reason: "flood", i, big } });
  });
}

test("a subscriber that STOPS READING gets every frame it was sent, gapless, then ONE resync `buffer_overflow`, then the resync close", async () => {
  // D55 (11): "When a subscriber stops reading, the API sends one `resync`
  // frame and closes the socket. It never drops an event to make room." The
  // SSE body this replaced gave the server no backpressure signal, so a
  // stalled subscriber was cut by the idle timeout with no reason sent; the
  // socket reports its backlog, and this is the proof the API acts on it.
  const cursor = await epoch.streamHeadSequence();
  let why = null as string | null; // assigned in a callback
  const server = streamServer({ keepaliveMs: 5_000, pollMs: 10, bufferBytes: 256 * 1024, onEnd: (w) => void (why = w) });
  const client = stalledClient(server.ws, cursor, TOKEN);
  try {
    await waitForLine(client.stderr as ReadableStream<Uint8Array>, "open");
    process.kill(client.pid, "SIGSTOP");
    await flood();
    for (let i = 0; i < 1_500 && why === null; i++) await Bun.sleep(10);
    expect(why, "the server must end the stalled socket, while the client is still stopped").toBe("buffer_overflow");
    process.kill(client.pid, "SIGCONT");
    const got = JSON.parse(await new Response(client.stdout).text()) as {
      seqs: number[];
      other: Frame[];
      code: number;
      reason: string;
    };
    // A prefix, gapless from the cursor, cut short of the flood …
    expect(got.seqs.length).toBeGreaterThan(0);
    expect(got.seqs).toEqual(got.seqs.map((_, i) => cursor + 1 + i));
    expect(got.seqs.length).toBeLessThan(400);
    // … then the reason, once, then the close that names it.
    expect(got.other.map((f) => [f.type, f.reason])).toEqual([["resync", "buffer_overflow"]]);
    expect({ code: got.code, reason: got.reason }).toEqual({
      code: stream.SCHEDULER_STREAM_CLOSE.resync,
      reason: "resync: buffer_overflow",
    });
    // Nothing was skipped: a resubscribe from the last number it applied gets the next one.
    const last = got.seqs[got.seqs.length - 1]!;
    expect((await framesFrom(QUIET.ws, last, 1))[0]).toMatchObject({ type: "event", seq: last + 1 });
  } finally {
    client.kill("SIGKILL");
    server.stop();
  }
}, 60_000);

/**
 * A server whose sink IGNORES Bun's own backpressure signal (`send` returning
 * -1), so the ONLY thing that can end a stalled socket is the backlog bound.
 * The serving loop has two triggers for `buffer_overflow`: the bound, and a
 * send the socket reports as queued. On a real socket the second fires as soon
 * as the kernel's loopback buffers fill, and how much they hold differs by
 * kernel and by moment (a dev machine absorbs the 2.6 MB a red control floods;
 * a GitHub runner does not). A control that leaves it live tests the machine.
 */
function streamServerBoundOnly(bufferBytes: number, onEnd: (why: string) => void) {
  const server = Bun.serve<SchedulerStreamSocketData, never>({
    port: 0,
    fetch: (req, srv) => upgradeSchedulerStream(req, new URL(req.url), srv, { streamTiming: {} }),
    websocket: {
      ...schedulerStreamWebSocket,
      open(ws) {
        const sink: stream.StreamSink = {
          send: (text) => (ws.send(text) === 0 ? "closed" : "sent"),
          bufferedAmount: () => ws.getBufferedAmount(),
          close: (code, reason) => ws.close(code, reason),
        };
        ws.data.handle = stream.serveSchedulerStream(ws.data.cursor, sink, { keepaliveMs: 5_000, pollMs: 10, bufferBytes, onEnd });
      },
    },
  });
  return { ws: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Wait, up to `budgetMs`, until an ordinary subscriber sees event `seq`: the flood is readable from the log. */
async function logServes(seq: number, budgetMs = 30_000): Promise<void> {
  const sub = await subscribeWs(FAST.ws, seq - 1, TOKEN);
  try {
    const deadline = Date.now() + budgetMs;
    while (!sub.frames.some((f) => f.type === "event" && f.seq >= seq) && Date.now() < deadline) await Bun.sleep(20);
    expect(sub.frames.some((f) => f.type === "event" && f.seq >= seq), `the log never served event ${seq}`).toBe(true);
  } finally {
    sub.end();
  }
}

test("RED CONTROL: with the backlog bound unread, the same stalled subscriber is never told — no resync, just a longer silence", async () => {
  // The bound is what makes the API act. Put it out of reach and the stalled
  // socket is not ended for overflow while the flood sits queued: the
  // subscriber that stopped reading gets no reason, which is the SSE behaviour
  // D55 (11) replaced. Both halves run on a sink that ignores Bun's -1, so
  // neither depends on how much the kernel buffers: with the bound at 256 KiB
  // the flood ends the socket (the bound acts, alone); with it out of reach
  // the same flood, the same stop, ends nothing.
  const run = async (bufferBytes: number, n: number, settle: (why: () => string | null) => Promise<void>) => {
    const cursor = await epoch.streamHeadSequence();
    let why = null as string | null;
    const server = streamServerBoundOnly(bufferBytes, (w) => void (why = w));
    const client = stalledClient(server.ws, cursor, TOKEN);
    try {
      await waitForLine(client.stderr as ReadableStream<Uint8Array>, "open");
      process.kill(client.pid, "SIGSTOP");
      await flood(n);
      await logServes(cursor + n);
      await settle(() => why);
      return why;
    } finally {
      client.kill("SIGKILL");
      server.stop();
    }
  };
  // The bound in reach: the stalled socket is ended, with its reason.
  const bounded = await run(256 * 1024, 400, async (why) => {
    for (let i = 0; i < 1_500 && why() === null; i++) await Bun.sleep(10);
  });
  expect(bounded, "with the bound in reach the stalled socket must be ended for overflow").toBe("buffer_overflow");
  // The bound out of reach: nothing ends it, however long we look. 40 x 64 KiB
  // stays far under Bun's own 16 MiB outbound limit.
  const unread = await run(Number.MAX_SAFE_INTEGER, 40, () => Bun.sleep(1_500));
  expect(unread, "with the bound unread the stalled socket is never ended for overflow").toBeNull();
}, 90_000);

test("an event pruned from the MIDDLE while a socket is open is a resync `log_truncated` and a close, never a jump", async () => {
  // The mid-stream half of §6.3's "never silently skips": the socket has
  // served up to `cursor + 2`; then one owner transaction commits two numbers
  // and prunes the first, so the next poll finds `cursor + 4` where the
  // subscriber needs `cursor + 3`. Serving it would skip `cursor + 3`.
  const subjectId = await activeSubject("sub_mid_gap", 600);
  const cursor = await epoch.streamHeadSequence();
  for (const n of [1, 2]) {
    await sql.begin((tx) => epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", n } }));
  }
  const sub = await subscribeWs(QUIET.ws, cursor, TOKEN);
  expect((await sub.next(2)).map((f) => f.seq)).toEqual([cursor + 1, cursor + 2]);

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    const gone = await epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", n: 3 } });
    await epoch.appendStreamEvent(tx, "subject.changed", { subjectId, payload: { reason: "probe", n: 4 } });
    await tx`DELETE FROM swarm_stream_events WHERE seq = ${gone}`;
  });
  const closed = await Promise.race([sub.closed, Bun.sleep(2_000).then(() => null)]);
  expect(closed?.code, "the socket must close").toBe(stream.SCHEDULER_STREAM_CLOSE.resync);
  expect(sub.frames.slice(2)).toEqual([{ type: "resync", reason: "log_truncated", head: cursor + 4 }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REAL api PROCESS — `bun run src/api/index.ts`, what the compose api runs
// ─────────────────────────────────────────────────────────────────────────────
//
// The cases above drive the api's own upgrade and handler on a Bun.serve of
// this file's. These boot the api itself, with its own defaults (keepalive
// 5 s, backlog bound 1 MiB), and prove the three D55 (11) rules the spec's
// "Socket authorization" gate names on the process that serves them: the
// header-only rule, re-authorization at the keepalive, and resync-and-close
// for a subscriber that stopped reading — followed by a REAL system-scheduler
// process rebuilding from it.

/** The status line a raw upgrade request gets from `api`, read off a TCP socket. */
async function rawUpgradeStatus(base: string, pathAndQuery: string, headers: Record<string, string>): Promise<number> {
  const { port } = new URL(base);
  const lines = [
    `GET ${pathAndQuery} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ];
  return await new Promise<number>((resolve, reject) => {
    let text = "";
    const s = connect(Number(port), "127.0.0.1", () => s.write(lines.join("\r\n")));
    s.on("data", (c) => {
      text += c.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (m) {
        s.destroy();
        resolve(Number(m[1]));
      }
    });
    s.on("error", reject);
    setTimeout(() => {
      s.destroy();
      reject(new Error(`no status line: ${text}`));
    }, 10_000);
  });
}

describe("the real api process", () => {
  let api: ApiProcess;
  beforeAll(async () => {
    api = await bootApi({ env: { RM_ENV: "ephemeral" } });
  }, 90_000);
  afterAll(() => api?.stop());

  test("HEADER ONLY: the api upgrades on the Authorization header, and refuses a token in the URL or in X-Automation-Token", async () => {
    const head = await epoch.streamHeadSequence();
    const path = `${ROUTES.swarm.scheduler.subscribe}?cursor=${head}`;
    expect(await rawUpgradeStatus(api.base, path, { Authorization: `Bearer ${TOKEN}` })).toBe(101);
    expect(await rawUpgradeStatus(api.base, `${path}&token=${TOKEN}`, { Authorization: `Bearer ${TOKEN}` })).toBe(400);
    expect(await rawUpgradeStatus(api.base, `${path}&token=${TOKEN}`, {})).toBe(400);
    expect(await rawUpgradeStatus(api.base, path, { "X-Automation-Token": TOKEN })).toBe(401);
    expect(await rawUpgradeStatus(api.base, path, { Authorization: "Bearer rmat_forged" })).toBe(403);
    // And a plain GET, no upgrade, is 426.
    const plain = await fetch(`${api.base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(plain.status).toBe(426);
    // A real WebSocket client with the header is served the head.
    const sub = await subscribeWs(api.base.replace(/^http/, "ws"), head, TOKEN);
    try {
      const [first] = await sub.next(1, 8_000);
      expect(first).toMatchObject({ type: "keepalive" });
    } finally {
      sub.end();
    }
  }, 30_000);

  test("REVOKED AT THE KEEPALIVE: the api closes an open socket with the token-revoked code once the token's row is gone", async () => {
    const { token } = await provisionAutomationToken("rm_stream_api_revoked", ["read_subjects", "read_sessions"], { db: fixtureDb });
    const head = await epoch.streamHeadSequence();
    const sub = await subscribeWs(api.base.replace(/^http/, "ws"), head, token);
    expect((await sub.next(1, 8_000))[0]).toMatchObject({ type: "keepalive", head });
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx`DELETE FROM automation_tokens WHERE instance = 'rm_stream_api_revoked'`;
    });
    const closed = await Promise.race([sub.closed, Bun.sleep(8_000).then(() => null)]);
    expect(closed).toEqual({ code: stream.SCHEDULER_STREAM_CLOSE.tokenRevoked, reason: "token revoked or rotated" });
  }, 30_000);

  test("OVERFLOW ON THE api: a client process that stops reading gets its frames, one resync and the close; a real system-scheduler that stopped reading rebuilds from it", async () => {
    // (1) A bare client.
    const cursor = await epoch.streamHeadSequence();
    const wsBase = api.base.replace(/^http/, "ws");
    const client = stalledClient(wsBase, cursor, TOKEN);
    try {
      await waitForLine(client.stderr as ReadableStream<Uint8Array>, "open");
      process.kill(client.pid, "SIGSTOP");
      await flood();
      await Bun.sleep(4_000);
      process.kill(client.pid, "SIGCONT");
      const got = JSON.parse(await new Response(client.stdout).text()) as { seqs: number[]; other: Frame[]; code: number };
      expect(got.seqs.length).toBeGreaterThan(0);
      expect(got.seqs).toEqual(got.seqs.map((_, i) => cursor + 1 + i));
      expect(got.seqs.length).toBeLessThan(400);
      const seen = `got ${got.seqs.length} events, close ${got.code}, frames ${JSON.stringify(got.other.slice(-3))}`;
      expect(got.other.filter((f) => f.type === "resync").map((f) => f.reason), seen).toEqual(["buffer_overflow"]);
      expect(got.other[got.other.length - 1]!.type, seen).toBe("resync");
      expect(got.code, seen).toBe(stream.SCHEDULER_STREAM_CLOSE.resync);
    } finally {
      client.kill("SIGKILL");
    }

    // (2) The real scheduler, its socket open against the same api, stopped
    // while the log floods, then let go: it reads what it was sent, the
    // resync, and rebuilds (§3.1) — the trigger is the API's resync.
    const healthPort = await freeTcpPort();
    const scheduler = Bun.spawn(["bun", "scripts/system-scheduler.ts"], {
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        SCHEDULER_API_URL: api.base,
        SCHEDULER_TOKEN_FILE: writeTokenFile(TOKEN),
        SCHEDULER_HEALTH_PORT: String(healthPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out: string[] = [];
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of scheduler.stdout as ReadableStream<Uint8Array>) out.push(dec.decode(chunk));
    })();
    const saw = async (needle: string, budgetMs: number) => {
      const deadline = Date.now() + budgetMs;
      while (!out.join("").includes(needle) && Date.now() < deadline) await Bun.sleep(50);
      return out.join("").includes(needle);
    };
    try {
      expect(await saw("clock running", 20_000)).toBe(true);
      process.kill(scheduler.pid, "SIGSTOP");
      await flood();
      await Bun.sleep(4_000);
      process.kill(scheduler.pid, "SIGCONT");
      expect(await saw("rebuild (resync)", 30_000), out.join("")).toBe(true);
      // Healthy again on the rebuilt copy.
      let healthy = false;
      for (let i = 0; i < 100 && !healthy; i++) {
        healthy = await fetch(`http://127.0.0.1:${healthPort}/health`).then((r) => r.ok, () => false);
        if (!healthy) await Bun.sleep(100);
      }
      expect(healthy).toBe(true);
    } finally {
      scheduler.kill("SIGKILL");
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 Retention — a pruned cursor is a resync. LAST IN THIS FILE ON PURPOSE:
// it commits a prune, and every case above reads a log that starts at 1.
// ─────────────────────────────────────────────────────────────────────────────

test("a subscription from a cursor rm_owner has pruned below is a resync `log_truncated` and a close, never a skip to the floor", async () => {
  // D55 (12): the log is pruned only by the manual, receipted `bun run prune`
  // (rm_owner), and "a scheduler cursor below the retained floor gets
  // resync-and-close (`log_truncated`)". The prune here is that command's
  // DELETE, run as rm_owner on this file's copy.
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
  const served = await framesFrom(QUIET.ws, head - 1, 1);
  expect(served[0]).toMatchObject({ type: "event", seq: head });

  // Not servable: `head - 1` is gone. One frame, the reason, then the close.
  const sub = await subscribeWs(FAST.ws, head - 2, TOKEN);
  const closed = await sub.closed;
  expect(sub.frames).toEqual([{ type: "resync", reason: "log_truncated", head }]);
  expect(closed.code).toBe(stream.SCHEDULER_STREAM_CLOSE.resync);
});

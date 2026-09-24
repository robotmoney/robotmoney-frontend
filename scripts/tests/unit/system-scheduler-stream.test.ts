// W4.4, consumer half — the clock's side of the stream contract (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3.1, §3.2 and §6.3.
//
//   §3.1: "The clock's copy of the world is current if and only if: its stream
//    connection is live, and it has applied every event with a sequence number
//    above its full read's cursor, in order, with no gap. When both hold, it
//    acts. When either fails, it stops acting, performs a full read, rebuilds
//    every timer, and resumes. There is no third state."
//
// WHY THIS IS A SEPARATE FILE FROM backend/tests/api-event-stream.test.ts. The
// API's duty is to SERVE correctly; the scheduler's is to DETECT that it was
// not served everything and refuse to act until it has rebuilt. No server-side
// test can observe the second, because the failures it must survive — a
// dropped frame, a stalled socket — happen at the hop between them. So the
// consumer is exercised here against a FAKE API that can be made to misbehave
// in exactly the ways §6.3 names. The fake counts calls, which is how the
// "zero API calls between instants" gate is asserted at all.
//
// The later sections go one step further and run `SchedulerRuntime` — the
// wiring the container itself runs — over the shared fake API with its stream
// modelled as sockets, so the consumer and the clock are tested TOGETHER on
// fake timers: a boundary that falls while the copy is stale must not fire.
//
// WHAT THIS FILE DOES NOT PROVE. It does not prove the real API emits these
// frames — that is the backend file's job — and it proves nothing about a
// real socket beyond the HTTP transport's own subscribe, driven here through
// an injected fetch. Everything here is module evidence against fakes; the
// integration suite runs the same runtime over real sockets.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSseFrame, SchedulerHttpApi } from "../../lib/system-scheduler/api-client.ts";
import { SchedulerRuntime } from "../../lib/system-scheduler/runtime.ts";
import {
  SchedulerStreamConsumer,
  type ConsumerApi,
  type FullReadSnapshot,
  type RebuildTrigger,
  type StreamFrame,
} from "../../lib/system-scheduler/stream-consumer.ts";
import { drain, FakeSchedulerApi, FakeTimers } from "./support/scheduler-harness.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * A fake API that counts every call.
 *
 * The count is load-bearing, not diagnostic: §9's "never polls the API on an
 * interval, and never re-reads on a timer" can only be asserted by a subject
 * that can say how many times it was called, and §6.3's "transport keepalive
 * frames are not API calls" can only be asserted by one that distinguishes a
 * frame from a call.
 */
class FakeApi implements ConsumerApi {
  calls: string[] = [];
  subscribedFrom: number[] = [];
  cursor = 100;
  snapshotTag = "first";

  async fullRead(): Promise<FullReadSnapshot> {
    this.calls.push("fullRead");
    return { cursor: this.cursor, tag: this.snapshotTag } as FullReadSnapshot;
  }
  // Counts only. What a subscribe DOES to the socket is asserted against the
  // real transport and the socket-modelling fake further down, where a no-op
  // cannot hide behind a counter.
  async subscribe(cursor: number): Promise<void> {
    this.calls.push("subscribe");
    this.subscribedFrom.push(cursor);
  }
}

interface Harness {
  api: FakeApi;
  consumer: SchedulerStreamConsumer;
  applied: number[];
  clock: { ms: number };
}

async function started(opts: { keepaliveBudgetMs?: number } = {}): Promise<Harness> {
  const api = new FakeApi();
  const applied: number[] = [];
  const clock = { ms: 1_000 };
  const consumer = new SchedulerStreamConsumer(
    api,
    {
      applyEvent: (e) => {
        applied.push(e.seq);
      },
    },
    { keepaliveBudgetMs: opts.keepaliveBudgetMs ?? 30_000, now: () => clock.ms },
  );
  await consumer.start();
  return { api, consumer, applied, clock };
}

const evt = (seq: number) => ({ type: "event" as const, seq, kind: "epoch.turned_over", payload: {} });
const triggers = (c: SchedulerStreamConsumer): RebuildTrigger[] => c.rebuilds.map((r) => r.trigger);

// ─────────────────────────────────────────────────────────────────────────────
// The handoff
// ─────────────────────────────────────────────────────────────────────────────

describe("the read/stream handoff", () => {
  test("start does a full read and subscribes from the cursor it returned", async () => {
    const { api, consumer } = await started();
    expect(api.calls).toEqual(["fullRead", "subscribe"]);
    expect(api.subscribedFrom).toEqual([100]);
    expect(consumer.cursor).toBe(100);
    expect(consumer.lastApplied).toBe(100);
    expect(consumer.current).toBe(true);
  });

  test("an event committed in the gap arrives above the cursor and is applied", async () => {
    const { consumer, applied } = await started();
    await consumer.receive(evt(101));
    expect(applied).toEqual([101]);
    expect(consumer.lastApplied).toBe(101);
    expect(consumer.current).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — duplicates
// ─────────────────────────────────────────────────────────────────────────────

describe("duplicate and stale events", () => {
  test("an event at or below the last applied is ignored", async () => {
    const { consumer, applied } = await started();
    await consumer.receive(evt(101));
    await consumer.receive(evt(101));
    await consumer.receive(evt(100));
    await consumer.receive(evt(7));
    expect(applied).toEqual([101]);
    expect(consumer.ignoredDuplicates).toBe(3);
  });

  test("ignoring a duplicate is not a rebuild and does not reset anything", async () => {
    // A duplicate that triggered a rebuild would turn an at-least-once delivery
    // into a stampede; one that reset a timer would move a boundary that the
    // API never moved.
    const { api, consumer } = await started();
    await consumer.receive(evt(101));
    const callsBefore = api.calls.length;
    await consumer.receive(evt(101));
    expect(api.calls.length).toBe(callsBefore);
    expect(consumer.rebuilds.length).toBe(1); // the start
    expect(consumer.lastApplied).toBe(101);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — a gap, and a resync
// ─────────────────────────────────────────────────────────────────────────────

describe("a gap and a resync both force a full read", () => {
  test("a sequence that is not the last applied plus one is a gap", async () => {
    const { api, consumer, applied } = await started();
    api.cursor = 140;
    api.snapshotTag = "rebuilt";
    await consumer.receive(evt(103));
    expect(applied).toEqual([]); // the skipped event was never applied, and 103 is not applied either
    expect(triggers(consumer)).toEqual(["start", "gap"]);
    expect(api.calls).toEqual(["fullRead", "subscribe", "fullRead", "subscribe"]);
    expect(consumer.cursor).toBe(140);
    expect(consumer.lastApplied).toBe(140);
    expect(consumer.current).toBe(true);
  });

  test("the scheduler does not act between detecting the gap and completing the rebuild", async () => {
    const api = new FakeApi();
    const applied: number[] = [];
    let currentDuringRead = true;
    api.fullRead = async () => {
      currentDuringRead = consumer.current;
      api.calls.push("fullRead");
      return { cursor: 140 } as FullReadSnapshot;
    };
    const consumer = new SchedulerStreamConsumer(api, {
      applyEvent: (e) => {
        applied.push(e.seq);
      },
    });
    await consumer.start();
    await consumer.receive(evt(103));
    // §3.1's "it stops acting" is not decoration: the window during which the
    // clock holds a copy it cannot prove is current is exactly the full read.
    expect(currentDuringRead).toBe(false);
    expect(applied).toEqual([]);
  });

  test("an explicit resync notice is treated exactly like a gap", async () => {
    const { api, consumer } = await started();
    api.cursor = 200;
    await consumer.receive({ type: "resync", reason: "log_truncated" });
    expect(triggers(consumer)).toEqual(["start", "resync"]);
    expect(consumer.cursor).toBe(200);
    expect(consumer.rebuilds[1].reason).toBe("log_truncated");
  });

  test("an event arriving while the copy is not current is not applied", async () => {
    const { consumer, applied } = await started();
    consumer.markStale("dropped_connection");
    expect(consumer.current).toBe(false);
    await consumer.receive(evt(101));
    expect(applied).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — the keepalive's head sequence
// ─────────────────────────────────────────────────────────────────────────────

describe("the keepalive carries the head sequence", () => {
  test("a keepalive whose head matches the last applied changes nothing", async () => {
    const { api, consumer } = await started();
    await consumer.receive(evt(101));
    const callsBefore = api.calls.length;
    await consumer.receive({ type: "keepalive", head: 101 });
    await consumer.receive({ type: "keepalive", head: 101 });
    expect(api.calls.length).toBe(callsBefore);
    expect(consumer.rebuilds.length).toBe(1);
  });

  test("a keepalive whose head EXCEEDS the last applied rebuilds on that alone", async () => {
    // §10's "Final-event loss" gate, in full: one event is dropped at the hop,
    // no later event follows it, and the only thing that can expose the loss is
    // the number on a frame the protocol already sends. "The test asserts the
    // trigger was the head-sequence mismatch, not a manually induced rebuild."
    const { api, consumer, applied } = await started();
    await consumer.receive(evt(101));
    api.cursor = 102; // the API committed 102; the frame carrying it never arrived
    await consumer.receive({ type: "keepalive", head: 102 });

    expect(triggers(consumer)).toEqual(["start", "head_sequence"]);
    expect(consumer.rebuilds[1].trigger).toBe("head_sequence");
    expect(consumer.rebuilds[1].observedHead).toBe(102);
    expect(consumer.rebuilds[1].lastApplied).toBe(101);
    // The rebuilt state reflects the dropped change: the new cursor is the head.
    expect(consumer.cursor).toBe(102);
    expect(consumer.lastApplied).toBe(102);
    expect(applied).toEqual([101]);
  });

  test("a head BELOW the last applied does not rebuild", async () => {
    // A stale frame in flight behind a freshly applied event is not a loss.
    const { consumer } = await started();
    await consumer.receive(evt(101));
    await consumer.receive({ type: "keepalive", head: 100 });
    expect(triggers(consumer)).toEqual(["start"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — a missed keepalive, and a dropped connection
// ─────────────────────────────────────────────────────────────────────────────

describe("a stalled or dropped connection", () => {
  test("a keepalive not seen within the budget is a dropped connection", async () => {
    // §10's "Silent stall": the socket is never closed, so only the absent
    // frame can reveal it, and no stale timer may fire afterwards.
    const h = await started({ keepaliveBudgetMs: 5_000 });
    await h.consumer.receive({ type: "keepalive", head: 100 });
    h.clock.ms += 4_999;
    expect(await h.consumer.checkKeepalive()).toBe(false);
    expect(h.consumer.current).toBe(true);

    h.clock.ms += 2;
    expect(await h.consumer.checkKeepalive()).toBe(true);
    expect(triggers(h.consumer)).toEqual(["start", "missed_keepalive"]);
  });

  test("a stalled connection stops the clock acting before it rebuilds", async () => {
    const h = await started({ keepaliveBudgetMs: 1_000 });
    let currentDuringRead = true;
    h.api.fullRead = async () => {
      currentDuringRead = h.consumer.current;
      return { cursor: 300 } as FullReadSnapshot;
    };
    h.clock.ms += 5_000;
    await h.consumer.checkKeepalive();
    expect(currentDuringRead).toBe(false);
    expect(h.consumer.cursor).toBe(300);
  });

  test("a dropped connection is followed by a full read, never a replay from the cursor", async () => {
    // §6.3: "The scheduler does not replay from its last cursor after a drop;
    // it rebuilds." So the cursor it subscribes from must be the NEW snapshot's,
    // and the stale one must never be asked for again.
    const { api, consumer } = await started();
    await consumer.receive(evt(101));
    api.cursor = 175;
    await consumer.connectionDropped();
    expect(consumer.current).toBe(false);
    await consumer.reconnect();

    expect(triggers(consumer)).toEqual(["start", "dropped_connection"]);
    expect(api.subscribedFrom).toEqual([100, 175]);
    expect(api.subscribedFrom).not.toContain(101);
    expect(consumer.lastApplied).toBe(175);
  });

  test("reconnection backs off, and the backoff resets once a connection is established", async () => {
    const { api, consumer } = await started();
    const delays: number[] = [];
    api.fullRead = async () => {
      if (delays.length < 3) throw new Error("api unreachable");
      return { cursor: 100 } as FullReadSnapshot;
    };
    const sleep = async () => {};
    await consumer.connectionDropped();
    // Three failures, then the fourth attempt connects.
    for (let i = 0; i < 4; i++) delays.push(await consumer.reconnect({ sleep }));
    expect(consumer.current).toBe(true);

    // The NEXT outage starts from the first step again. An unreset backoff makes
    // the second outage of a flapping dependency slower than the first for no
    // reason, and the fourth attempt's own delay was still the escalated one —
    // the reset lands on the attempt after the connection, not on it.
    await consumer.connectionDropped();
    delays.push(await consumer.reconnect({ sleep }));
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    expect(delays[2]).toBeLessThan(delays[3]);
    expect(delays[4]).toBe(delays[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — no job pushes
// ─────────────────────────────────────────────────────────────────────────────

describe("the stream carries change events only (§6.3, amended 2026-09-24)", () => {
  // "No job pushes. The stream carries change events only. Every piece of work
  // the scheduler does follows from an event or a timer; there is no ad-hoc
  // job kind for the API to push, ack or redeliver." The failure this replaces
  // was worse than dead code: the consumer ACKED a job frame it had no hook to
  // run, so the API recorded as done work nothing had done.

  test("a `job` frame on the wire parses to nothing", () => {
    const wire = `event: job\ndata: ${JSON.stringify({ kind: "reconcile_subject", target: "sub-1", idempotencyKey: "k1" })}`;
    expect(parseSseFrame(wire)).toBeNull();
  });

  test("the client has no job surface: no ack call, no job hook, no job memory", () => {
    expect("ackJob" in SchedulerHttpApi.prototype).toBe(false);
    expect("seenJobKeys" in SchedulerStreamConsumer.prototype).toBe(false);
    for (const rel of [
      "scripts/lib/system-scheduler/api-client.ts",
      "scripts/lib/system-scheduler/stream-consumer.ts",
      "scripts/lib/system-scheduler/runtime.ts",
      "scripts/system-scheduler.ts",
    ]) {
      const code = readFileSync(join(REPO, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\n)\s*\/\/.*/g, "");
      for (const needle of ["jobAck", "ackJob", "runJob", "JobFrame", "idempotencyKey"]) {
        expect({ rel, needle, found: code.includes(needle) }).toEqual({ rel, needle, found: false });
      }
    }
  });

  test("a job-shaped frame that reached the consumer anyway does nothing at all", async () => {
    const { api, consumer, applied } = await started();
    const before = api.calls.length;
    const job = { type: "job", kind: "reconcile_subject", target: "sub-1", idempotencyKey: "k1" };
    await consumer.receive(job as unknown as StreamFrame);
    expect(api.calls.length).toBe(before);
    expect(applied).toEqual([]);
    expect(triggers(consumer)).toEqual(["start"]);
    expect(consumer.lastApplied).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The transport's subscribe REPLACES the socket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `fetch` that serves the subscribe route with a stream the test writes to,
 * and aborts it the way a real connection aborts.
 */
function socketFetch() {
  const opened: { cursor: number; signal: AbortSignal; write(frame: string): void; end(): void }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const signal = init!.signal!;
    signal.addEventListener("abort", () => {
      try {
        controller.error(new Error("aborted"));
      } catch {
        /* already closed */
      }
    });
    opened.push({
      cursor: Number(url.searchParams.get("cursor")),
      signal,
      write: (frame) => controller.enqueue(new TextEncoder().encode(frame)),
      end: () => controller.close(),
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { opened, fetchImpl };
}

describe("SchedulerHttpApi.subscribe replaces the connection (§3.1, §6.3)", () => {
  // The defect this pins: `subscribe(cursor)` was a no-op, so a rebuild the
  // stream itself triggered (a gap, a head-sequence mismatch, a missed
  // keepalive) re-read the world and stayed on the old socket. On a stall that
  // socket never spoke again, and the watchdog re-read once per budget forever.

  test("a second subscribe aborts the first socket and opens a new one at the new cursor", async () => {
    const { opened, fetchImpl } = socketFetch();
    const http = new SchedulerHttpApi({ apiUrl: "http://api", token: "rmat_t", fetchImpl });
    const frames: StreamFrame[] = [];
    const closed: string[] = [];
    http.attachStream({ onFrame: (f) => void frames.push(f), onClosed: (r) => void closed.push(r) });

    await http.subscribe(5);
    await http.subscribe(9);
    await drain();

    expect(opened.map((o) => o.cursor)).toEqual([5, 9]);
    expect(opened[0].signal.aborted).toBe(true);
    expect(opened[1].signal.aborted).toBe(false);
    expect(http.streamOpen).toBe(true);
    // Replacing a socket is deliberate, and reporting it as a drop would turn
    // every rebuild into a reconnect.
    expect(closed).toEqual([]);

    opened[1].write(`event: keepalive\ndata: {"head":9}\n\n`);
    await drain();
    expect(frames).toEqual([{ type: "keepalive", head: 9 }]);
  });

  test("only the CURRENT socket's end is reported, exactly once", async () => {
    const { opened, fetchImpl } = socketFetch();
    const http = new SchedulerHttpApi({ apiUrl: "http://api", token: "rmat_t", fetchImpl });
    const closed: string[] = [];
    http.attachStream({ onFrame: () => {}, onClosed: (r) => void closed.push(r) });
    await http.subscribe(1);
    await http.subscribe(2);
    opened[1].end();
    await drain();
    expect(closed).toEqual(["stream ended"]);
    expect(http.streamOpen).toBe(false);
  });

  test("closeStream ends the socket silently", async () => {
    const { opened, fetchImpl } = socketFetch();
    const http = new SchedulerHttpApi({ apiUrl: "http://api", token: "rmat_t", fetchImpl });
    const closed: string[] = [];
    http.attachStream({ onFrame: () => {}, onClosed: (r) => void closed.push(r) });
    await http.subscribe(1);
    http.closeStream();
    await drain();
    expect(opened[0].signal.aborted).toBe(true);
    expect(closed).toEqual([]);
  });

  test("a refused subscribe throws and leaves no socket", async () => {
    const http = new SchedulerHttpApi({
      apiUrl: "http://api",
      token: "rmat_t",
      fetchImpl: async () => new Response("{}", { status: 503 }),
    });
    http.attachStream({ onFrame: () => {}, onClosed: () => {} });
    await expect(http.subscribe(1)).rejects.toThrow("HTTP 503");
    expect(http.streamOpen).toBe(false);
  });

  test("a subscribe with nowhere to deliver frames refuses rather than dropping them", async () => {
    const http = new SchedulerHttpApi({ apiUrl: "http://api", token: "rmat_t", fetchImpl: socketFetch().fetchImpl });
    await expect(http.subscribe(1)).rejects.toThrow("attachStream");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The consumer and the clock together, on fake timers
// ─────────────────────────────────────────────────────────────────────────────
//
// `SchedulerRuntime` is the wiring `scripts/system-scheduler.ts` runs. Here it
// runs over the shared FakeSchedulerApi, whose stream is modelled as SOCKETS:
// a frame reaches the scheduler only through the socket the latest subscribe
// opened. A transport whose subscribe did nothing would leave the scheduler on
// the stalled socket, and every assertion below on full reads and sockets
// would fail. Evidence against a fake API: module-level, not a runtime claim
// about the real API, which is the integration and backend suites' job.

const T0 = 1_800_000_000_000;
const BUDGET = 30_000;
const WATCHDOG = 5_000;

async function runtimeWorld(opts: { boundaryAt?: number } = {}) {
  const timers = new FakeTimers(T0);
  const fake = new FakeSchedulerApi({ now: () => timers.now() });
  fake.addSubject("sub-a", 600, true, { epochAnchorMs: T0 - 600_000 + (opts.boundaryAt ?? 600_000) });
  fake.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + (opts.boundaryAt ?? 600_000), judgeMode: "off" });
  const runtime = new SchedulerRuntime(fake, {
    timers,
    probe: () => fake.probe(),
    keepaliveBudgetMs: BUDGET,
    watchdogMs: WATCHDOG,
  });
  await runtime.start();
  await runtime.clock.idle();
  const rebuildTriggers = () => runtime.consumer.rebuilds.map((r) => r.trigger);
  /** Advance to `t` in `step`s, sending a keepalive on the live socket at each step. */
  const liveUntil = async (t: number, step = 10_000): Promise<void> => {
    while (timers.now() < t) {
      await timers.advanceTo(Math.min(t, timers.now() + step));
      await fake.keepalive();
      await runtime.clock.idle();
    }
  };
  return { timers, fake, runtime, rebuildTriggers, liveUntil };
}

describe("the runtime: a stale copy never fires (§3.1, §10)", () => {
  test("a dropped connection marks the copy stale BEFORE anything else, then rebuilds on a new socket", async () => {
    const { timers, fake, runtime, rebuildTriggers } = await runtimeWorld();
    expect(runtime.consumer.current).toBe(true);
    expect(runtime.clock.health.streamSynchronized).toBe(true);

    fake.dropConnection("peer reset");
    // Synchronously: no await between the drop and these reads.
    expect(runtime.consumer.current).toBe(false);
    expect(runtime.clock.health.streamSynchronized).toBe(false);

    await timers.advanceBy(1_000); // past the first reconnect backoff step
    await runtime.settled();
    expect(rebuildTriggers()).toEqual(["start", "dropped_connection"]);
    expect(fake.countCalls("fullRead")).toBe(2);
    expect(fake.sockets.map((s) => s.open)).toEqual([false, true]);
    expect(runtime.consumer.current).toBe(true);
    expect(runtime.clock.health.streamSynchronized).toBe(true);
  });

  test("BACKOFF: a boundary falling while the API is unreachable makes ZERO turnover calls, then fires once on rebuild", async () => {
    const { timers, fake, runtime } = await runtimeWorld({ boundaryAt: 60_000 });
    await timers.advanceTo(T0 + 50_000);
    fake.setUnreachable(true);
    fake.dropConnection("api went away");

    // The boundary instant passes during the backoff, with several failed
    // reconnects behind it.
    await timers.advanceTo(T0 + 90_000);
    await runtime.clock.idle();
    expect(fake.countCalls("turnover")).toBe(0);
    expect(fake.countCalls("fullRead")).toBeGreaterThan(2);
    expect(runtime.clock.health.healthy).toBe(false);

    fake.setUnreachable(false);
    await timers.advanceBy(20_000);
    await runtime.settled();
    await runtime.clock.idle();

    const [turnover] = fake.callsOf("turnover");
    expect(fake.countCalls("turnover")).toBe(1);
    expect(turnover.args.expectedSessionId).toBe("sa");
    // Dispatched by the rebuild that ended the interval, after its full read.
    const lastRead = fake.callsOf("fullRead").at(-1)!;
    expect(fake.calls.indexOf(turnover)).toBeGreaterThan(fake.calls.indexOf(lastRead));
    expect(runtime.clock.health.healthy).toBe(true);
  });

  test("SILENT STALL: caught within the budget; a boundary falling during the rebuild makes ZERO turnover calls", async () => {
    const { timers, fake, runtime, rebuildTriggers, liveUntil } = await runtimeWorld({ boundaryAt: 70_000 });
    await liveUntil(T0 + 10_000);
    fake.stall();
    const release = fake.holdFullRead();

    // Last keepalive at T0+10s; the budget runs out at T0+40s and the watchdog
    // (every 5s) sees it at the first tick after that.
    await timers.advanceTo(T0 + 45_000);
    expect(rebuildTriggers()).toEqual(["start"]); // the rebuild is in flight
    expect(runtime.consumer.current).toBe(false);
    expect(fake.countCalls("fullRead")).toBe(2);
    expect(fake.callsOf("fullRead")[1].atMs).toBeLessThanOrEqual(T0 + 10_000 + BUDGET + WATCHDOG);

    // The boundary falls while the full read is held. The old copy's timer
    // must not act on it.
    await timers.advanceTo(T0 + 80_000);
    await runtime.clock.idle();
    expect(fake.countCalls("turnover")).toBe(0);

    release();
    await drain();
    await runtime.clock.idle();
    expect(rebuildTriggers()).toEqual(["start", "missed_keepalive"]);
    expect(fake.countCalls("turnover")).toBe(1);
    expect(fake.callsOf("turnover")[0].atMs).toBe(T0 + 80_000);
  });

  test("SILENT STALL: exactly one full read across several keepalive budgets, because the rebuild moved to a live socket", async () => {
    const { timers, fake, runtime, rebuildTriggers, liveUntil } = await runtimeWorld({ boundaryAt: 3_600_000 });
    await liveUntil(T0 + 10_000);
    fake.stall();
    // Nothing reaches the scheduler on the stalled socket; the keepalives the
    // helper sends go to whatever socket is live, and there is none until the
    // rebuild opens one.
    await liveUntil(T0 + 10_000 + 6 * BUDGET);

    expect(rebuildTriggers()).toEqual(["start", "missed_keepalive"]);
    expect(fake.countCalls("fullRead")).toBe(2);
    expect(fake.countCalls("subscribe")).toBe(2);
    expect(fake.sockets).toHaveLength(2);
    expect(fake.sockets[0]).toMatchObject({ open: false, stalled: true });
    expect(fake.sockets[1]).toMatchObject({ open: true, stalled: false, cursor: fake.head });
    expect(runtime.consumer.current).toBe(true);
    expect(fake.countCalls("turnover")).toBe(0);
    expect(timers.now()).toBe(T0 + 10_000 + 6 * BUDGET);
  });

  test("GAP: a full read and rebuild complete before any further fire", async () => {
    const { timers, fake, runtime, rebuildTriggers } = await runtimeWorld({ boundaryAt: 60_000 });
    const release = fake.holdFullRead();
    fake.commitEvent();
    const skipped = fake.commitEvent();
    // Event `skipped - 1` never arrives; `skipped` does.
    // Not awaited: the frame's handler is the rebuild, and it is held.
    void fake.deliver({ type: "event", seq: skipped, kind: "subject.changed", subjectId: "sub-a", payload: { reason: "updated" } });
    await drain();
    expect(runtime.consumer.current).toBe(false);

    await timers.advanceTo(T0 + 70_000);
    await runtime.clock.idle();
    expect(fake.countCalls("turnover")).toBe(0);

    release();
    await drain();
    await runtime.clock.idle();
    expect(rebuildTriggers()).toEqual(["start", "gap"]);
    expect(fake.countCalls("turnover")).toBe(1);
    expect(runtime.consumer.lastApplied).toBe(skipped);
  });

  test("RESYNC: a boundary during the forced rebuild does not fire from the old copy", async () => {
    const { timers, fake, runtime, rebuildTriggers } = await runtimeWorld({ boundaryAt: 60_000 });
    const release = fake.holdFullRead();
    void fake.deliver({ type: "resync", reason: "buffer_overflow" });
    await drain();
    await timers.advanceTo(T0 + 70_000);
    await runtime.clock.idle();
    expect(fake.countCalls("turnover")).toBe(0);
    release();
    await drain();
    await runtime.clock.idle();
    expect(rebuildTriggers()).toEqual(["start", "resync"]);
    expect(fake.countCalls("turnover")).toBe(1);
  });

  test("no event is applied while the copy is not current; held frames follow the ordinary rules afterwards", async () => {
    const { fake, runtime } = await runtimeWorld();
    const applied: number[] = [];
    const original = runtime.clock.applyEvent.bind(runtime.clock);
    runtime.clock.applyEvent = async (e) => {
      expect(runtime.consumer.current).toBe(true);
      applied.push(e.seq);
      await original(e);
    };
    const release = fake.holdFullRead();
    void fake.deliver({ type: "resync", reason: "cursor_above_head" });
    await drain();
    const seq = fake.commitEvent();
    // Arrives mid-rebuild, on the socket the rebuild has not replaced yet.
    await fake.deliver({ type: "event", seq, kind: "subject.changed", subjectId: "sub-a", payload: { reason: "updated" } });
    expect(applied).toEqual([]);
    release();
    await drain();
    // The rebuilt snapshot's cursor already covers it: a duplicate, ignored.
    expect(applied).toEqual([]);
    expect(runtime.consumer.ignoredDuplicates).toBe(1);
    expect(runtime.consumer.current).toBe(true);
  });

  test("FINAL-EVENT LOSS: the keepalive head alone triggers the rebuild, and the trigger says so", async () => {
    const { fake, runtime, rebuildTriggers } = await runtimeWorld();
    fake.commitEvent(); // committed, never delivered
    await fake.keepalive();
    await drain();
    expect(rebuildTriggers()).toEqual(["start", "head_sequence"]);
    expect(runtime.consumer.rebuilds[1].observedHead).toBe(fake.head);
    expect(runtime.consumer.lastApplied).toBe(fake.head);
  });

  test("between instants, with a live stream and keepalives flowing, the runtime makes ZERO API calls — watchdog included", async () => {
    const { fake, liveUntil } = await runtimeWorld({ boundaryAt: 3_600_000 });
    const before = fake.calls.length;
    await liveUntil(T0 + 20 * 60_000);
    expect(fake.calls.slice(before)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 / §10 — no polling
// ─────────────────────────────────────────────────────────────────────────────

describe("between instants", () => {
  test("frames are not API calls: a live, quiet stream makes none", async () => {
    const { api, consumer } = await started();
    const callsAfterStart = api.calls.length;
    for (let i = 0; i < 20; i++) await consumer.receive({ type: "keepalive", head: 100 });
    await consumer.receive(evt(101));
    await consumer.receive({ type: "keepalive", head: 101 });
    expect(api.calls.length).toBe(callsAfterStart);
  });

  test("checking the keepalive budget is not an API call either", async () => {
    const h = await started({ keepaliveBudgetMs: 60_000 });
    const before = h.api.calls.length;
    for (let i = 0; i < 10; i++) await h.consumer.checkKeepalive();
    expect(h.api.calls.length).toBe(before);
  });
});

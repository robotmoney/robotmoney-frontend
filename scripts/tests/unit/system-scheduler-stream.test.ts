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
// WHAT THIS FILE DOES NOT PROVE. It does not prove the real API emits these
// frames — that is the backend file's job — and it does not prove the
// `system-scheduler` container wires this consumer to a real socket and real
// timers, which is W4's third part. It proves the contract in the middle.
import { describe, expect, test } from "bun:test";
import {
  SchedulerStreamConsumer,
  type ConsumerApi,
  type FullReadSnapshot,
  type RebuildTrigger,
} from "../../lib/system-scheduler/stream-consumer.ts";

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
  acked: string[] = [];
  cursor = 100;
  snapshotTag = "first";

  async fullRead(): Promise<FullReadSnapshot> {
    this.calls.push("fullRead");
    return { cursor: this.cursor, tag: this.snapshotTag } as FullReadSnapshot;
  }
  async subscribe(cursor: number): Promise<void> {
    this.calls.push("subscribe");
    this.subscribedFrom.push(cursor);
  }
  async ackJob(key: string): Promise<void> {
    this.calls.push("ackJob");
    this.acked.push(key);
  }
}

interface Harness {
  api: FakeApi;
  consumer: SchedulerStreamConsumer;
  applied: number[];
  jobsRun: string[];
  clock: { ms: number };
}

async function started(opts: { keepaliveBudgetMs?: number } = {}): Promise<Harness> {
  const api = new FakeApi();
  const applied: number[] = [];
  const jobsRun: string[] = [];
  const clock = { ms: 1_000 };
  const consumer = new SchedulerStreamConsumer(
    api,
    {
      applyEvent: (e) => applied.push(e.seq),
      runJob: (job) => {
        jobsRun.push(job.idempotencyKey);
      },
    },
    { keepaliveBudgetMs: opts.keepaliveBudgetMs ?? 30_000, now: () => clock.ms },
  );
  await consumer.start();
  return { api, consumer, applied, jobsRun, clock };
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
    const consumer = new SchedulerStreamConsumer(api, { applyEvent: (e) => applied.push(e.seq) });
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
    await consumer.connectionDropped();
    for (let i = 0; i < 4; i++) delays.push(await consumer.reconnect({ sleep: async () => {} }));
    // Strictly increasing while it fails, then back to the first step once the
    // connection is established — an unreset backoff makes the SECOND outage of
    // a flapping dependency slower than the first for no reason.
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    expect(delays[3]).toBe(delays[0]);
    expect(consumer.current).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — job pushes
// ─────────────────────────────────────────────────────────────────────────────

describe("job pushes", () => {
  const job = (key: string) => ({ type: "job" as const, kind: "reconcile_subject", target: "sub-1", idempotencyKey: key });

  test("a job is run and then acked through the API", async () => {
    const { api, consumer, jobsRun } = await started();
    await consumer.receive(job("k1"));
    expect(jobsRun).toEqual(["k1"]);
    expect(api.acked).toEqual(["k1"]);
  });

  test("a seen idempotency key produces no second effect, and is acked again", async () => {
    // Acked again on purpose: a redelivery means the first ack did not reach
    // the API, so staying silent would leave the job unacked for ever.
    const { api, consumer, jobsRun } = await started();
    await consumer.receive(job("k2"));
    await consumer.receive(job("k2"));
    expect(jobsRun).toEqual(["k2"]);
    expect(api.acked).toEqual(["k2", "k2"]);
  });

  test("a job redelivered after a reconnect still produces no second effect", async () => {
    const { consumer, jobsRun } = await started();
    await consumer.receive(job("k3"));
    await consumer.connectionDropped();
    await consumer.reconnect();
    await consumer.receive(job("k3"));
    expect(jobsRun).toEqual(["k3"]);
  });

  test("a job is not a stream event: it moves no cursor and leaves no gap behind", async () => {
    const { consumer, applied } = await started();
    await consumer.receive(job("k4"));
    expect(consumer.lastApplied).toBe(100);
    await consumer.receive(evt(101));
    expect(applied).toEqual([101]);
    expect(triggers(consumer)).toEqual(["start"]);
  });

  test("a job whose work throws is NOT acked", async () => {
    const api = new FakeApi();
    const consumer = new SchedulerStreamConsumer(api, {
      runJob: () => {
        throw new Error("the work failed");
      },
    });
    await consumer.start();
    await consumer.receive(job("k5"));
    expect(api.acked).toEqual([]);
    // And it is not remembered as seen, so the API's redelivery can retry it.
    expect(consumer.seenJobKeys).not.toContain("k5");
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

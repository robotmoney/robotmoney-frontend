// A lifecycle job still QUEUED behind other work is not a slow job.
//
// With sessions for several subjects in flight (SmokeCadence.
// maxConcurrentSessions), a subject's open/brief/close/aggregate/publish job can
// sit unclaimed while other subjects' jobs hold every swarm worker. The 30 s
// state waits used to start their clock at ENQUEUE, so that queue time was
// reported as "session failed". They now extend while — and only while — their
// own job has never been claimed.
//
// Executed against a stubbed fetch and an injected job reader: no network, no
// server, no worker.
import { afterEach, describe, expect, test } from "bun:test";
import {
  jobNeverClaimed,
  planQueuedExtension,
  queuedWaitFor,
  waitForSessionState,
  waitForSessionStateAfterJob,
  waitForSubjectSession,
  type JudgeJobStatus,
} from "../../lib/swarm/session.ts";

const realFetch = globalThis.fetch;
const realBackend = process.env.BACKEND_URL;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBackend === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = realBackend;
});

const job = (status: string, attempts: number): JudgeJobStatus =>
  ({ status, attempts, maxAttempts: 5, lastError: null, runAfter: null });

/** Session state flips to `to` once `flipAfterMs` has passed. */
function stubStateFlip(from: string, to: string, flipAfterMs: number) {
  const start = Date.now();
  const state = () => (Date.now() - start >= flipAfterMs ? to : from);
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("/api/swarm/sessions/")) {
      return Response.json({ session: { state: state() } });
    }
    if (url.endsWith("/api/swarm/sessions")) {
      return Response.json({ sessions: [{ subjectId: "woon", state: state(), date: "2026-09-25", id: 7 }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("planQueuedExtension — the decision, pure", () => {
  test("only a job that has NEVER been claimed counts as queued", () => {
    expect(jobNeverClaimed(job("pending", 0))).toBe(true);
    expect(jobNeverClaimed(job("pending", 1))).toBe(false); // backoff after its own failure
    expect(jobNeverClaimed(job("running", 1))).toBe(false);
    expect(jobNeverClaimed(job("succeeded", 1))).toBe(false);
    expect(jobNeverClaimed(null)).toBe(false); // unreadable is not evidence of a queue
  });

  test("a queued job extends by a full timeout from now, until the hard stop", () => {
    // started 0, timeout 30 s, ceiling 420 s -> hard stop at 450 s.
    expect(planQueuedExtension(job("pending", 0), 30_000, 0, 30_000, 420_000)).toEqual({ extend: true, deadline: 60_000 });
    expect(planQueuedExtension(job("pending", 0), 449_000, 0, 30_000, 420_000)).toEqual({ extend: true, deadline: 479_000 });
    expect(planQueuedExtension(job("pending", 0), 450_000, 0, 30_000, 420_000).extend).toBe(false);
  });

  test("a claimed, failed or unreadable job lets the ordinary deadline fail the wait", () => {
    for (const j of [job("running", 1), job("pending", 2), job("dead", 5), null]) {
      expect(planQueuedExtension(j, 30_000, 0, 30_000, 420_000).extend).toBe(false);
    }
  });

  test("queuedWaitFor reads the job id enqueueLifecycleJob returned, and nothing else", () => {
    expect(queuedWaitFor({ jobId: 42, kind: "swarm.close_window" }, "tok")).toEqual({ jobId: 42, automationToken: "tok" });
    expect(queuedWaitFor({ jobId: "42" }).jobId).toBe("42");
    expect(queuedWaitFor(undefined).jobId).toBeNull();
    expect(queuedWaitFor({ jobId: { nested: 1 } }).jobId).toBeNull();
  });
});

describe("the state waits, executed", () => {
  test("waitForSessionState keeps waiting past its deadline while its job is queued, then returns", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("aggregated", "window_closed", 1_200); // lands after the 300 ms deadline
    let reads = 0;
    const data = await waitForSessionState("2026-09-25", "woon", "window_closed", 300, {
      jobId: 9,
      readJob: async () => { reads++; return job("pending", 0); },
      ceilingMs: 10_000,
    });
    expect((data as { session: { state: string } }).session.state).toBe("window_closed");
    expect(reads).toBeGreaterThan(0);
  });

  test("a job that WAS claimed does not extend — the ordinary deadline fails exactly as before", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("aggregated", "window_closed", 60_000);
    const start = Date.now();
    await expect(
      waitForSessionState("2026-09-25", "woon", "window_closed", 300, {
        jobId: 9,
        readJob: async () => job("running", 1),
      }),
    ).rejects.toThrow("did not reach 'window_closed' within 300ms");
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  test("a still-queued job gives up at the hard stop, not never", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("aggregated", "window_closed", 60_000);
    const start = Date.now();
    await expect(
      waitForSessionState("2026-09-25", "woon", "window_closed", 200, {
        jobId: 9,
        readJob: async () => job("pending", 0),
        ceilingMs: 600,
      }),
    ).rejects.toThrow("did not reach 'window_closed'");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(800); // survived past 200 ms
    expect(elapsed).toBeLessThan(3_000); // and stopped near 200 + 600 (+ one timeout)
  });

  test("with no job handed in, the wait behaves exactly as it always did", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("aggregated", "window_closed", 60_000);
    await expect(waitForSessionState("2026-09-25", "woon", "window_closed", 200))
      .rejects.toThrow("did not reach 'window_closed' within 200ms");
  });

  test("waitForSubjectSession (open_session) tolerates a queued job the same way", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("none", "scheduled", 1_000);
    const opened = await waitForSubjectSession("woon", ["scheduled", "collecting"], 300, {
      jobId: 3,
      readJob: async () => job("pending", 0),
      ceilingMs: 10_000,
    });
    expect(opened.session.state).toBe("scheduled");
  });

  test("the publish wait tolerates its OWN job being queued (no judge involved)", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("aggregated", "published", 1_200);
    const data = await waitForSessionStateAfterJob("2026-09-25", "woon", "published", null, "tok", 300, {
      laneCeilingMs: 10_000,
      queued: { jobId: 11, readJob: async () => job("pending", 0) },
    });
    expect((data as { session: { state: string } }).session.state).toBe("published");
  });

  test("the publish wait still fails at its deadline once its job has been claimed", async () => {
    process.env.BACKEND_URL = "http://queuedwait.invalid";
    stubStateFlip("aggregated", "published", 60_000);
    await expect(
      waitForSessionStateAfterJob("2026-09-25", "woon", "published", null, "tok", 300, {
        laneCeilingMs: 10_000,
        queued: { jobId: 11, readJob: async () => job("running", 1) },
      }),
    ).rejects.toThrow("did not reach 'published' within 300ms");
  });
});

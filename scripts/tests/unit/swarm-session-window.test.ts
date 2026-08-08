// The driver waits out the window it advertised (issue #570) — executed, not
// grepped, in the required per-PR `unit` job.
//
// WHAT THIS PROTECTS. `scripts/lib/swarm/session.ts` used to publish a brief
// with a hardcoded `windowMinutes: 60` and then enqueue `close_window` the
// moment `mapSettledWithConcurrency` returned — i.e. when its OWN in-process
// member agents settled, 1-3 minutes later. Every live session advertised an
// hour and ended in under three minutes; the committed `goldens/api-goldens.json`
// carries `publishedAt` ~59.9 minutes BEFORE `windowClosesAt` on every row. It
// was invisible while the driver owned every member (its agents run inside the
// process that closes the window, so they always won) and became a defect the
// instant an external operator's agent joined the roster.
//
// A six-hour production window cannot be observed in CI, so the DECISION is a
// pure function (planWindowWait) and the loop around it takes injected deps —
// both executed here on a fake clock, with no network and no timers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planWindowWait,
  waitUntilWindowCloses,
  windowWaitCeilingMs,
  WINDOW_WAIT_GRACE_MS,
  WINDOW_WAIT_POLL_MS,
  type SessionWindowReading,
} from "../../lib/swarm/session.ts";
import { resolveDemoCadence, swarmWindowMinutes } from "../../lib/demo-schedule.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const T0 = Date.UTC(2026, 7, 7, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const LIMITS = { maxWaitMs: 300_000, graceMs: 1_000, pollMs: 5_000 };

describe("planWindowWait — the pure decision, on the SERVER's clock", () => {
  test("a window still open sleeps, capped at the poll interval so the clock is re-read", () => {
    const plan = planWindowWait(T0, iso(T0 + 120_000), LIMITS);
    expect(plan.action).toBe("sleep");
    expect(plan.sleepMs).toBe(5_000);
    expect(plan.reason).toContain("121s away");
  });

  test("the final sleep is the exact remainder, never an overshoot past the deadline", () => {
    const plan = planWindowWait(T0, iso(T0 + 900), LIMITS);
    expect(plan.action).toBe("sleep");
    expect(plan.sleepMs).toBe(900 + 1_000); // remainder + grace, under one poll
  });

  test("a window already past PROCEEDS — a restarted driver must not stall an elapsed epoch", () => {
    const plan = planWindowWait(T0, iso(T0 - 3_600_000), LIMITS);
    expect(plan.action).toBe("proceed");
    expect(plan.sleepMs).toBe(0);
    expect(plan.reason).toContain("3599s ago"); // the grace is folded into the remainder
  });

  test("the grace period is applied on TOP of the deadline, for host-vs-Postgres skew", () => {
    // `window_closes_at` is JS-computed in the api container; the submit path
    // compares it against Postgres now(). Closing at the exact advertised
    // instant could let a take land after the aggregate was computed, so the
    // driver crosses the boundary before it enqueues the close.
    expect(planWindowWait(T0, iso(T0), LIMITS).action).toBe("sleep");
    expect(planWindowWait(T0 + 999, iso(T0), LIMITS).action).toBe("sleep");
    expect(planWindowWait(T0 + 1_000, iso(T0), LIMITS).action).toBe("proceed");
    expect(WINDOW_WAIT_GRACE_MS).toBe(1_000);
    expect(WINDOW_WAIT_POLL_MS).toBe(5_000);
  });

  test("an absurdly distant window ABORTS — it neither hangs nor closes early", () => {
    const plan = planWindowWait(T0, iso(T0 + 30 * 24 * 3_600_000), LIMITS);
    expect(plan.action).toBe("abort");
    expect(plan.reason).toContain("beyond the 300s ceiling");
    // Both refusals are stated, because each alone is a defect: waiting hangs
    // the caller (in CI, until the job timeout kills it) and closing early is
    // the exact behaviour this replaced.
    expect(plan.reason).toContain("Refusing to wait");
    expect(plan.reason).toContain("refusing to close early");
  });

  test("a missing or unparseable deadline ABORTS rather than defaulting to 'close it'", () => {
    expect(planWindowWait(T0, null, LIMITS).action).toBe("abort");
    expect(planWindowWait(T0, undefined, LIMITS).reason).toContain("publish_brief did not land");
    expect(planWindowWait(T0, "not-a-date", LIMITS).reason).toContain("not a parseable instant");
  });

  test("the ceiling is derived from the profile's own window, and bounds the fast one", () => {
    const fast = resolveDemoCadence({ stage: false });
    const realistic = resolveDemoCadence({ stage: true });
    expect(windowWaitCeilingMs(fast)).toBe(2 * fast.swarmWindowMs + 60_000); // 5 min
    expect(windowWaitCeilingMs(fast)).toBeLessThanOrEqual(300_000);
    expect(windowWaitCeilingMs(realistic)).toBe(2 * realistic.swarmWindowMs + 60_000);
    // A brief published by THIS driver always sits comfortably inside it.
    expect(planWindowWait(T0, iso(T0 + fast.swarmWindowMs), { maxWaitMs: windowWaitCeilingMs(fast) }).action)
      .toBe("sleep");
  });
});

describe("waitUntilWindowCloses — the loop, on a fake clock and injected reads", () => {
  function harness(readings: SessionWindowReading[], startMs = T0) {
    let now = startMs;
    const slept: number[] = [];
    const logs: string[] = [];
    let i = 0;
    return {
      slept,
      logs,
      nowRef: () => now,
      deps: {
        read: async () => readings[Math.min(i++, readings.length - 1)],
        wait: async (ms: number) => { now += ms; slept.push(ms); },
        now: () => now,
        log: (line: string) => { logs.push(line); },
      },
    };
  }

  test("it sleeps until the SERVER says the window has passed, then returns", async () => {
    const closes = iso(T0 + 12_000);
    const h = harness([
      { windowClosesAt: closes, serverNowMs: T0 },
      { windowClosesAt: closes, serverNowMs: T0 + 5_000 },
      { windowClosesAt: closes, serverNowMs: T0 + 10_000 },
      { windowClosesAt: closes, serverNowMs: T0 + 15_000 },
    ]);
    const out = await waitUntilWindowCloses("2026-08-07", "woon", LIMITS, h.deps);
    expect(h.slept).toEqual([5_000, 5_000, 3_000]);
    expect(out.waitedMs).toBe(13_000);
    expect(out.windowClosesAt).toBe(closes);
    expect(out.clockFallbacks).toBe(0);
  });

  test("an already-elapsed window returns immediately without a single sleep", async () => {
    const h = harness([{ windowClosesAt: iso(T0 - 60_000), serverNowMs: T0 }]);
    const out = await waitUntilWindowCloses("2026-08-07", "woon", LIMITS, h.deps);
    expect(h.slept).toEqual([]);
    expect(out.waitedMs).toBe(0);
  });

  test("the SERVER clock decides, not this host's — a skewed host is reported, not obeyed", async () => {
    // Host clock is 10 minutes AHEAD of the api container. A driver trusting its
    // own clock would think the window closed and enqueue the close early; the
    // server's clock says otherwise and wins.
    const closes = iso(T0 + 60_000);
    const h = harness([
      { windowClosesAt: closes, serverNowMs: T0 },
      { windowClosesAt: closes, serverNowMs: T0 + 61_000 },
    ], T0 + 600_000);
    const out = await waitUntilWindowCloses("2026-08-07", "woon", LIMITS, h.deps);
    expect(h.slept).toEqual([5_000]);
    expect(h.logs.join(" ")).toContain("host clock differs from the API's by 600s");
    expect(out.reason).toContain("window closed at");
  });

  test("an unreadable server clock falls back to the host's and SAYS SO", async () => {
    const h = harness([{ windowClosesAt: iso(T0 - 1_000), serverNowMs: null }]);
    const out = await waitUntilWindowCloses("2026-08-07", "woon", LIMITS, h.deps);
    expect(out.clockFallbacks).toBe(1);
  });

  test("a distant window throws instead of hanging the caller", async () => {
    const h = harness([{ windowClosesAt: iso(T0 + 86_400_000), serverNowMs: T0 }]);
    await expect(waitUntilWindowCloses("2026-08-07", "woon", LIMITS, h.deps))
      .rejects.toThrow(/refused:.*beyond the 300s ceiling/);
  });

  test("a session with no advertised deadline throws — publish_brief did not land", async () => {
    const h = harness([{ windowClosesAt: null, serverNowMs: T0 }]);
    await expect(waitUntilWindowCloses("2026-08-07", "woon", LIMITS, h.deps))
      .rejects.toThrow(/publish_brief did not land/);
  });

  test("a window that keeps being pushed out hits the ELAPSED ceiling and throws", async () => {
    // Total elapsed is bounded independently of the per-read remaining check, so
    // a pathological server cannot keep this loop alive forever.
    let now = T0;
    const slept: number[] = [];
    const deps = {
      read: async () => ({ windowClosesAt: iso(now + 10_000), serverNowMs: now }),
      wait: async (ms: number) => { now += ms; slept.push(ms); },
      now: () => now,
      log: () => {},
    };
    await expect(waitUntilWindowCloses("2026-08-07", "woon", { maxWaitMs: 30_000, pollMs: 5_000 }, deps))
      .rejects.toThrow(/exceeded its 30s ceiling/);
    expect(slept.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// SOURCE-TEXT CHECKS on runSession's ORDER. runSession drives docker, the job
// queue and live inference, so it cannot be executed here; these assert the
// structural property the pure functions above cannot — that the wait sits
// BETWEEN agent settlement and the close, rather than the close following
// settlement directly. Each grader is graded against a broken fixture below so
// it cannot go vacuously green.
// ---------------------------------------------------------------------------
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");

/** Ordered positions of runSession's lifecycle landmarks; -1 when absent. */
export function lifecycleOrder(src: string) {
  return {
    settle: src.indexOf("const settled = await mapSettledWithConcurrency("),
    windowWait: src.indexOf("await waitUntilWindowCloses("),
    close: src.indexOf('enqueueLifecycleJob("close_window"'),
    brief: src.indexOf('enqueueLifecycleJob("publish_brief"'),
  };
}

describe("runSession closes on the WINDOW, not on its own agents settling", () => {
  const order = lifecycleOrder(sessionSrc);

  test("every landmark is present", () => {
    for (const [name, at] of Object.entries(order)) expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
  });

  test("the window wait sits between agent settlement and close_window", () => {
    expect(order.settle).toBeLessThan(order.windowWait);
    expect(order.windowWait).toBeLessThan(order.close);
  });

  test("the brief's window comes from the cadence profile, never a literal", () => {
    expect(sessionSrc).toContain("const windowMinutes = swarmWindowMinutes(cadence);");
    expect(sessionSrc).toContain("enqueueLifecycleJob(\"publish_brief\", { sessionId, windowMinutes, prevOutcome }");
    expect(sessionSrc).not.toContain("windowMinutes: 60");
    // …and never from an env var. SWARM_WINDOW_MINUTES already exists and means
    // the api container's seed-time cron payload (backend/src/config.ts); giving
    // it a second meaning here would let a stale shell export silently change
    // production behaviour, which is the rule demo-schedule.ts's header states.
    expect(sessionSrc).not.toContain("SWARM_WINDOW_MINUTES");
  });

  test("the ceiling handed to the wait is derived from the same profile", () => {
    expect(sessionSrc).toContain("maxWaitMs: windowWaitCeilingMs(cadence)");
  });

  test("the driver adopts an already-collecting session instead of demanding 'scheduled'", () => {
    // openSession refuses to convene while one is scheduled/collecting, and
    // `collecting` now lasts a whole cadence interval — so a restarted driver
    // meets an open session on every slot. Demanding `scheduled` wedged the
    // subject; adopting it, without republishing a brief over its advertised
    // deadline, is the reconciliation.
    expect(sessionSrc).toContain('waitForSubjectSession(subject.id, ["scheduled", "collecting"])');
    expect(sessionSrc).toContain('const adopted = opened.session.state === "collecting";');
  });

  test("the fast profile's window is the one CI actually runs, and it is two minutes", () => {
    expect(swarmWindowMinutes(resolveDemoCadence({ stage: false }))).toBe(2);
    expect(sessionSrc).toContain("resolveDemoCadence({ stage: false })");
  });
});

describe("red controls: the order grader must REPORT a regression", () => {
  test("it catches the close being moved back ahead of the wait", () => {
    const broken = sessionSrc.replace(
      /const closedWindow = await waitUntilWindowCloses\(/,
      'await enqueueLifecycleJob("close_window", { sessionId }, rail.adminToken);\n  const closedWindow = await waitUntilWindowCloses(',
    );
    const o = lifecycleOrder(broken);
    expect(o.close).toBeLessThan(o.windowWait);
  });

  test("it catches the wait being deleted entirely", () => {
    const broken = sessionSrc.replaceAll("await waitUntilWindowCloses(", "await Promise.resolve(");
    expect(lifecycleOrder(broken).windowWait).toBe(-1);
  });

  test("it catches the hardcoded hour coming back", () => {
    const broken = sessionSrc.replace("{ sessionId, windowMinutes, prevOutcome }", "{ sessionId, windowMinutes: 60, prevOutcome }");
    expect(broken).toContain("windowMinutes: 60");
    expect(sessionSrc.length).toBeGreaterThan(1000); // the scan is over real text
  });
});

// The driver waits out the window it advertised (issue #570) — executed, not
// grepped, in the required per-PR `unit` job.
//
// WHAT THIS PROTECTS. `scripts/lib/swarm/session.ts` used to publish a brief
// with a hardcoded 60-minute window and then close it the moment
// `mapSettledWithConcurrency` returned — i.e. when its OWN in-process
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
import { epochDurationSecondsFor } from "../../lib/swarm/session.ts";
import { resolveSmokeCadence } from "../../lib/smoke-cadence.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const T0 = Date.UTC(2026, 7, 7, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const LIMITS = { maxWaitMs: 300_000, graceMs: 1_000, pollMs: 5_000 };
// The wait is addressed BY SESSION ID now: turnover opens the successor in the
// same transaction that closes N (§4.3), so `getSession(date, subjectId)` — which
// resolves to "the latest session that day" — stops naming one row per subject
// per date. The label is only what an error message calls it.
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

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
    expect(planWindowWait(T0, undefined, LIMITS).reason).toContain("advertises no windowClosesAt");
    expect(planWindowWait(T0, "not-a-date", LIMITS).reason).toContain("not a parseable instant");
  });

  test("the ceiling is derived from the profile's own window, and bounds the fast one", () => {
    const fast = resolveSmokeCadence({ stage: false });
    const realistic = resolveSmokeCadence({ stage: true });
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
    const out = await waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, h.deps);
    expect(h.slept).toEqual([5_000, 5_000, 3_000]);
    expect(out.waitedMs).toBe(13_000);
    expect(out.windowClosesAt).toBe(closes);
    expect(out.clockFallbacks).toBe(0);
  });

  test("an already-elapsed window returns immediately without a single sleep", async () => {
    const h = harness([{ windowClosesAt: iso(T0 - 60_000), serverNowMs: T0 }]);
    const out = await waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, h.deps);
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
    const out = await waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, h.deps);
    expect(h.slept).toEqual([5_000]);
    expect(h.logs.join(" ")).toContain("host clock differs from the API's by 600s");
    expect(out.reason).toContain("window closed at");
  });

  test("an unreadable server clock falls back to the host's and SAYS SO", async () => {
    const h = harness([{ windowClosesAt: iso(T0 - 1_000), serverNowMs: null }]);
    const out = await waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, h.deps);
    expect(out.clockFallbacks).toBe(1);
  });

  test("a distant window throws instead of hanging the caller", async () => {
    const h = harness([{ windowClosesAt: iso(T0 + 86_400_000), serverNowMs: T0 }]);
    await expect(waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, h.deps))
      .rejects.toThrow(/refused:.*beyond the 300s ceiling/);
  });

  test("a session with no advertised deadline throws — the epoch open did not set one", async () => {
    const h = harness([{ windowClosesAt: null, serverNowMs: T0 }]);
    await expect(waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, h.deps))
      .rejects.toThrow(/advertises no windowClosesAt/);
  });

  test("a transient session read failure retries without inventing a missing deadline", async () => {
    const closes = iso(T0 + 2_000);
    let now = T0;
    let reads = 0;
    const logs: string[] = [];
    const out = await waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", LIMITS, {
      read: async () => {
        reads++;
        if (reads === 1) throw new Error("GET /api/swarm/sessions/2026-08-07/woon -> HTTP 502");
        return { windowClosesAt: closes, serverNowMs: now };
      },
      wait: async (ms: number) => { now += ms; },
      now: () => now,
      log: (line: string) => { logs.push(line); },
    });
    expect(reads).toBe(2);
    expect(out.windowClosesAt).toBe(closes);
    expect(logs.join(" ")).toContain("HTTP 502; retrying");
  });

  test("a persistently unreadable session endpoint still stops at the wait ceiling", async () => {
    let now = T0;
    const logs: string[] = [];
    await expect(waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", { maxWaitMs: 12_000, pollMs: 5_000 }, {
      read: async () => { throw new Error("HTTP 502"); },
      wait: async (ms: number) => { now += ms; },
      now: () => now,
      log: (line: string) => { logs.push(line); },
    })).rejects.toThrow(/exceeded its 12s ceiling.*last error: HTTP 502/);
    expect(logs).toHaveLength(3);
    expect(now - T0).toBe(12_000);
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
    await expect(waitUntilWindowCloses(SESSION_ID, "2026-08-07/woon", { maxWaitMs: 30_000, pollMs: 5_000 }, deps))
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

/**
 * The same source with comments stripped, for the NEGATIVE graders only.
 *
 * This repository's comments explain what was removed and why, by name. A
 * grader that read "the removed thing is not mentioned" off the raw text would
 * make the explanation itself the violation — so absence is asserted over the
 * code, exactly as scripts/tests/unit/no-inline-judge.test.ts does it.
 */
const sessionCode = sessionSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");

/**
 * Ordered positions of runSession's lifecycle landmarks; -1 when absent.
 *
 * The five queue enqueues these used to name are gone (issue #1026 W4), and so
 * are the epoch transitions that replaced them: D55 (4) makes system-scheduler
 * the only caller of open, turnover and settlement. The landmarks are now what
 * the driver OBSERVES of the real scheduler (system-scheduler-spec.md §8): the
 * epoch it opened (§4.1), and the settlement that follows the boundary (§4.3).
 */
export function lifecycleOrder(src: string) {
  return {
    open: src.indexOf("await waitForSchedulerEpoch(subject.id,"),
    settle: src.indexOf("const settled = await mapSettledWithConcurrency("),
    windowWait: src.indexOf("await waitUntilWindowCloses("),
    close: src.indexOf("await waitForSettlement("),
  };
}

describe("runSession closes on the WINDOW, not on its own agents settling", () => {
  const order = lifecycleOrder(sessionSrc);

  test("every landmark is present", () => {
    for (const [name, at] of Object.entries(order)) expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
  });

  test("the window wait sits between agent settlement and the scheduler's boundary the driver then watches", () => {
    expect(order.settle).toBeLessThan(order.windowWait);
    expect(order.windowWait).toBeLessThan(order.close);
  });

  test("the window length is set on the SUBJECT, from the cadence profile, before the epoch opens", () => {
    // §2.2: "each subject has one scheduling parameter: its epoch duration …
    // That is the entire schedule." A per-call `windowMinutes` is not
    // expressible any more, and §2.3 makes the admin subject update the only way
    // the column changes.
    expect(sessionSrc).toContain("const epochSeconds = epochDurationSecondsFor(cadence);");
    expect(sessionSrc).toContain("await setSubjectEpochDuration(subject.id, epochSeconds, rail.operatorToken);");
    const setAt = sessionSrc.indexOf("await setSubjectEpochDuration(subject.id, epochSeconds");
    expect(setAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(order.open);
    // Never a literal, and never an env var: SWARM_WINDOW_MINUTES is gone with
    // the cron payload it named, and giving it a second meaning here would let a
    // stale shell export silently change production behaviour.
    expect(sessionCode).not.toContain("windowMinutes");
    expect(sessionCode).not.toContain("SWARM_WINDOW_MINUTES");
  });

  test("the epoch duration is the profile's own window, in whole seconds", () => {
    const fast = resolveSmokeCadence({ stage: false });
    const realistic = resolveSmokeCadence({ stage: true });
    expect(epochDurationSecondsFor(fast)).toBe(fast.swarmWindowMs / 1000);
    expect(epochDurationSecondsFor(realistic)).toBe(realistic.swarmWindowMs / 1000);
    // Migration 0067's CHECK refuses anything else, so a profile that could not
    // produce a positive whole number is refused here rather than by a 23514.
    expect(() => epochDurationSecondsFor({ ...fast, swarmWindowMs: 0 })).toThrow(/positive whole number of seconds/);
    expect(() => epochDurationSecondsFor({ ...fast, swarmWindowMs: -1_000 })).toThrow(/positive whole number of seconds/);
  });

  test("the ceiling handed to the wait is derived from the same profile", () => {
    expect(sessionSrc).toContain("maxWaitMs: windowWaitCeilingMs(cadence)");
  });

  test("the epoch is the SCHEDULER's: the driver waits for it and opens nothing (D55 (4), scheduler spec §8)", () => {
    // §4.1: the scheduler opens the first epoch from the subject's
    // `subject.changed`, and §4.3's turnover opens every successor. The driver
    // reads the one it opened; it has no open call to adopt an answer from.
    expect(sessionSrc).toContain("const sessionId = opened.sessionId;");
    expect(sessionCode).not.toContain("openEpoch(");
    expect(sessionCode).not.toContain("turnOverEpoch(");
    expect(sessionCode).not.toContain("waitForSubjectSession");
  });

  test("there is no `scheduled` state left to wait for or to announce", () => {
    // §4.1: "There is no `scheduled` state and no 'brief opens later.'"
    expect(sessionCode).not.toContain('emitSession("scheduled"');
    expect(sessionCode).not.toContain("waitForSessionState");
  });

  test("every read of THIS session is addressed by id, never by (date, subject)", () => {
    // `getSession(date, subjectId)` resolves to "the LATEST session that day"
    // (backend/src/swarm/domain.ts), and §4.3's turnover opens the successor in
    // the same transaction that closes N — so from the boundary onward a subject
    // has two rows for one date and the date route answers with the wrong one.
    // The published-session read after finalize is the case that actually broke:
    // it would have read the fresh `collecting` epoch and found no rollup on it.
    expect(sessionCode).toContain("routePath(ROUTES.swarm.sessionById, { id: sessionId })");
    expect(sessionCode).not.toContain("ROUTES.swarm.session, { date, subject: subject.id }");
    expect(sessionCode).not.toContain("ROUTES.swarm.session, { date, subject }");
  });

  test("the fast profile's window is the one CI actually runs, and it is two minutes", () => {
    expect(epochDurationSecondsFor(resolveSmokeCadence({ stage: false }))).toBe(120);
    expect(sessionSrc).toContain("resolveSmokeCadence({ stage: false })");
  });
});

describe("red controls: the order grader must REPORT a regression", () => {
  test("it catches the turnover being moved back ahead of the wait", () => {
    // Anchored on the ASSIGNMENT, not on its right-hand side. It used to match
    // `const closedWindow = await waitUntilWindowCloses(` — and when the RHS
    // grew a twin branch (`skipAdoptedWindow ? … : await waitUntilWindowCloses`)
    // the regex stopped matching, the mutation stopped being applied, and this
    // control passed while asserting NOTHING. A red control that cannot go red
    // is worse than no control, so it is pinned below: the mutation must
    // actually change the source.
    const broken = sessionSrc.replace(
      /const closedWindow = /,
      'await waitForSettlement(sessionId, { maxWaitMs: 1 });\n  const closedWindow = ',
    );
    expect(broken).not.toBe(sessionSrc);
    const o = lifecycleOrder(broken);
    expect(o.close).toBeLessThan(o.windowWait);
  });

  test("it catches the wait being deleted entirely", () => {
    const broken = sessionSrc.replaceAll("await waitUntilWindowCloses(", "await Promise.resolve(");
    expect(lifecycleOrder(broken).windowWait).toBe(-1);
  });

  test("it catches the duration being set from a literal instead of the profile", () => {
    const broken = sessionSrc.replace(
      "await setSubjectEpochDuration(subject.id, epochSeconds, rail.operatorToken);",
      "await setSubjectEpochDuration(subject.id, 3600, rail.operatorToken);",
    );
    expect(broken).not.toBe(sessionSrc);
    expect(broken).not.toContain("await setSubjectEpochDuration(subject.id, epochSeconds, rail.operatorToken);");
    expect(sessionSrc.length).toBeGreaterThan(1000); // the scan is over real text
  });
});

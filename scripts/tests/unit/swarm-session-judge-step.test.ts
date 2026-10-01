// The HOST DRIVER OBSERVES settlement; it drives none of it (issue #1026 W4,
// D55 (4)) — executed, not grepped, in the required per-PR `unit` job.
//
// WHAT CHANGED UNDERNEATH THIS FILE. The driver used to run the judge step of
// settlement itself: `epochs/request-judging`, a wait bounded by the stored
// deadline, then `epochs/finalize`. D55 (4) makes `system-scheduler` the only
// caller of every epoch lifecycle transition (open, turnover, aggregate,
// request-judging, finalize), and those routes now refuse every credential but
// the scheduler's. So that driver code and the cases that executed it are gone
// with the feature, and what is tested here is what replaced it: the driver
// WAITS for the real scheduler (system-scheduler-spec.md §8: "runs the real
// scheduler; it does not bypass the scheduler") and REPORTS what the record
// holds.
//
// What survives unchanged is the reason this file exists (#817): the progress
// stream must tell a session that recorded a judgement apart from one that
// judged nothing, and must never announce a judging that did not land.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "../../lib/swarm/session.ts";
import {
  countJudgements,
  judgedProgress,
  OBSERVE_GRACE_MS,
  planEpochAdoption,
  sessionEmitter,
  waitForSchedulerEpoch,
  waitForSettlement,
} from "../../lib/swarm/session.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const T0 = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A fake clock the waits sleep on: `wait` advances it and records the sleep. */
function fakeClock() {
  let now = T0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    wait: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

// ---------------------------------------------------------------------------
// The driver makes NO lifecycle transition (D55 (4)).
// ---------------------------------------------------------------------------
/** Code only: comments dropped, so a comment naming a route is not a call. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "$1");
const EPOCH_ROUTES = ["epochOpen", "epochTurnover", "epochAggregate", "epochRequestJudging", "epochFinalize"];
const drivesAnEpoch = (src: string) => EPOCH_ROUTES.filter((r) => code(src).includes(`ROUTES.swarm.admin.${r}`) && !code(src).includes(`${r}, {`));

describe("the session driver calls no epoch lifecycle route (D55 (4), scheduler spec §8)", () => {
  test("session.ts names no epoch route outside its cross-role refusal probe", () => {
    // The one survivor is the cross-role probe in main(), which POSTs a
    // MEMBER's bearer at turnover to observe the refusal — a denial check,
    // not a transition. Every other epoch route is gone from the driver.
    const named = EPOCH_ROUTES.filter((r) => code(sessionSrc).includes(`ROUTES.swarm.admin.${r}`));
    expect(named).toEqual(["epochTurnover"]);
    const probe = code(sessionSrc).indexOf("ROUTES.swarm.admin.epochTurnover");
    expect(code(sessionSrc).slice(probe - 400, probe + 400)).toContain("Bearer ${testToken}");
    for (const gone of ["openEpoch(", "turnOverEpoch(", "aggregateEpoch(", "requestJudging(", "finalizeEpoch(", "runJudgeStep("]) {
      expect({ gone, found: code(sessionSrc).includes(gone) }).toEqual({ gone, found: false });
    }
  });

  test("red control: a driver that opens an epoch again is reported", () => {
    const broken = `${sessionSrc}\nfetch(\`\${backendUrl()}\${ROUTES.swarm.admin.epochOpen}\`, { method: "POST" });\n`;
    expect(drivesAnEpoch(broken)).toContain("epochOpen");
    expect(drivesAnEpoch(sessionSrc)).not.toContain("epochOpen");
  });
});

// ---------------------------------------------------------------------------
// planEpochAdoption / waitForSchedulerEpoch — waiting for the REAL scheduler.
// ---------------------------------------------------------------------------
describe("waitForSchedulerEpoch — the scheduler opens the epoch, the driver waits for it", () => {
  test("no epoch yet is a wait; an epoch on this subject's short grid is adopted", () => {
    expect(planEpochAdoption(T0, null, { epochSeconds: 120 }).action).toBe("wait");
    const epoch = { sessionId: SESSION_ID, date: "2026-09-25", windowClosesAt: iso(T0 + 90_000) };
    expect(planEpochAdoption(T0, epoch, { epochSeconds: 120 })).toMatchObject({ action: "adopt" });
  });

  test("an epoch the scheduler opened under a LONGER duration is refused, not waited out", () => {
    // Nothing but the scheduler turns an epoch over, so the driver cannot
    // shorten it; waiting would hang until a job timeout.
    const long = { sessionId: SESSION_ID, date: "2026-09-25", windowClosesAt: iso(T0 + 3_600_000) };
    const plan = planEpochAdoption(T0, long, { epochSeconds: 120 });
    expect(plan.action).toBe("abort");
    expect(plan.reason).toContain("longer duration");
    // …and the boundary is the epoch plus the grace, no tighter.
    const edge = { ...long, windowClosesAt: iso(T0 + 120_000 + OBSERVE_GRACE_MS) };
    expect(planEpochAdoption(T0, edge, { epochSeconds: 120 }).action).toBe("adopt");
  });

  test("an epoch with no parseable window is refused", () => {
    expect(planEpochAdoption(T0, { sessionId: SESSION_ID, date: "d", windowClosesAt: null }, { epochSeconds: 120 }).action).toBe("abort");
  });

  test("it polls until the scheduler's epoch appears, then returns it", async () => {
    const clock = fakeClock();
    let reads = 0;
    const epoch = { sessionId: SESSION_ID, date: "2026-09-25", windowClosesAt: iso(T0 + 100_000) };
    const got = await waitForSchedulerEpoch("woon", { epochSeconds: 120, maxWaitMs: 60_000 }, {
      readEpoch: async () => ({ epoch: ++reads >= 3 ? epoch : null, serverNowMs: clock.now() }),
      wait: clock.wait,
      now: clock.now,
    });
    expect(got).toEqual(epoch);
    expect(reads).toBe(3);
  });

  test("a scheduler that never opens one fails at the ceiling, naming where to look", async () => {
    const clock = fakeClock();
    await expect(
      waitForSchedulerEpoch("woon", { epochSeconds: 120, maxWaitMs: 10_000 }, {
        readEpoch: async () => ({ epoch: null, serverNowMs: clock.now() }),
        wait: clock.wait,
        now: clock.now,
      }),
    ).rejects.toThrow("smoke:status");
  });
});

// ---------------------------------------------------------------------------
// waitForSettlement — the scheduler settles; the driver watches.
// ---------------------------------------------------------------------------
describe("waitForSettlement — every state the scheduler moved the session through, in order", () => {
  test("it reports each distinct state once and returns at `published`", async () => {
    const clock = fakeClock();
    const script: (string | null)[] = ["window_closed", "window_closed", "aggregated", null, "judged", "published"];
    const seen: string[] = [];
    const out = await waitForSettlement(SESSION_ID, { maxWaitMs: 60_000 }, {
      readState: async () => (script.length > 0 ? script.shift()! : "published"),
      wait: clock.wait,
      now: clock.now,
    }, (s) => seen.push(s));
    expect(out.states).toEqual(["window_closed", "aggregated", "judged", "published"]);
    expect(seen).toEqual(out.states);
  });

  test("a session the scheduler never settles fails at the ceiling, naming what it saw", async () => {
    const clock = fakeClock();
    await expect(
      waitForSettlement(SESSION_ID, { maxWaitMs: 10_000 }, {
        readState: async () => "aggregated",
        wait: clock.wait,
        now: clock.now,
      }),
    ).rejects.toThrow("aggregated");
  });
});

describe("countJudgements — bounded by an AbortSignal timeout (issue #890)", () => {
  const realFetch = globalThis.fetch;
  const realBackend = process.env.BACKEND_URL;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = realBackend;
  });

  test("passes an AbortSignal to fetch and parses judgements successfully", async () => {
    process.env.BACKEND_URL = "http://count.invalid";
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: any, init?: any) => {
      receivedSignal = init?.signal;
      return new Response(JSON.stringify({ judgements: [{ id: 1 }, { id: 2 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const count = await countJudgements(SESSION_ID);
    expect(count).toBe(2);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  test("returns null when fetch aborts or times out within the bounded time", async () => {
    process.env.BACKEND_URL = "http://count.invalid";
    // Simulate a fetch that hangs until aborted by the signal
    globalThis.fetch = ((_input: any, init?: any) => {
      const signal: AbortSignal | undefined = init?.signal;
      return new Promise((_, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const start = Date.now();
    // Test with a short timeout to prove it returns null promptly
    const count = await countJudgements(SESSION_ID, undefined, { timeoutMs: 50 });
    const elapsed = Date.now() - start;

    expect(count).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });

  test("returns null when an external signal is already aborted", async () => {
    process.env.BACKEND_URL = "http://count.invalid";
    globalThis.fetch = ((_input: any, init?: any) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      }
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    const count = await countJudgements(SESSION_ID, undefined, { signal: controller.signal });
    expect(count).toBeNull();
  });
});



// ---------------------------------------------------------------------------
// The progress stream reports the judging from the RECORD (#817, #969).
// ---------------------------------------------------------------------------
const EVENT_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * runSession's post-settlement segment over the real emitter and the real
 * decision: the scheduler's states (judged and published held back), then the
 * record's judgement, then published.
 */
function settlementStream(states: string[], record: { recorded: number | null; source: string | null }) {
  const events: SessionEvent[] = [];
  const emitSession = sessionEmitter((ev) => events.push(ev), "woon", "2026-09-25");
  for (const state of states) {
    if (state !== "collecting" && state !== "judged" && state !== "published") emitSession(state, EVENT_SESSION_ID);
  }
  const judged = judgedProgress(record);
  if (judged) emitSession("judged", EVENT_SESSION_ID, judged);
  emitSession("published", EVENT_SESSION_ID);
  return events.map((e) => (e.type === "session" ? e.state : e.type));
}

describe("the progress stream reports the judging (#817)", () => {
  test("a judgement on the record — aggregated, judged, published IN THAT ORDER", () => {
    expect(settlementStream(["window_closed", "aggregated", "judging", "judged", "published"], { recorded: 1, source: "model" }))
      .toEqual(["window_closed", "aggregated", "judging", "judged", "published"]);
  });

  test("`off` or `no_consensus` — nothing recorded — emits NO judged", () => {
    expect(settlementStream(["window_closed", "aggregated", "published"], { recorded: 0, source: null }))
      .toEqual(["window_closed", "aggregated", "published"]);
  });

  test("an unreadable record is not treated as a judging", () => {
    expect(settlementStream(["window_closed", "aggregated", "published"], { recorded: null, source: null })).not.toContain("judged");
  });
});

describe("judgedProgress — the decision, graded directly", () => {
  test("it fires only when a judgement is on the record, and carries who authored it", () => {
    expect(judgedProgress({ recorded: 1, source: "model" })).toEqual({ judgeMode: "enforce", judgeSource: "model" });
    expect(judgedProgress({ recorded: 2, source: null })).toEqual({ judgeMode: "enforce" });
    expect(judgedProgress({ recorded: 0, source: "model" })).toBeNull();
    expect(judgedProgress({ recorded: null, source: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SOURCE-TEXT CHECK on runSession's ORDER: settle, then read the record, then
// announce judged, then published.
// ---------------------------------------------------------------------------
const SETTLE = "await waitForSettlement(";
const JUDGED_EMIT = 'if (judged) emitSession("judged", sessionId, judged);';
const PUBLISHED_EMIT = 'emitSession("published", sessionId);';

function settleOrder(src: string) {
  const settle = src.indexOf(SETTLE);
  return {
    open: src.indexOf("await waitForSchedulerEpoch("),
    window: src.indexOf("await waitUntilWindowCloses("),
    settle,
    judged: src.indexOf(JUDGED_EMIT, settle),
    published: src.indexOf(PUBLISHED_EMIT, settle),
  };
}

describe("runSession observes: epoch, window, settlement, judged, published", () => {
  test("every landmark is present and in order", () => {
    const o = settleOrder(sessionSrc);
    for (const [name, at] of Object.entries(o)) expect({ name, at: at > -1 }).toEqual({ name, at: true });
    expect(o.open).toBeLessThan(o.window);
    expect(o.window).toBeLessThan(o.settle);
    expect(o.settle).toBeLessThan(o.judged);
    expect(o.judged).toBeLessThan(o.published);
  });

  test("red control: a published announced before the judged is reported", () => {
    const broken = sessionSrc.replace(JUDGED_EMIT, "").replace(PUBLISHED_EMIT, `${PUBLISHED_EMIT}\n  ${JUDGED_EMIT}`);
    const o = settleOrder(broken);
    expect(o.judged > o.published).toBe(true);
  });
});

// The HOST DRIVER runs the judge step of settlement (issue #767, rewired for
// issue #1026 W4) — executed, not grepped, in the required per-PR `unit` job.
//
// WHAT THIS PROTECTS, AND WHAT CHANGED UNDERNEATH IT.
//
// The judge used to be an out-of-band `swarm.judge` QUEUE JOB this driver
// enqueued by hand, because the only other way a session got one was
// `POST /api/swarm/admin/sessions` — a path production never took. Both are
// gone. Settlement is now the chain of docs/technical/system-scheduler-spec.md
// §4.4, driven through synchronous admin calls, and the judge step is
// `epochs/request-judging` plus a wait bounded by the deadline the API STORES.
//
// What survives unchanged is the reason this file exists: the judge sits
// between the rollup it reads and the finalize that publishes, and a driver
// that skipped it, or that reported a judging it did not get, would be invisible
// to every behavioural test in the repository.
//
// runSession itself drives docker, the epoch admin API and live inference, so it
// cannot be executed here. `runJudgeStep` is pure over four injected effects and
// IS executed, with no network and no timers; its POSITION in runSession is
// pinned by source-text order, and each order grader is graded against a broken
// fixture so it cannot go vacuously green.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeMode, JudgementWaitOutcome, SessionEvent } from "../../lib/swarm/session.ts";
import { countJudgements, judgedProgress, runJudgeStep, sessionEmitter, waitForJudgement } from "../../lib/swarm/session.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const DEADLINE = "2026-08-31T12:15:00.000Z";

/** Records every effect runJudgeStep reaches for, in the order it reaches. */
function harness(
  mode: JudgeMode,
  opts: {
    /** The wait ended at the deadline with nothing landed, rather than on a judging. */
    deadlineReached?: boolean;
    /** `epochs/request-judging` refused, with this reason. */
    refuseWith?: string;
    recorded?: number | null;
    /** Who authored the in-force judgement (issue #969). Defaults to a real model. */
    source?: string | null;
  } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps = {
    requestJudging: async () => {
      calls.push("requestJudging");
      if (opts.refuseWith) return { ok: false as const, status: 409, error: opts.refuseWith };
      return {
        ok: true as const, status: 200, sessionId: SESSION_ID, state: "judging" as const,
        deadlineAt: DEADLINE, transitioned: true,
      };
    },
    waitForJudgement: async (deadlineAt: string): Promise<JudgementWaitOutcome> => {
      calls.push(`waitForJudgement:${deadlineAt}`);
      return opts.deadlineReached
        ? { judged: false, reason: "deadline", waitedMs: 900_000 }
        : { judged: true, reason: "judged", waitedMs: 4_000 };
    },
    // Read ONLY on the deadline path, to say which of two things happened.
    countJudgements: async () => { calls.push("countJudgements"); return "recorded" in opts ? opts.recorded! : 0; },
    // WHO AUTHORED IT (issue #969). `judged (enforce)` was the strongest thing
    // this step could report, and it was equally true of a session whose
    // opinion came from a template because the judge had no model at all.
    readProvenance: async () => {
      calls.push("readProvenance");
      const source = "source" in opts ? opts.source! : "model";
      return { source, fallbackReason: source === "fallback" ? "model_unconfigured" : null, model: "judge-model" };
    },
    log: (line: string) => { logs.push(line); },
  };
  return { calls, logs, deps };
}

const run = (mode: JudgeMode, opts?: Parameters<typeof harness>[1]) => {
  const h = harness(mode, opts);
  return { h, result: runJudgeStep(SESSION_ID, mode, "tok", h.deps) };
};

describe("runJudgeStep — the driver's judge step, executed", () => {
  test("`off` — the shipped default — requests NOTHING and waits for NOTHING", async () => {
    const { h, result } = run("off");
    const out = await result;
    // §4.4: under `off` "no judging is requested and nothing waits.
    // `aggregated → publish` directly, with judging outcome `not_judged`."
    // There is no queued job draining as a skip any more, so an effect reached
    // here at all would be a request nobody asked for.
    expect(h.calls).toEqual([]);
    expect(out).toEqual({
      mode: "off", requested: false, waitedForJudged: false, judged: false, recorded: null, deadlineAt: null,
    });
  });

  test("…and says so as a normal outcome, never as a failure", async () => {
    // §4.4, verbatim: "This is not a failure and is never presented as one."
    const { h } = run("off");
    await runJudgeStep(SESSION_ID, "off", "tok", h.deps);
    const log = h.logs.join("\n");
    expect(log).toContain("not_judged");
    expect(log).toContain("not a failure");
    for (const alarming of ["FAIL", "error", "expired", "wedged"]) {
      expect({ alarming, found: log.includes(alarming) }).toEqual({ alarming, found: false });
    }
  });

  test("`enforce` requests judging and waits on the deadline the API STORED", async () => {
    const { h, result } = run("enforce");
    const out = await result;
    expect(h.calls).toEqual([`requestJudging`, `waitForJudgement:${DEADLINE}`, "readProvenance"]);
    // The deadline handed to the wait is the API's, not one this driver chose.
    // §9: "a judging deadline is stored by the API when judging is requested and
    // is never restarted by a rebuild."
    expect(out).toEqual({
      mode: "enforce", requested: true, waitedForJudged: true, judged: true,
      recorded: null, deadlineAt: DEADLINE, source: "model",
    });
  });

  // ISSUE #969. Before this, `judged (enforce)` was the whole report, and it was
  // true of a session whose opinion came from a template because the judge had
  // no model. The judge cannot author one of those any more, but a pre-#969 row
  // can still be the one in force, so the step carries WHO AUTHORED IT and the
  // log says so rather than leaving it to be inferred from the mode.
  test("a judging no model authored is reported as such, not as a healthy `judged`", async () => {
    const { h, result } = run("enforce", { source: "fallback" });
    const out = await result;
    expect(out.source).toBe("fallback");
    expect(h.logs.join("\n")).toContain("source=fallback");
    expect(h.logs.join("\n")).toContain("model_unconfigured");
    // And the progress stream carries it to the TUI rather than stopping at the mode.
    expect(judgedProgress(out)).toEqual({ judgeMode: "enforce", judgeSource: "fallback" });
  });

  test("a deadline reached with nothing recorded is `no_consensus`, not an error", async () => {
    const { h, result } = run("enforce", { deadlineReached: true, recorded: 0 });
    const out = await result;
    // §4.4: "a session with no consensus says so … no template opinion, no
    // placeholder certificate, no default verdict." The step returns normally so
    // the caller finalizes and the API publishes that outcome.
    expect(out).toEqual({
      mode: "enforce", requested: true, waitedForJudged: true, judged: false,
      recorded: 0, deadlineAt: DEADLINE, source: null,
    });
    expect(h.logs.join("\n")).toContain("no_consensus");
    expect(h.logs.join("\n")).toContain("nothing fabricated");
  });

  test("a row on file at the deadline is reported WITHOUT the driver deciding eligibility", async () => {
    // §10: "eligibility is decided by stored time, not event arrival" — a
    // consensus recorded before the stored deadline whose notice reached the
    // caller late still yields `judged`. This driver has no business deciding
    // that, and the log says which of the two facts it is looking at.
    const { h, result } = run("enforce", { deadlineReached: true, recorded: 2 });
    await result;
    const log = h.logs.join("\n");
    expect(h.calls, "the record is read only on the deadline path").toEqual(
      ["requestJudging", `waitForJudgement:${DEADLINE}`, "countJudgements", "readProvenance"],
    );
    expect(log).toContain("2 judgement row(s) ARE recorded");
    expect(log).toContain("finalize decides eligibility from the stored acceptance instant");
    expect(log).not.toContain("NO judgement row");
  });

  test("an unreadable record says so rather than guessing either way", async () => {
    const { h, result } = run("enforce", { deadlineReached: true, recorded: null });
    await result;
    expect(h.logs.join("\n")).toContain("could not read the judgement record");
  });

  test("a `judge_mode_off` refusal is the NORMAL answer under `off`, and publishes through", async () => {
    // §4.4: request-judging refuses under `off`. Reached here only when the
    // session's captured mode and the API's stored one disagree — worth naming,
    // never worth wedging the cadence over.
    const { h, result } = run("enforce", { refuseWith: "judge_mode_off" });
    const out = await result;
    expect(out).toEqual({
      mode: "off", requested: false, waitedForJudged: false, judged: false, recorded: null, deadlineAt: null,
    });
    expect(h.calls).toEqual(["requestJudging"]);
    expect(h.logs.join("\n")).toContain("judge_mode_off");
    expect(h.logs.join("\n")).toContain("not_judged");
  });

  test("any OTHER refusal aborts — nothing was requested, so nothing can land", async () => {
    // §4.6: "a refusal with a reason … is final." A session that is not
    // `aggregated` cannot be judged, and continuing would publish a session
    // whose judge step silently did not happen.
    const { h, result } = run("enforce", { refuseWith: "session_not_aggregated" });
    await expect(result).rejects.toThrow(/session_not_aggregated/);
    expect(h.calls).toEqual(["requestJudging"]);
    expect(h.logs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// waitForJudgement — the ONE asynchronous step left, on a fake clock.
// ---------------------------------------------------------------------------
describe("waitForJudgement — bounded by the STORED deadline, never by a local ceiling", () => {
  const T0 = Date.UTC(2026, 7, 31, 12, 0, 0);
  const iso = (ms: number) => new Date(ms).toISOString();

  function clock(states: (string | null)[], startMs = T0) {
    let now = startMs;
    let i = 0;
    const slept: number[] = [];
    return {
      slept,
      elapsed: () => now - startMs,
      deps: {
        readState: async () => states[Math.min(i++, states.length - 1)],
        wait: async (ms: number) => { now += ms; slept.push(ms); },
        now: () => now,
      },
    };
  }

  test("it returns as soon as the session reaches `judged`", async () => {
    const c = clock(["aggregated", "judging", "judged"]);
    const out = await waitForJudgement(SESSION_ID, iso(T0 + 900_000), c.deps);
    expect(out).toEqual({ judged: true, reason: "judged", waitedMs: 4_000 });
    expect(c.slept).toEqual([2_000, 2_000]);
  });

  test("`published` also ends the wait — something already finalized it", async () => {
    const c = clock(["published"]);
    expect((await waitForJudgement(SESSION_ID, iso(T0 + 900_000), c.deps)).reason).toBe("judged");
  });

  test("it waits out the WHOLE stored deadline when nothing lands, and no longer", async () => {
    // Giving up early would only earn a refusal: §4.4's finalize "refuses
    // finalize as a reasoned no-op until the deadline has passed", so a shorter
    // local ceiling would make the driver ask a question it cannot yet be
    // answered and then publish nothing.
    const c = clock(["judging"]);
    const out = await waitForJudgement(SESSION_ID, iso(T0 + 10_000), c.deps);
    expect(out).toEqual({ judged: false, reason: "deadline", waitedMs: 10_000 });
    expect(c.slept).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  test("the final sleep is the exact remainder, never an overshoot past the deadline", async () => {
    const c = clock(["judging"]);
    await waitForJudgement(SESSION_ID, iso(T0 + 3_000), c.deps);
    expect(c.slept).toEqual([2_000, 1_000]);
  });

  test("an unreadable session state is not a judgement — the wait continues to the deadline", async () => {
    const c = clock([null]);
    expect((await waitForJudgement(SESSION_ID, iso(T0 + 4_000), c.deps)).judged).toBe(false);
  });

  test("an unparseable deadline THROWS rather than substituting one of this driver's own", async () => {
    const c = clock(["judging"]);
    await expect(waitForJudgement(SESSION_ID, "not-an-instant", c.deps))
      .rejects.toThrow(/will not substitute a deadline of its own/);
  });
});

// ---------------------------------------------------------------------------
// countJudgements bounds fetch with an AbortSignal (issue #890).
// Executed against a stubbed fetch — no network, no server.
// ---------------------------------------------------------------------------
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
// SOURCE-TEXT CHECK on runSession's ORDER: the judge sits between the rollup it
// reads and the finalize it must precede.
// ---------------------------------------------------------------------------
const JUDGE_CALL = "await runJudgeStep(sessionId, turned.judgeMode, rail.automationToken);";

/** Ordered positions of the judge step's neighbours in runSession; -1 absent. */
export function judgeStepOrder(src: string) {
  return {
    aggregate: src.indexOf("await aggregateEpoch(sessionId, rail.automationToken)"),
    judge: src.indexOf(JUDGE_CALL),
    finalize: src.indexOf("await finalizeEpoch(sessionId, rail.automationToken)"),
  };
}

describe("runSession puts the judge between aggregate and finalize", () => {
  const order = judgeStepOrder(sessionSrc);

  test("every landmark is present — the driver calls runJudgeStep at all", () => {
    for (const [name, at] of Object.entries(order)) expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
  });

  test("aggregate, then judge, then finalize", () => {
    expect(order.aggregate).toBeLessThan(order.judge);
    expect(order.judge).toBeLessThan(order.finalize);
  });

  test("the mode passed in is the one TURNOVER captured, not one re-read off the switch", () => {
    // §4.4: "Judge mode is captured at turnover … An admin changing the mode
    // afterwards affects later sessions, never one already settling." A
    // `readJudgeMode()` here would race the operator and could brief this step
    // on a mode this session was never settling under.
    expect(sessionSrc).toContain(JUDGE_CALL);
    const judgeAt = sessionSrc.indexOf(JUDGE_CALL);
    const runSessionAt = sessionSrc.indexOf("export async function runSession(");
    expect(sessionSrc.slice(runSessionAt, judgeAt)).not.toContain("readJudgeMode(");
  });
});

describe("red controls: the judge-order graders must REPORT a regression", () => {
  test("it catches the judge step being deleted entirely", () => {
    const broken = sessionSrc.replace(JUDGE_CALL, "");
    expect(judgeStepOrder(broken).judge).toBe(-1);
  });

  test("it catches the judge step being moved after the finalize", () => {
    const FINALIZE = "await finalizeEpoch(sessionId, rail.automationToken)";
    const broken = sessionSrc
      .replace(JUDGE_CALL, "")
      .replace(FINALIZE, `${FINALIZE};\n  ${JUDGE_CALL}`);
    const o = judgeStepOrder(broken);
    expect(o.judge).toBeGreaterThan(o.finalize);
    expect(sessionSrc.length).toBeGreaterThan(1000); // the scan is over real text
  });
});

// ---------------------------------------------------------------------------
// THE PROGRESS STREAM (issue #817).
//
// The defect this section grades is not "no judgement was recorded" — the rows
// were there all along. It is that the one surface an operator watches emitted
// `aggregated` and then `published` whether the session had judged or not, so a
// judging that landed was indistinguishable from a judge that was off.
// Every assertion below is therefore ON THE EVENTS, never on a judgement row.
//
// runSession drives docker, the epoch admin API and live inference, so it cannot
// be executed here. What CAN be executed is every piece it composes: the real
// `sessionEmitter`, the real `runJudgeStep` over injected effects, and the real
// `judgedProgress` decision. The segment below wires exactly those three in
// exactly the order runSession wires them — and that ORDER is not taken on
// trust: the source-text graders above pin it against runSession itself, each
// with a red control.
// ---------------------------------------------------------------------------

const EVENT_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * runSession's aggregate → judge → finalize segment, over the real emitter and
 * the real decision, with only the judge's four effects injected.
 * Returns the events a viewer would have seen, in order.
 */
async function judgeSegmentStream(
  mode: JudgeMode,
  opts: Parameters<typeof harness>[1] = {},
) {
  const events: SessionEvent[] = [];
  const emitSession = sessionEmitter((ev) => events.push(ev), "woon", "2026-08-31");
  const h = harness(mode, opts);

  emitSession("aggregated", EVENT_SESSION_ID);
  const judgeOutcome = await runJudgeStep(SESSION_ID, mode, "tok", h.deps);
  const judged = judgedProgress(judgeOutcome);
  if (judged) emitSession("judged", EVENT_SESSION_ID, judged);
  emitSession("published", EVENT_SESSION_ID);

  return { events, states: events.map((e) => e.type === "session" ? e.state : e.type), logs: h.logs };
}

describe("the progress stream reports the judging (#817)", () => {
  test("`enforce` — a judged session emits aggregated, judged, published IN THAT ORDER", async () => {
    const { events, states } = await judgeSegmentStream("enforce");
    expect(states).toEqual(["aggregated", "judged", "published"]);
    expect(events[1]).toEqual({
      type: "session",
      state: "judged",
      sessionId: EVENT_SESSION_ID,
      subject: "woon",
      date: "2026-08-31",
      judgeMode: "enforce",
      // Issue #969: the stream carries WHO AUTHORED the opinion, not only the
      // mode it was recorded under.
      judgeSource: "model",
    });
  });

  test("`off` — the shipped default — emits aggregated, published and NO judged", async () => {
    const { states, events } = await judgeSegmentStream("off");
    // This is the distinction the stream could not previously draw: `not_judged`
    // now looks different from a judgement that landed.
    expect(states).toEqual(["aggregated", "published"]);
    expect(events.some((e) => e.type === "session" && e.state === "judged")).toBe(false);
  });

  test("a judging on file at the deadline still produces the event", async () => {
    // Keyed on the RECORD, not on the poll's opinion: §10 decides eligibility
    // from the stored acceptance instant, so a row this driver noticed late is
    // still a judging finalize may well publish as `judged`.
    const { states, events, logs } = await judgeSegmentStream("enforce", { deadlineReached: true, recorded: 1 });
    expect(states).toEqual(["aggregated", "judged", "published"]);
    expect((events[1] as Extract<SessionEvent, { type: "session" }>).judgeMode).toBe("enforce");
    expect(logs.join("\n")).toContain("1 judgement row(s) ARE recorded");
  });

  test("a deadline with NOTHING recorded emits no judged — the stream and the log say the same thing", async () => {
    const { states, logs } = await judgeSegmentStream("enforce", { deadlineReached: true, recorded: 0 });
    expect(states).toEqual(["aggregated", "published"]);
    expect(logs.join("\n")).toContain("NO judgement row was recorded");
  });

  test("an unreadable judgement record is not treated as a judging", async () => {
    // `null` means "could not read", which is not `0` and is certainly not a
    // judgement. Claiming `judged` here would put a fact on the stream that
    // nothing established.
    const { states } = await judgeSegmentStream("enforce", { deadlineReached: true, recorded: null });
    expect(states).toEqual(["aggregated", "published"]);
  });
});

describe("judgedProgress — the decision, graded directly", () => {
  const outcome = (o: Partial<Parameters<typeof judgedProgress>[0]>) =>
    judgedProgress({
      mode: "off", requested: false, waitedForJudged: false, judged: false,
      recorded: null, deadlineAt: null, ...o,
    });

  test("it fires only for `enforce`, and only when a judging actually landed", () => {
    expect(outcome({ mode: "enforce", judged: true })).toEqual({ judgeMode: "enforce" });
    expect(outcome({ mode: "enforce", judged: false, recorded: 3 })).toEqual({ judgeMode: "enforce" });
    expect(outcome({ mode: "enforce", judged: false, recorded: 0 })).toBeNull();
    expect(outcome({ mode: "enforce", judged: false, recorded: null })).toBeNull();
    expect(outcome({ mode: "off", judged: false })).toBeNull();
  });

  test("`off` can never emit, even if the record somehow says otherwise", () => {
    // Belt and braces on the acceptance criterion: `off` is the shipped default
    // and must stay silent whatever else is true — §4.4 says it "is never
    // presented as" a failure, and announcing a judging it did not have would be
    // the opposite error.
    expect(outcome({ mode: "off", judged: true, recorded: 9 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SOURCE-TEXT CHECK on the EVENT's position and on the return no longer being
// discarded — the two things judgeSegmentStream above mirrors and therefore
// cannot itself prove.
// ---------------------------------------------------------------------------
const JUDGED_EMIT = 'if (judged) emitSession("judged", sessionId, judged);';

export function judgedEventOrder(src: string) {
  return {
    aggregated: src.indexOf('emitSession("aggregated", sessionId);'),
    judged: src.indexOf(JUDGED_EMIT),
    published: src.indexOf('emitSession("published", sessionId);'),
  };
}

describe("runSession emits `judged` between `aggregated` and `published`", () => {
  const order = judgedEventOrder(sessionSrc);

  test("the event exists at all", () => {
    for (const [name, at] of Object.entries(order)) expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
  });

  test("aggregated, then judged, then published", () => {
    expect(order.aggregated).toBeLessThan(order.judged);
    expect(order.judged).toBeLessThan(order.published);
  });

  test("the judge step's return value is READ, not discarded", () => {
    // The whole defect: `await runJudgeStep(...)` with the result dropped.
    expect(sessionSrc).toContain(`const judgeOutcome = ${JUDGE_CALL}`);
    expect(sessionSrc).toContain("const judged = judgedProgress(judgeOutcome);");
  });

  test("the emit is guarded — runSession never announces a judging unconditionally", () => {
    expect(sessionSrc).not.toContain('emitSession("judged", sessionId);');
  });
});

describe("red controls: the judged-event graders must REPORT a regression", () => {
  test("it catches the event being deleted", () => {
    expect(judgedEventOrder(sessionSrc.replace(JUDGED_EMIT, "")).judged).toBe(-1);
  });

  test("it catches the event being moved after the publish", () => {
    const broken = sessionSrc
      .replace(JUDGED_EMIT, "")
      .replace('emitSession("published", sessionId);', `emitSession("published", sessionId);\n  ${JUDGED_EMIT}`);
    const o = judgedEventOrder(broken);
    expect(o.judged).toBeGreaterThan(o.published);
  });

  test("it catches the guard being dropped, which would announce a judging in `off`", () => {
    const broken = sessionSrc.replace(JUDGED_EMIT, 'emitSession("judged", sessionId);');
    expect(broken).toContain('emitSession("judged", sessionId);');
    expect(judgedEventOrder(broken).judged).toBe(-1);
  });
});

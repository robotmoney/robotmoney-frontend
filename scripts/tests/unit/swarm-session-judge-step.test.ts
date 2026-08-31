// The HOST DRIVER schedules the consensus judge (issue #767) — executed, not
// grepped, in the required per-PR `unit` job.
//
// WHAT THIS PROTECTS. There are two ways a swarm session comes into being, and
// only one of them is the one production runs:
//
//   1. `POST /api/swarm/admin/sessions` -> `createSessionAdmin`, which enqueues
//      all five lifecycle jobs up front at instants derived from the session's
//      own timestamps. This is the admin form. Production does not use it.
//   2. `scripts/lib/swarm/session.ts` — the host driver, the real scheduler
//      whenever `SWARM_SCHEDULES_ENABLED` is "0" (see
//      scripts/lib/smoke-schedule.ts). It opens a session with `open_session`
//      (`domain.openSession` enqueues NOTHING) and then enqueues each step by
//      hand as the previous one lands.
//
// #767 first put `swarm.judge` on path 1's job set only. That gave a judging to
// admin-created sessions and to NO session production creates — a PATH gap, not
// a temporal one: it does not close by waiting. These tests own path 2.
//
// runSession itself drives docker, the job queue and live inference, so it
// cannot be executed here. The decision it delegates to — runJudgeStep — is
// pure over four injected effects and IS executed, with no network and no
// timers; its POSITION in runSession is pinned by source-text order, and each
// order grader is graded against a broken fixture so it cannot go vacuously
// green.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "../../lib/swarm/session.ts";
import { enqueueLifecycleJob, judgedProgress, runJudgeStep, sessionEmitter } from "../../lib/swarm/session.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** Records every effect runJudgeStep reaches for, in the order it reaches. */
function harness(
  mode: string | null,
  opts: { waitFails?: boolean; enqueueFails?: boolean; recorded?: number | null } = {},
) {
  const calls: string[] = [];
  const enqueued: { action: string; payload: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const deps = {
    readMode: async () => { calls.push("readMode"); return mode; },
    enqueue: async (action: string, payload: Record<string, unknown>) => {
      calls.push(`enqueue:${action}`);
      enqueued.push({ action, payload });
      // What enqueueLifecycleJob does on a non-2xx since #806: it throws rather
      // than returning an error body the caller reads fields off.
      if (opts.enqueueFails) throw new Error("enqueue-job 'judge' failed (HTTP 403): {\"error\":\"forbidden\"}");
      return { jobId: 77, kind: `swarm.${action}` };
    },
    waitForJudged: async () => {
      calls.push("waitForJudged");
      if (opts.waitFails) throw new Error("session did not reach 'judged' within 120000ms");
      return {};
    },
    // Read ONLY on the expiry path, to say which failure this was.
    countJudgements: async () => { calls.push("countJudgements"); return "recorded" in opts ? opts.recorded! : 0; },
    log: (line: string) => { logs.push(line); },
  };
  return { calls, enqueued, logs, deps };
}

const run = (mode: string | null, opts?: { waitFails?: boolean; enqueueFails?: boolean; recorded?: number | null }) => {
  const h = harness(mode, opts);
  return { h, result: runJudgeStep(SESSION_ID, "2026-08-31", "woon", "tok", h.deps) };
};

describe("runJudgeStep — the driver's judge step, executed", () => {
  test("the judging is ALWAYS queued, with the exact action the enqueue-job dispatcher maps to swarm.judge", async () => {
    for (const mode of ["off", "shadow", "enforce", null]) {
      const { h, result } = run(mode);
      await result;
      // `judge` is the key in backend/src/api/routes/swarm.ts's actionMap; any
      // other string is a 400 `unknown action`, silently skipping the judging.
      expect(h.enqueued.map((e) => e.action), `mode=${mode}`).toEqual(["judge"]);
      expect(h.enqueued[0].payload, `mode=${mode}`).toEqual({ sessionId: SESSION_ID });
    }
  });

  test("the switch is read BEFORE the job is queued, so the branch is about the mode in force when the step ran", async () => {
    const { h, result } = run("shadow");
    await result;
    expect(h.calls.indexOf("readMode")).toBe(0);
    expect(h.calls.indexOf("readMode")).toBeLessThan(h.calls.indexOf("enqueue:judge"));
  });

  test("`off` — the shipped default — queues the judging and waits for NOTHING", async () => {
    const { h, result } = run("off");
    const out = await result;
    // Waiting here would burn the two-minute ceiling on every session, for a
    // `judged` state that a disabled judge never produces: the job drains as
    // `{ skipped: "judge_disabled" }` and the session stays `aggregated`.
    expect(h.calls).toEqual(["readMode", "enqueue:judge"]);
    expect(out).toEqual({ mode: "off", waitedForJudged: false, judged: false, recorded: null });
    expect(h.logs.join("\n")).toContain("judge mode=off");
  });

  test("`shadow` waits for 'judged' — which is what stops the publish that follows from beating the judging", async () => {
    const { h, result } = run("shadow");
    const out = await result;
    // THE REGRESSION THIS CATCHES: `swarm.publish` is an unconditional
    // `UPDATE ... SET state='published'`, and the judge needs `aggregated ->
    // judged` to still be legal when its model call returns up to a minute
    // later. Enqueue both back to back and the publish wins, the transition is
    // refused, the whole judging transaction rolls back, and the soak records
    // nothing.
    expect(h.calls).toEqual(["readMode", "enqueue:judge", "waitForJudged"]);
    expect(out).toEqual({ mode: "shadow", waitedForJudged: true, judged: true, recorded: null });
  });

  test("`enforce` waits on the same terms", async () => {
    const { h, result } = run("enforce");
    expect(await result).toEqual({ mode: "enforce", waitedForJudged: true, judged: true, recorded: null });
    expect(h.calls).toEqual(["readMode", "enqueue:judge", "waitForJudged"]);
  });

  test("an unreadable switch still queues the judging, and does not wait for a state it cannot predict", async () => {
    const { h, result } = run(null);
    const out = await result;
    expect(h.calls).toEqual(["readMode", "enqueue:judge"]);
    expect(out).toEqual({ mode: null, waitedForJudged: false, judged: false, recorded: null });
    expect(h.logs.join("\n")).toContain("unreadable");
  });

  test("a wait that expires PUBLISHES ANYWAY — a slow judge must never wedge the session cadence", async () => {
    const { h, result } = run("shadow", { waitFails: true });
    const out = await result;
    // `recorded` is carried out of the expiry path because it, not the wait's
    // opinion, is what the progress stream keys the `judged` event on (#817).
    expect(out).toEqual({ mode: "shadow", waitedForJudged: true, judged: false, recorded: 0 });
    // Loud, not silent: the operator reading the driver's log learns the
    // session published without its judging, and why.
    expect(h.logs.join("\n")).toContain("publishing anyway");
    // The line reports the WAIT expiring — an event this driver observed — and
    // no longer asserts "the judge did not reach 'judged' in time", which on
    // the single-worker lane is usually false (#817).
    expect(h.logs.join("\n")).toContain("wait for the session to reach 'judged' EXPIRED");
    expect(h.logs.join("\n")).not.toContain("did not reach 'judged' in time");
  });

  // ── The expiry log must not assert something it did not check (#806) ──────
  //
  // "did not reach 'judged' in time" reads as "the judge was slow". On the
  // single-worker swarm lane that is usually FALSE: publish is enqueued only
  // after this wait returns and cannot be claimed while the judge holds the
  // lane, so an expiry here is far more often a judging that RAN and was
  // refused, or one still queued behind a wedged lane. The record settles it.

  test("the expiry log names the queued job and says whether a judgement row exists — 'the judging ran'", async () => {
    const { h, result } = run("enforce", { waitFails: true, recorded: 2 });
    await result;
    const log = h.logs.join("\n");
    expect(h.calls, "the record is read only on the expiry path").toEqual(
      ["readMode", "enqueue:judge", "waitForJudged", "countJudgements"],
    );
    expect(log).toContain("judge job #77 was queued");
    expect(log).toContain("2 judgement row(s) ARE recorded");
    expect(log).not.toContain("NO judgement row");
  });

  test("…and the other answer is distinguishable — 'the judging did not run to completion'", async () => {
    const { h, result } = run("shadow", { waitFails: true, recorded: 0 });
    await result;
    expect(h.logs.join("\n")).toContain("NO judgement row was recorded");
  });

  test("an unreadable record says so rather than guessing either way", async () => {
    const { h, result } = run("shadow", { waitFails: true, recorded: null });
    await result;
    expect(h.logs.join("\n")).toContain("could not read the judgement record");
  });

  // ── A FAILED ENQUEUE IS NOT A SLOW JUDGE (#806) ───────────────────────────
  //
  // The enqueue sits OUTSIDE the try/catch that guards the wait, and it has to:
  // the judge step is the ONLY lifecycle step whose wait failure is caught, so
  // an enqueue folded into that catch would be the only place in the driver
  // where "the queue refused me" is survivable — and it would publish the
  // session and blame a slow judge in the log.
  test("a non-2xx enqueue ABORTS the run — it never falls through to the wait, and never to the publish", async () => {
    const { h, result } = run("shadow", { enqueueFails: true });
    await expect(result).rejects.toThrow(/enqueue-job 'judge' failed \(HTTP 403\)/);
    // waitForJudged was never reached, so runSession's `publish` line — which
    // follows this call — is never reached either: the run fails loudly.
    expect(h.calls).toEqual(["readMode", "enqueue:judge"]);
    expect(h.logs).toEqual([]);
  });

  test("it aborts at the shipped `off` too, where nothing waits and the failure would otherwise be invisible", async () => {
    const { h, result } = run("off", { enqueueFails: true });
    await expect(result).rejects.toThrow(/HTTP 403/);
    expect(h.calls).toEqual(["readMode", "enqueue:judge"]);
  });
});

// ---------------------------------------------------------------------------
// enqueueLifecycleJob itself: the function that used to swallow the failure.
// Executed against a stubbed fetch — no network, no server.
// ---------------------------------------------------------------------------
describe("enqueueLifecycleJob — a job that was not queued is an error, not a log line", () => {
  const realFetch = globalThis.fetch;
  const realBackend = process.env.BACKEND_URL;

  function stubFetch(status: number, body: unknown) {
    const seen: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      seen.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return seen;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = realBackend;
  });

  test("a 403 — the shape an automation-token rotation produces — throws", async () => {
    process.env.BACKEND_URL = "http://enqueue.invalid";
    stubFetch(403, { error: "forbidden" });
    // BEFORE #806 this returned normally, printing `enqueued undefined (job
    // #undefined)`, and the driver then waited 120s for a job that did not
    // exist before publishing the session unjudged.
    await expect(enqueueLifecycleJob("judge", { sessionId: SESSION_ID })).rejects.toThrow(/HTTP 403/);
  });

  test("a 400 `unknown action` throws, and the message names what to check", async () => {
    process.env.BACKEND_URL = "http://enqueue.invalid";
    stubFetch(400, { error: "unknown action: judgee" });
    await expect(enqueueLifecycleJob("judgee", { sessionId: SESSION_ID }))
      .rejects.toThrow(/nothing was queued/);
  });

  test("a 200 with no jobId is ALSO a failure — the body is what the caller acts on", async () => {
    process.env.BACKEND_URL = "http://enqueue.invalid";
    stubFetch(200, { kind: "swarm.judge" });
    await expect(enqueueLifecycleJob("judge", { sessionId: SESSION_ID })).rejects.toThrow(/nothing was queued/);
  });

  test("a real enqueue returns the body, and a deduped one returns the job that already exists", async () => {
    process.env.BACKEND_URL = "http://enqueue.invalid";
    const fresh = stubFetch(200, { jobId: 12, kind: "swarm.judge", deduped: false });
    expect(await enqueueLifecycleJob("judge", { sessionId: SESSION_ID })).toMatchObject({ jobId: 12 });
    expect(fresh[0]!.body).toEqual({ action: "judge", sessionId: SESSION_ID });

    stubFetch(200, { jobId: 12, kind: "swarm.judge", deduped: true, existingStatus: "pending" });
    expect(await enqueueLifecycleJob("judge", { sessionId: SESSION_ID }))
      .toMatchObject({ jobId: 12, deduped: true });
  });
});

// ---------------------------------------------------------------------------
// SOURCE-TEXT CHECK on runSession's ORDER: the judge sits between the rollup it
// reads and the publish it must beat.
// ---------------------------------------------------------------------------
const JUDGE_CALL = "await runJudgeStep(sessionId, date, subject.id, rail.automationToken);";

/** Ordered positions of the judge step's neighbours in runSession; -1 absent. */
export function judgeStepOrder(src: string) {
  return {
    aggregate: src.indexOf('enqueueLifecycleJob("aggregate"'),
    judge: src.indexOf(JUDGE_CALL),
    publish: src.indexOf('enqueueLifecycleJob("publish"'),
  };
}

describe("runSession puts the judge between aggregate and publish", () => {
  const order = judgeStepOrder(sessionSrc);

  test("every landmark is present — the driver calls runJudgeStep at all", () => {
    for (const [name, at] of Object.entries(order)) expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
  });

  test("aggregate, then judge, then publish", () => {
    expect(order.aggregate).toBeLessThan(order.judge);
    expect(order.judge).toBeLessThan(order.publish);
  });

  test("the driver enqueues no judge job of its own — it goes through runJudgeStep", () => {
    // A bare `enqueueLifecycleJob("judge", …)` in runSession would queue the
    // job and skip the wait, reintroducing the publish race wholesale.
    expect(sessionSrc).not.toContain('enqueueLifecycleJob("judge"');
  });
});

describe("red controls: the judge-order graders must REPORT a regression", () => {
  test("it catches the judge step being deleted entirely", () => {
    const broken = sessionSrc.replace(JUDGE_CALL, "");
    expect(judgeStepOrder(broken).judge).toBe(-1);
  });

  test("it catches the judge step being moved after the publish", () => {
    const broken = sessionSrc
      .replace(JUDGE_CALL, "")
      .replace('await enqueueLifecycleJob("publish", { sessionId }, rail.automationToken);',
        `await enqueueLifecycleJob("publish", { sessionId }, rail.automationToken);\n  ${JUDGE_CALL}`);
    const o = judgeStepOrder(broken);
    expect(o.judge).toBeGreaterThan(o.publish);
    expect(sessionSrc.length).toBeGreaterThan(1000); // the scan is over real text
  });
});

// ---------------------------------------------------------------------------
// THE PROGRESS STREAM (issue #817).
//
// The defect this section grades is not "no judgement was recorded" — the rows
// were there all along. It is that the one surface an operator watches emitted
// `aggregated` and then `published` whether the soak had judged or not, so a
// judge running in shadow was indistinguishable from a judge that was off.
// Every assertion below is therefore ON THE EVENTS, never on a judgement row.
//
// runSession drives docker, the job queue and live inference, so it cannot be
// executed here. What CAN be executed is every piece it composes: the real
// `sessionEmitter`, the real `runJudgeStep` over injected effects, and the real
// `judgedProgress` decision. The segment below wires exactly those three in
// exactly the order runSession wires them — and that ORDER is not taken on
// trust: the source-text graders further down pin it against runSession itself,
// each with a red control.
// ---------------------------------------------------------------------------

/**
 * runSession's aggregate → judge → publish segment, over the real emitter and
 * the real decision, with only the judge's four effects injected.
 * Returns the events a viewer would have seen, in order.
 */
async function judgeSegmentStream(
  mode: string | null,
  opts: { waitFails?: boolean; recorded?: number | null } = {},
) {
  const events: SessionEvent[] = [];
  const emitSession = sessionEmitter((ev) => events.push(ev), "woon", "2026-08-31");
  const h = harness(mode, opts);

  emitSession("aggregated", 42);
  const judgeOutcome = await runJudgeStep(SESSION_ID, "2026-08-31", "woon", "tok", h.deps);
  const judged = judgedProgress(judgeOutcome);
  if (judged) emitSession("judged", 42, judged);
  emitSession("published", 42);

  return { events, states: events.map((e) => e.type === "session" ? e.state : e.type), logs: h.logs };
}

describe("the progress stream reports the judging (#817)", () => {
  test("`shadow` — a driver-run session emits aggregated, judged, published IN THAT ORDER", async () => {
    const { events, states } = await judgeSegmentStream("shadow");
    expect(states).toEqual(["aggregated", "judged", "published"]);
    const judged = events[1];
    expect(judged).toEqual({
      type: "session",
      state: "judged",
      sessionId: 42,
      subject: "woon",
      date: "2026-08-31",
      judgeMode: "shadow",
    });
  });

  test("`off` — the shipped default — emits aggregated, published and NO judged", async () => {
    const { states, events } = await judgeSegmentStream("off");
    // This is the distinction the stream could not previously draw: "nothing
    // was judged" now looks different from "a judgement was recorded and
    // deliberately not applied".
    expect(states).toEqual(["aggregated", "published"]);
    expect(events.some((e) => e.type === "session" && e.state === "judged")).toBe(false);
  });

  test("`enforce` is distinguishable from `shadow` ON THE STREAM, not just in the database", async () => {
    const shadow = await judgeSegmentStream("shadow");
    const enforce = await judgeSegmentStream("enforce");
    expect(shadow.states).toEqual(enforce.states); // same states…
    const modeOf = (s: { events: SessionEvent[] }) =>
      s.events.find((e) => e.type === "session" && e.state === "judged") as Extract<SessionEvent, { type: "session" }>;
    // …so if the mode did not ride on the payload, a viewer could not tell a
    // withheld judgement from an applied one at all.
    expect(modeOf(shadow).judgeMode).toBe("shadow");
    expect(modeOf(enforce).judgeMode).toBe("enforce");
  });

  test("a judging that LANDS AFTER THE WAIT EXPIRES still produces the event", async () => {
    // review-reliability on PR #797: on the single-worker swarm lane the expiry
    // is usually a false alarm — publish is enqueued only after this wait
    // returns and cannot be claimed while the judge holds the lane, so the
    // judging still lands. An event keyed on `judged` (the wait's opinion)
    // would drop it; this one is keyed on the RECORD.
    const { states, events, logs } = await judgeSegmentStream("shadow", { waitFails: true, recorded: 1 });
    expect(states).toEqual(["aggregated", "judged", "published"]);
    expect((events[1] as Extract<SessionEvent, { type: "session" }>).judgeMode).toBe("shadow");
    // …and the log now agrees with the stream instead of contradicting it.
    expect(logs.join("\n")).toContain("1 judgement row(s) ARE recorded");
    expect(logs.join("\n")).not.toContain("did not reach 'judged' in time");
  });

  test("an expiry with NOTHING recorded emits no judged — the stream and the log say the same thing", async () => {
    const { states, logs } = await judgeSegmentStream("shadow", { waitFails: true, recorded: 0 });
    expect(states).toEqual(["aggregated", "published"]);
    expect(logs.join("\n")).toContain("NO judgement row was recorded");
  });

  test("an unreadable judgement record is not treated as a judging", async () => {
    // `null` means "could not read", which is not `0` and is certainly not a
    // judgement. Claiming `judged` here would put a fact on the stream that
    // nothing established.
    const { states } = await judgeSegmentStream("shadow", { waitFails: true, recorded: null });
    expect(states).toEqual(["aggregated", "published"]);
  });

  test("an unreadable judge switch emits no judged either", async () => {
    expect((await judgeSegmentStream(null)).states).toEqual(["aggregated", "published"]);
  });
});

describe("judgedProgress — the decision, graded directly", () => {
  const outcome = (o: Partial<Parameters<typeof judgedProgress>[0]>) =>
    judgedProgress({ mode: null, waitedForJudged: false, judged: false, recorded: null, ...o });

  test("it fires only for shadow/enforce, and only when a judging actually landed", () => {
    expect(outcome({ mode: "shadow", judged: true })).toEqual({ judgeMode: "shadow" });
    expect(outcome({ mode: "enforce", judged: true })).toEqual({ judgeMode: "enforce" });
    expect(outcome({ mode: "shadow", judged: false, recorded: 3 })).toEqual({ judgeMode: "shadow" });
    expect(outcome({ mode: "shadow", judged: false, recorded: 0 })).toBeNull();
    expect(outcome({ mode: "shadow", judged: false, recorded: null })).toBeNull();
    expect(outcome({ mode: "off", judged: false })).toBeNull();
    expect(outcome({ mode: null, judged: false })).toBeNull();
  });

  test("`off` can never emit, even if the record somehow says otherwise", () => {
    // Belt and braces on the acceptance criterion: `off` is the shipped
    // default and must stay silent whatever else is true.
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
    expect(sessionSrc).toContain("const judgeOutcome = await runJudgeStep(sessionId, date, subject.id, rail.automationToken);");
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

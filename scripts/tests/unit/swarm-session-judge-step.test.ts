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
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runJudgeStep } from "../../lib/swarm/session.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** Records every effect runJudgeStep reaches for, in the order it reaches. */
function harness(mode: string | null, opts: { waitFails?: boolean } = {}) {
  const calls: string[] = [];
  const enqueued: { action: string; payload: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const deps = {
    readMode: async () => { calls.push("readMode"); return mode; },
    enqueue: async (action: string, payload: Record<string, unknown>) => {
      calls.push(`enqueue:${action}`);
      enqueued.push({ action, payload });
      return { jobId: 1, kind: `swarm.${action}` };
    },
    waitForJudged: async () => {
      calls.push("waitForJudged");
      if (opts.waitFails) throw new Error("session did not reach 'judged' within 120000ms");
      return {};
    },
    log: (line: string) => { logs.push(line); },
  };
  return { calls, enqueued, logs, deps };
}

const run = (mode: string | null, opts?: { waitFails?: boolean }) => {
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
    expect(out).toEqual({ mode: "off", waitedForJudged: false, judged: false });
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
    expect(out).toEqual({ mode: "shadow", waitedForJudged: true, judged: true });
  });

  test("`enforce` waits on the same terms", async () => {
    const { h, result } = run("enforce");
    expect(await result).toEqual({ mode: "enforce", waitedForJudged: true, judged: true });
    expect(h.calls).toEqual(["readMode", "enqueue:judge", "waitForJudged"]);
  });

  test("an unreadable switch still queues the judging, and does not wait for a state it cannot predict", async () => {
    const { h, result } = run(null);
    const out = await result;
    expect(h.calls).toEqual(["readMode", "enqueue:judge"]);
    expect(out).toEqual({ mode: null, waitedForJudged: false, judged: false });
    expect(h.logs.join("\n")).toContain("unreadable");
  });

  test("a wait that expires PUBLISHES ANYWAY — a slow judge must never wedge the session cadence", async () => {
    const { h, result } = run("shadow", { waitFails: true });
    const out = await result;
    expect(out).toEqual({ mode: "shadow", waitedForJudged: true, judged: false });
    // Loud, not silent: the operator reading the driver's log learns the
    // session published without its judging, and why.
    expect(h.logs.join("\n")).toContain("publishing anyway");
    expect(h.logs.join("\n")).toContain("did not reach 'judged'");
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

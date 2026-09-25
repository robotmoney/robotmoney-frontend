// W4 part 3 — RECOVERY, RETRY AND DEGRADATION (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3.2, §4.4, §4.6, §5 and
// §10.
//
//   §10 "Recovery read": "kill the scheduler between every pair of settlement
//    transitions — after turnover, after aggregate, after the judging request,
//    after `judged` — including for a subject deactivated meanwhile, and after
//    an API commit whose response was lost. On restart each settlement resumes
//    from its recorded state and no durable effect repeats."
//
//   §4.6: "After the retry budget is exhausted, the work waits. The scheduler
//    leaves it in its recorded state, marks itself degraded on its health
//    surface naming the subject or session and the last error, and stops
//    retrying that item."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "NO DURABLE EFFECT REPEATS" IS ASSERTED ON
// ─────────────────────────────────────────────────────────────────────────────
//
// Not on the call count alone — a resumed chain is SUPPOSED to re-issue a call
// it is not sure landed, and §5 exists so that is safe. It is asserted on the
// fake API's answers, which the harness records per call (`resultsOf`):
// `transitioned`, `replayed` and `created` are true exactly once per effect and
// false on every repeat, and the stored outcome is decided exactly once. A
// client that drove a second aggregate through would show two `transitioned:
// true` answers, and one that opened a second successor would show up as a
// third session row.
//
// The "lost response" case is the harness's `lost` fault: the fake COMMITS and
// then answers transiently. That is the real failure: the effect happened, the
// caller does not know it. A fake that merely errored before committing would
// test nothing, because there would be nothing to repeat.
//
// Faults are injected PER TARGET where a test has more than one session, so a
// failure on one cannot be mistaken for isolation of another.
import { describe, expect, test } from "bun:test";
import { SchedulerClock } from "../../lib/system-scheduler/clock.ts";
import { FakeSchedulerApi, FakeTimers, judgedEvent, turnedOverEvent } from "./support/scheduler-harness.ts";

const T0 = 1_800_000_000_000;

function world(startMs = T0) {
  const timers = new FakeTimers(startMs);
  const api = new FakeSchedulerApi({ now: () => timers.now(), judgingDurationSeconds: 900 });
  const waits: number[] = [];
  const boot = (opts: { maxAttempts?: number } = {}): SchedulerClock =>
    new SchedulerClock(api, {
      timers,
      maxAttempts: opts.maxAttempts,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
  return { timers, api, boot, waits };
}

/** The flag a transition answered with, for every successful call of `name`, in order. */
function flags(api: FakeSchedulerApi, name: string, flag: string): unknown[] {
  return api.resultsOf(name).map((r) => r[flag]);
}

/** A subject with one collecting epoch under `enforce`, ready to be turned over. */
function seedEnforce(api: FakeSchedulerApi): void {
  api.addSubject("sub-a", 600);
  api.addSession({
    sessionId: "sa",
    subjectId: "sub-a",
    windowClosesAt: T0 + 600_000,
    judgeMode: "enforce",
  });
}

describe("killing the scheduler between every pair of settlement transitions (§10)", () => {
  test("after turnover: the restarted scheduler resumes from window_closed and repeats no effect", async () => {
    const { timers, api, boot } = world();
    seedEnforce(api);
    const a = boot();
    await a.rebuild(await api.fullRead());
    await a.idle();
    // Turn over, then die before aggregating.
    api.failAlways("aggregate", "sa");
    await timers.advanceTo(T0 + 600_000);
    await a.idle();
    a.stop();
    expect(api.sessions.get("sa")!.state).toBe("window_closed");
    const sessionsAfterTurnover = api.sessionsOf("sub-a").length;
    expect(flags(api, "turnover", "replayed")).toEqual([false]);
    api.recover("aggregate");

    const b = boot();
    await b.rebuild(await api.fullRead());
    await b.idle();

    // The restarted scheduler resumed from `window_closed`: it aggregated (the
    // one successful aggregate is the one effect) and never turned over again.
    expect(api.countCalls("turnover")).toBe(1);
    expect(flags(api, "aggregate", "transitioned")).toEqual([true]);
    expect(flags(api, "requestJudging", "transitioned")).toEqual([true]);
    // No second successor: turnover's durable effect did not repeat.
    expect(api.sessionsOf("sub-a")).toHaveLength(sessionsAfterTurnover);
    expect(api.sessions.get("sa")!.state).toBe("judging");
  });

  test("after aggregate: the restarted scheduler requests judging and aggregates nothing twice", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "aggregated", judgeMode: "enforce" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const b = boot();
    await b.rebuild(await api.fullRead());
    await b.idle();

    // Resumed from the recorded `aggregated` state, the chain's next step is
    // the judging request. Aggregate is not called at all — counted, not
    // assumed — and the one judging request is the one that transitioned.
    expect(api.countCalls("aggregate")).toBe(0);
    expect(api.trail).toEqual(["fullRead()", "requestJudging(old)"]);
    expect(flags(api, "requestJudging", "transitioned")).toEqual([true]);
    expect(api.sessions.get("old")!.state).toBe("judging");
  });

  test("after the judging request: the deadline is reconstructed, not re-requested with a new instant", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    await timers.advanceTo(T0 + 400_000);
    const b = boot();
    await b.rebuild(await api.fullRead());
    await b.idle();

    expect(b.deadlineAt("old")).toBe(T0 + 900_000);
    expect(api.sessions.get("old")!.judgingDeadlineAt).toBe(T0 + 900_000);
    // Parked on the stored instant: nothing was re-requested or re-aggregated.
    expect(api.trail).toEqual(["fullRead()"]);
  });

  test("after `judged`: the restarted scheduler finalizes once and the outcome is decided once", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judged",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
      consensusAt: T0 + 10_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const b = boot();
    await b.rebuild(await api.fullRead());
    await b.idle();
    expect(api.sessions.get("old")!.outcome).toBe("judged");

    // A third boot: finalize again, and the answer is a replay of the decided
    // outcome, not a re-decision.
    const c = boot();
    await c.rebuild(await api.fullRead());
    await c.idle();
    expect(api.sessions.get("old")!.outcome).toBe("judged");
    // The published session is no longer in `settling`, so nothing was even called.
    expect(api.countCalls("finalize")).toBe(1);
    expect(flags(api, "finalize", "replayed")).toEqual([false]);
    // `judged` goes straight to finalize: no aggregate, no judging request.
    expect(api.countCalls("aggregate")).toBe(0);
    expect(api.countCalls("requestJudging")).toBe(0);
  });

  test("a deactivated subject's settlement resumes across a restart and opens no successor", async () => {
    const { api, boot } = world();
    api.addSubject("gone", 600, false);
    api.addSession({ sessionId: "orphan", subjectId: "gone", state: "window_closed", judgeMode: "off" });
    api.failAlways("aggregate");

    const a = boot({ maxAttempts: 2 });
    await a.rebuild(await api.fullRead());
    await a.idle();
    a.stop();
    expect(api.sessions.get("orphan")!.state).toBe("window_closed");

    api.recover("aggregate");
    const b = boot();
    await b.rebuild(await api.fullRead());
    await b.idle();

    expect(api.sessions.get("orphan")!.state).toBe("published");
    expect(api.sessionsOf("gone")).toHaveLength(1);
    expect(api.countCalls("openEpoch")).toBe(0);
    expect(api.countCalls("turnover")).toBe(0);
    // Two refused attempts on the first boot, one that transitioned on the second.
    expect(flags(api, "aggregate", "transitioned")).toEqual([true]);
    expect(flags(api, "finalize", "replayed")).toEqual([false]);
  });

  test("a commit whose response was LOST: the effect happened once and the retry replays it", async () => {
    const { timers, api, boot } = world();
    seedEnforce(api);
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    // The turnover commits, then the response is lost. The fake's state has
    // already moved, so the retry meets §4.3's replay path.
    api.failNext("turnover", 1, "lost");
    await timers.advanceTo(T0 + 600_000);
    await clock.idle();

    // Exactly one successor exists, and the retry got the ORIGINAL result back.
    expect(api.sessionsOf("sub-a")).toHaveLength(2);
    expect(api.countCalls("turnover")).toBe(2);
    expect(flags(api, "turnover", "replayed")).toEqual([false, true]);
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000 + 600_000);
  });

  test("KILLED after a turnover whose response was lost: the restart turns over nothing and settles the closed epoch", async () => {
    // §10: "kill the scheduler … after an API commit whose response was lost".
    // The process dies in the backoff before its retry, so the replay path is
    // never reached; the restarted process learns what happened from the full
    // read alone.
    const { timers, api } = world();
    seedEnforce(api);
    let a: SchedulerClock | null = null;
    a = new SchedulerClock(api, {
      timers,
      sleep: async () => {
        a!.stop(); // killed while waiting to retry
      },
    });
    await a.rebuild(await api.fullRead());
    await a.idle();
    api.failNext("turnover", 1, "lost");
    await timers.advanceTo(T0 + 600_000);
    await a.idle();

    expect(api.countCalls("turnover")).toBe(1);
    expect(api.sessions.get("sa")!.state).toBe("window_closed");
    const successor = api.sessionsOf("sub-a").find((x) => x.state === "collecting")!;
    expect(successor).toBeDefined();

    const b = new SchedulerClock(api, { timers, sleep: async () => {} });
    await b.rebuild(await api.fullRead());
    await b.idle();

    // The restart saw the successor as the collecting session and armed its
    // timer; it saw `sa` as settling and resumed it. No second turnover.
    expect(api.countCalls("turnover")).toBe(1);
    expect(api.sessionsOf("sub-a")).toHaveLength(2);
    expect(b.boundaryAt("sub-a")).toBe(successor.windowClosesAt);
    expect(flags(api, "aggregate", "transitioned")).toEqual([true]);
    expect(flags(api, "requestJudging", "transitioned")).toEqual([true]);
    expect(api.sessions.get("sa")!.state).toBe("judging");
  });

  test("KILLED after an aggregate whose response was lost: the restart requests judging and aggregates nothing twice", async () => {
    const { api } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "window_closed", judgeMode: "enforce" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failNext("aggregate", 1, "lost", "old");

    let a: SchedulerClock | null = null;
    a = new SchedulerClock(api, {
      timers: new FakeTimers(T0),
      sleep: async () => {
        a!.stop();
      },
    });
    await a.rebuild(await api.fullRead());
    await a.idle();
    // The aggregate committed; the caller never learned it and died.
    expect(api.sessions.get("old")!.state).toBe("aggregated");
    expect(api.countCalls("requestJudging")).toBe(0);

    const b = new SchedulerClock(api, { timers: new FakeTimers(T0), sleep: async () => {} });
    await b.rebuild(await api.fullRead());
    await b.idle();

    // One aggregate, the lost one, and it is the only `transitioned: true`.
    expect(api.countCalls("aggregate")).toBe(1);
    expect(flags(api, "aggregate", "transitioned")).toEqual([true]);
    expect(flags(api, "requestJudging", "transitioned")).toEqual([true]);
    expect(api.sessions.get("old")!.state).toBe("judging");
  });

  test("a lost finalize response is retried into a REPLAY of the decided outcome", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "aggregated", judgeMode: "off" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failNext("finalize", 1, "lost", "old");

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("finalize")).toBe(2);
    expect(flags(api, "finalize", "replayed")).toEqual([false, true]);
    expect(flags(api, "finalize", "outcome")).toEqual(["not_judged", "not_judged"]);
  });
});

describe("an 'already done' answer advances the chain (§4.6, §5)", () => {
  test("aggregate answering transitioned:false still leads to the judging request", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    // Recorded state says window_closed, but the API has already aggregated it.
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "aggregated", judgeMode: "enforce" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const clock = boot();
    await clock.rebuild({
      subjects: [{ subjectId: "sub-a", name: "sub-a", epochDurationSeconds: 600, epochAnchor: "1970-01-01T00:00:00.000Z", judgingDurationSeconds: 900 }],
      collecting: [
        { sessionId: "sa", subjectId: "sub-a", windowClosesAt: new Date(T0 + 10_000_000).toISOString() },
      ],
      settling: [
        { sessionId: "old", subjectId: "sub-a", state: "window_closed", judgingDeadlineAt: null, subjectActive: true },
      ],
      cursor: 0,
    });
    await clock.idle();

    expect(api.sessions.get("old")!.state).toBe("judging");
    expect(api.countCalls("requestJudging")).toBe(1);
    // The "already done" answer was a success flagged as a repeat, and the
    // chain continued from it.
    expect(flags(api, "aggregate", "transitioned")).toEqual([false]);
    expect(flags(api, "requestJudging", "transitioned")).toEqual([true]);
  });

  test("`judge_mode_off` is a reasoned answer that moves straight to finalize, not a stop", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.trail).toContain("aggregate(old)");
    expect(api.trail).toContain("requestJudging(old)");
    expect(api.trail).toContain("finalize(old)");
    expect(api.sessions.get("old")!.outcome).toBe("not_judged");
    // §4.4: mode `off` "waits for nothing" — no deadline timer was ever held.
    expect(clock.deadlineAt("old")).toBeNull();
  });
});

describe("isolation (§4.4, §10)", () => {
  test("a judge wait on one session and a failed transition on another delay no boundary and no other settlement", async () => {
    const { timers, api, boot } = world();
    // A: parked waiting for a judging deadline.
    api.addSubject("a", 600);
    api.addSession({
      sessionId: "a-old",
      subjectId: "a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 5_000_000,
    });
    api.addSession({ sessionId: "a1", subjectId: "a", windowClosesAt: T0 + 5_000_000 });
    // B: a settlement whose aggregate never succeeds — injected on B's session
    // ONLY, so every other aggregate in this test is free to succeed.
    api.addSubject("b", 600);
    api.addSession({ sessionId: "b-old", subjectId: "b", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "b1", subjectId: "b", windowClosesAt: T0 + 5_000_000 });
    api.failAlways("aggregate", "b-old");
    // D: another settlement at the same step as B, in the same rebuild.
    api.addSubject("d", 600);
    api.addSession({ sessionId: "d-old", subjectId: "d", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "d1", subjectId: "d", windowClosesAt: T0 + 5_000_000 });
    // C: an ordinary subject whose boundary falls soon.
    api.addSubject("c", 60);
    api.addSession({ sessionId: "c1", subjectId: "c", windowClosesAt: T0 + 60_000, judgeMode: "off" });

    const clock = boot({ maxAttempts: 3 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    await timers.advanceTo(T0 + 60_000);
    await clock.idle();

    // C's boundary fired at its own instant, with A parked and B exhausted.
    const c = api.callsOf("turnover").filter((x) => x.args.subjectId === "c");
    expect(c).toHaveLength(1);
    expect(c[0].atMs).toBe(T0 + 60_000);
    // …and C's closed epoch settled all the way, past B's stuck step.
    expect(api.sessions.get("c1")!.state).toBe("published");
    // D, at the very step B is stuck on, settled in the same rebuild.
    expect(api.sessions.get("d-old")!.state).toBe("published");
    expect(api.sessions.get("a-old")!.state).toBe("judging");
    expect(api.sessions.get("b-old")!.state).toBe("window_closed");
    expect(api.callsOf("aggregate").filter((x) => x.args.sessionId === "b-old")).toHaveLength(3);
    expect(clock.health.exhausted.map((e) => e.sessionId)).toEqual(["b-old"]);
  });
});

describe("bounded retry and degradation (§4.6, §10)", () => {
  test("a transient failure is retried with backoff and then succeeds", async () => {
    const { api, boot, waits } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failNext("aggregate", 2);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("aggregate")).toBe(3);
    expect(api.sessions.get("old")!.state).toBe("published");
    // Bounded EXPONENTIAL backoff: each wait strictly longer than the last.
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(clock.health.exhausted).toHaveLength(0);
  });

  // §4.6: "This applies to every call the scheduler makes — first opening,
  // turnover, and each settlement step alike." Aggregate is above and turnover
  // is in system-scheduler-rebuild.test.ts's NO DRIFT case; these are the rest,
  // each through the same one retry wrapper, each observed separately.
  test("a transient failure on the FIRST OPENING is retried and succeeds", async () => {
    const { api, boot, waits } = world();
    api.addSubject("sub-a", 600);
    api.failNext("openEpoch", 2);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("openEpoch")).toBe(3);
    expect(flags(api, "openEpoch", "created")).toEqual([true]);
    expect(api.sessionsOf("sub-a")).toHaveLength(1);
    expect(clock.boundaryAt("sub-a")).toBe(api.sessionsOf("sub-a")[0].windowClosesAt);
    expect(waits).toEqual([500, 1_000]);
    expect(clock.health.exhausted).toHaveLength(0);
    expect(clock.refusals).toHaveLength(0);
  });

  test("a transient failure on the JUDGING REQUEST is retried and succeeds", async () => {
    const { api, boot, waits } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "aggregated", judgeMode: "enforce" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failNext("requestJudging", 2, "throw");

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("requestJudging")).toBe(3);
    expect(flags(api, "requestJudging", "transitioned")).toEqual([true]);
    expect(api.sessions.get("old")!.state).toBe("judging");
    expect(clock.deadlineAt("old")).toBe(api.sessions.get("old")!.judgingDeadlineAt);
    expect(waits).toEqual([500, 1_000]);
    expect(clock.health.exhausted).toHaveLength(0);
  });

  test("a transient failure on FINALIZE is retried and succeeds", async () => {
    const { api, boot, waits } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judged",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
      consensusAt: T0 + 10_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failNext("finalize", 3);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("finalize")).toBe(4);
    expect(flags(api, "finalize", "replayed")).toEqual([false]);
    expect(api.sessions.get("old")!.outcome).toBe("judged");
    expect(waits).toEqual([500, 1_000, 2_000]);
    expect(clock.health.exhausted).toHaveLength(0);
  });

  test("a reasoned refusal is NOT retried", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    // `aggregate` on a session that is not window_closed is a reasoned refusal.
    api.addSession({ sessionId: "ghost", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.sessions.delete("ghost");
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const clock = boot();
    await clock.rebuild({
      subjects: [{ subjectId: "sub-a", name: "sub-a", epochDurationSeconds: 600, epochAnchor: "1970-01-01T00:00:00.000Z", judgingDurationSeconds: 900 }],
      collecting: [
        { sessionId: "sa", subjectId: "sub-a", windowClosesAt: new Date(T0 + 10_000_000).toISOString() },
      ],
      settling: [
        { sessionId: "ghost", subjectId: "sub-a", state: "window_closed", judgingDeadlineAt: null, subjectActive: true },
      ],
      cursor: 0,
    });
    await clock.idle();

    expect(api.countCalls("aggregate")).toBe(1);
    // A reasoned refusal is final and recorded, but it is not "exhausted work":
    // §4.6 distinguishes them, and only the second is a degradation.
    expect(clock.health.exhausted).toHaveLength(0);
    expect(clock.refusals.map((r) => r.error)).toContain("session_not_found");
  });

  test("after the budget the scheduler degrades naming the item and its last error, and stops retrying", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failAlways("aggregate");

    const clock = boot({ maxAttempts: 4 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("aggregate")).toBe(4);
    const [item] = clock.health.exhausted;
    expect(item).toBeDefined();
    expect(item.item).toContain("aggregate");
    expect(item.sessionId).toBe("old");
    expect(item.subjectId).toBe("sub-a");
    expect(item.lastError).toBe("injected_dependency_down");
    expect(item.attempts).toBe(4);
    expect(clock.health.healthy).toBe(false);

    // It stops retrying: time passes and no further call is made.
    const after = api.countCalls("aggregate");
    await clock.idle();
    expect(api.countCalls("aggregate")).toBe(after);
  });

  test("a restart after the dependency recovers resumes the item EXACTLY once", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    api.failAlways("aggregate");

    const a = boot({ maxAttempts: 3 });
    await a.rebuild(await api.fullRead());
    await a.idle();
    expect(a.health.exhausted).toHaveLength(1);
    a.stop();

    api.recover("aggregate");
    const before = api.countCalls("aggregate");
    const b = boot({ maxAttempts: 3 });
    // The container sets these two on a successful startup check and a live
    // stream; a fresh clock claims neither until it is told.
    b.markAuthenticated(true);
    b.markStreamSynchronized(true);
    await b.rebuild(await api.fullRead());
    await b.idle();

    expect(api.countCalls("aggregate") - before).toBe(1);
    expect(api.sessions.get("old")!.state).toBe("published");
    expect(b.health.exhausted).toHaveLength(0);
    expect(b.health.healthy).toBe(true);
  });

  test("an exhausted turnover leaves the collecting session in place, and fires once on rebuild", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    api.failAlways("turnover");

    const a = boot({ maxAttempts: 3 });
    await a.rebuild(await api.fullRead());
    await a.idle();
    await timers.advanceTo(T0 + 600_000);
    await a.idle();

    expect(api.countCalls("turnover")).toBe(3);
    expect(a.health.exhausted[0].subjectId).toBe("sub-a");
    // §4.6: "keeps its collecting session past `window_closes_at`; that is
    // harmless, because §4.2 refuses submissions by instant, not by state."
    //
    // THE REFUSAL ITSELF IS NOT PROVED HERE, and cannot be: this fake has no
    // submission surface, and a fake that modelled one would only prove the
    // fake. It is proved against the real API and real Postgres, in exactly
    // this state — `collecting`, past `window_closes_at`, turnover not yet
    // run — by backend/tests/epoch-window.test.ts ("a take after
    // window_closes_at is refused even though the session is still collecting"
    // and "…refused throughout an exhausted turnover…"), and across a real
    // scheduler outage by scripts/tests/integration/scheduler-api-runtime.test.ts.
    expect(api.sessions.get("sa")!.state).toBe("collecting");
    a.stop();

    api.recover("turnover");
    await timers.advanceTo(T0 + 900_000);
    const b = boot({ maxAttempts: 3 });
    await b.rebuild(await api.fullRead());
    await b.idle();

    expect(api.countCalls("turnover")).toBe(4);
    expect(api.sessions.get("sa")!.state).not.toBe("collecting");
  });
});

describe("a turnover this scheduler did not make, learned of only by the event (§4.3, §6.2, §10)", () => {
  // D55: only `system-scheduler` turns an epoch over — there is no operator or
  // admin early turnover. The turnover this scheduler learns of only by event
  // is a second scheduler's. The guarantees are the ones the operator case was
  // tested for: the closed epoch settles, the timer moves, nothing doubles.
  test("`epoch.turned_over` settles the closed epoch to published and moves the timer", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000, judgeMode: "off" });
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000);

    // A second scheduler turns N over before this one's timer fires. This
    // scheduler's own timer never fired; all it gets is the event.
    const r = await api.turnover("sub-a", "sa");
    expect(r.ok).toBe(true);
    const opened = (r as { openedSessionId: string; windowClosesAt: string });
    await clock.applyEvent(
      turnedOverEvent(1, "sub-a", "sa", opened.openedSessionId, opened.windowClosesAt),
    );
    await clock.idle();

    expect(api.sessions.get("sa")!.state).toBe("published");
    expect(api.sessions.get("sa")!.outcome).toBe("not_judged");
    expect(clock.boundaryAt("sub-a")).toBe(Date.parse(opened.windowClosesAt));
    // The scheduler did not fire a turnover of its own on top of the other one.
    expect(api.countCalls("turnover")).toBe(1);
  });

  test("a second `epoch.turned_over` for a session already settling drives no second chain", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000, judgeMode: "off" });
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    const r = (await api.turnover("sub-a", "sa")) as { openedSessionId: string; windowClosesAt: string };
    const ev = turnedOverEvent(1, "sub-a", "sa", r.openedSessionId, r.windowClosesAt);
    await clock.applyEvent(ev);
    await clock.idle();
    const aggregates = api.countCalls("aggregate");

    await clock.applyEvent({ ...ev, seq: 2 });
    await clock.idle();

    expect(api.countCalls("aggregate")).toBe(aggregates);
  });
});

describe("the two clocks are not the same clock (§4.2)", () => {
  // §4.2: "Every comparison against a stored instant … reads the database clock
  // with `clock_timestamp()` inside the deciding transaction. Never the
  // application's clock."
  //
  // So the scheduler's timer firing is NOT the same event as the API agreeing
  // the deadline has arrived, and a client that assumed it was would strand
  // every session whose API clock lags by even a second. The fake runs its
  // database clock behind the timer host to produce exactly that.
  test("a deadline timer that fires before the API's clock agrees is re-armed, not abandoned", async () => {
    const timers = new FakeTimers(T0);
    const api = new FakeSchedulerApi({
      now: () => timers.now(),
      judgingDurationSeconds: 900,
      apiClockSkewMs: 3_000, // the database is three seconds behind
    });
    api.addSubject("sub-a", 600, true, { epochAnchorMs: T0 });
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const clock = new SchedulerClock(api, { timers, sleep: async () => {} });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(clock.deadlineAt("old")).toBe(T0 + 900_000);

    // The scheduler's timer fires at the stored instant. The API, three seconds
    // behind, refuses: `judging_deadline_not_reached`.
    await timers.advanceTo(T0 + 900_000);
    await clock.idle();
    expect(api.sessions.get("old")!.state).toBe("judging");
    // NOT abandoned, and not recorded as a permanent refusal — the clock went
    // back to waiting on a re-armed timer.
    expect(clock.refusals.map((r) => r.error)).not.toContain("judging_deadline_not_reached");
    expect(clock.deadlineAt("old")).not.toBeNull();
    expect(clock.health.exhausted).toHaveLength(0);

    // Once the API's clock passes the instant too, it finalizes.
    await timers.advanceTo(T0 + 910_000);
    await clock.idle();
    expect(api.sessions.get("old")!.state).toBe("published");
    expect(api.sessions.get("old")!.outcome).toBe("no_consensus");
  });

  test("a permanently disagreeing clock degrades within the budget rather than spinning", async () => {
    const timers = new FakeTimers(T0);
    // A skew larger than anything the deadline can outrun inside this test.
    const api = new FakeSchedulerApi({ now: () => timers.now(), apiClockSkewMs: 10_000_000 });
    api.addSubject("sub-a", 600, true, { epochAnchorMs: T0 });
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 50_000_000 });

    const clock = new SchedulerClock(api, { timers, maxAttempts: 3, sleep: async () => {} });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    // Reach the stored deadline first — the scheduler's clock passes it, the
    // API's (ten thousand seconds behind) does not — then let the re-arms run.
    await timers.advanceTo(T0 + 900_000);
    await clock.idle();
    for (let i = 0; i < 6; i += 1) {
      await timers.advanceBy(1_000);
      await clock.idle();
    }

    const [item] = clock.health.exhausted;
    expect(item).toBeDefined();
    expect(item.sessionId).toBe("old");
    expect(item.lastError).toBe("judging_deadline_not_reached");
    expect(clock.deadlineAt("old")).toBeNull();
    expect(clock.health.healthy).toBe(false);
  });
});

describe("the judged event is a wake-up and nothing more (§4.4)", () => {
  test("`session.judged` finalizes at once instead of waiting out the deadline", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(clock.deadlineAt("old")).toBe(T0 + 900_000);

    await timers.advanceTo(T0 + 100_000);
    api.recordConsensus("old");
    await clock.applyEvent(judgedEvent(1, "old", "sub-a"));
    await clock.idle();

    expect(api.sessions.get("old")!.outcome).toBe("judged");
    // The deadline timer was dropped, so it cannot fire a second finalize.
    expect(clock.deadlineAt("old")).toBeNull();
    await timers.advanceTo(T0 + 2_000_000);
    await clock.idle();
    expect(api.countCalls("finalize")).toBe(1);
  });

  test("a DUPLICATE `session.judged` changes no outcome and drives no second finalize", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    await timers.advanceTo(T0 + 100_000);
    api.recordConsensus("old");
    await clock.applyEvent(judgedEvent(1, "old", "sub-a"));
    await clock.idle();
    const finalizes = api.countCalls("finalize");

    await clock.applyEvent(judgedEvent(2, "old", "sub-a"));
    await clock.idle();

    expect(api.countCalls("finalize")).toBe(finalizes);
    expect(api.sessions.get("old")!.outcome).toBe("judged");
  });

  test("a LOST `session.judged` changes no outcome: the deadline finalizes it instead", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    await timers.advanceTo(T0 + 100_000);
    api.recordConsensus("old"); // the event is dropped at the hop
    await timers.advanceTo(T0 + 900_000);
    await clock.idle();

    expect(api.countCalls("finalize")).toBe(1);
    expect(api.sessions.get("old")!.outcome).toBe("judged");
  });
});

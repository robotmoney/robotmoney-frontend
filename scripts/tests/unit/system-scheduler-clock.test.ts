// W4 part 3 — THE CLOCK (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §4.3, §6.2 and §10.
//
//   §3: "It holds one timer per active subject: the instant that subject's
//    current epoch closes. It also holds one timer per session in `judging` …
//    It fires at the instant. It does not poll the API on an interval. It does
//    not tick."
//
//   §10: "turnover is dispatched within one second of `window_closes_at`";
//    "Timing gates distinguish dispatch (the scheduler issued the call at the
//    instant) from completion (the API transaction committed); each names a
//    tolerance."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT EACH TIMING ASSERTION IN THIS FILE MEASURES
// ─────────────────────────────────────────────────────────────────────────────
//
// Every timing test below states, in its own name and in a comment, whether it
// measures DISPATCH or COMPLETION and what tolerance it allows. There are two
// kinds and they prove different things:
//
//   * FAKE-CLOCK tests measure dispatch against an injected `TimerHost`. They
//     prove the clock ASKS for the right instant and that nothing happens
//     before it. They prove nothing about setTimeout, by construction.
//
//   * The REAL-CLOCK test at the bottom measures dispatch against `Date.now()`
//     with a real `setTimeout`, and is the only one that can show the
//     production timer host actually fires within §10's one second.
//
// The "one tick before the instant" test is the load-bearing one: a polling
// implementation with any interval at all fails it, because a poll that has not
// yet noticed the instant has still MADE A CALL, and the fake API counts calls.
import { describe, expect, test } from "bun:test";
import { SchedulerClock } from "../../lib/system-scheduler/clock.ts";
import { realTimers } from "../../lib/system-scheduler/types.ts";
import {
  FakeSchedulerApi,
  FakeTimers,
  drain,
  subjectChangedEvent,
} from "./support/scheduler-harness.ts";

/** Milliseconds §10 allows between the close instant and the turnover dispatch. */
const DISPATCH_TOLERANCE_MS = 1_000;

const T0 = 1_800_000_000_000;

function harness(startMs = T0) {
  const timers = new FakeTimers(startMs);
  const api = new FakeSchedulerApi({ now: () => timers.now() });
  const waits: number[] = [];
  const clock = new SchedulerClock(api, {
    timers,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { timers, api, clock, waits };
}

describe("one timer per collecting session and per judging deadline (§3)", () => {
  test("a rebuild holds exactly one boundary timer per collecting session", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("sub-a", 600);
    api.addSubject("sub-b", 900);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    api.addSession({ sessionId: "sb", subjectId: "sub-b", windowClosesAt: T0 + 900_000 });

    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(clock.timerCount).toEqual({ boundaries: 2, deadlines: 0 });
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000);
    expect(clock.boundaryAt("sub-b")).toBe(T0 + 900_000);
    expect(timers.pending.map((p) => p.at)).toEqual([T0 + 600_000, T0 + 900_000]);
  });

  test("a rebuild holds exactly one deadline timer per judging session, at the STORED instant", async () => {
    const { api, clock } = harness();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 300_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });

    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(clock.timerCount).toEqual({ boundaries: 1, deadlines: 1 });
    expect(clock.deadlineAt("old")).toBe(T0 + 300_000);
  });

  test("an active subject with no collecting session is opened on rebuild, and gets its timer", async () => {
    const { api, clock } = harness();
    api.addSubject("sub-a", 600);

    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("openEpoch")).toBe(1);
    const opened = api.sessionsOf("sub-a");
    expect(opened).toHaveLength(1);
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000);
  });
});

describe("the clock fires at the instant and not before (§3, §10)", () => {
  test("DISPATCH: one tick before the instant produces no API call at all", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    const before = api.calls.length;

    // One millisecond short. A poll of ANY interval would have made a call by
    // now; a timer set for the instant has made none.
    await timers.advanceTo(T0 + 600_000 - 1);
    await clock.idle();

    expect(api.calls.length).toBe(before);
    expect(api.countCalls("turnover")).toBe(0);
  });

  test("DISPATCH: turnover is issued within 1000ms of window_closes_at (fake clock, tolerance 1000ms)", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("sub-a", 600);
    const closesAt = T0 + 600_000;
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: closesAt });
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    await timers.advanceTo(closesAt);
    await clock.idle();

    const [call] = api.callsOf("turnover");
    expect(call).toBeDefined();
    // DISPATCH, not completion: `atMs` is the instant the client issued the
    // call, recorded by the fake before it decides anything.
    expect(call.atMs - closesAt).toBeGreaterThanOrEqual(0);
    expect(call.atMs - closesAt).toBeLessThanOrEqual(DISPATCH_TOLERANCE_MS);
    expect(call.args.expectedSessionId).toBe("sa");
  });

  test("the boundary names the epoch it means to close, and re-arms on the successor", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    await timers.advanceTo(T0 + 600_000);
    await clock.idle();

    expect(api.callsOf("turnover")[0].args.expectedSessionId).toBe("sa");
    // The successor opened at the close instant, so its window closes one
    // duration later, and the clock now waits on THAT.
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000 + 600_000);
    expect(clock.timerCount.boundaries).toBe(1);
  });
});

describe("subjects are independent (§4.4, §10)", () => {
  test("two durations turn over at their own instants, neither disturbing the other", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("fast", 60);
    api.addSubject("slow", 600);
    api.addSession({ sessionId: "f1", subjectId: "fast", windowClosesAt: T0 + 60_000 });
    api.addSession({ sessionId: "s1", subjectId: "slow", windowClosesAt: T0 + 600_000 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    await timers.advanceTo(T0 + 60_000);
    await clock.idle();
    expect(api.callsOf("turnover").map((c) => c.args.subjectId)).toEqual(["fast"]);
    expect(clock.boundaryAt("slow")).toBe(T0 + 600_000);

    // The fast subject turns over nine times before the slow one's instant.
    for (let i = 2; i <= 9; i += 1) {
      await timers.advanceTo(T0 + 60_000 * i);
      await clock.idle();
    }
    expect(api.callsOf("turnover").filter((c) => c.args.subjectId === "fast")).toHaveLength(9);
    expect(api.callsOf("turnover").filter((c) => c.args.subjectId === "slow")).toHaveLength(0);

    await timers.advanceTo(T0 + 600_000);
    await clock.idle();
    expect(api.callsOf("turnover").filter((c) => c.args.subjectId === "slow")).toHaveLength(1);
  });
});

describe("a duration change (§6.2, §10)", () => {
  test("leaves the current window's instant alone and applies at the next epoch, with no restart", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    const rebuildsBefore = api.countCalls("fullRead");

    // The admin API changes the duration mid-window and publishes the event.
    api.subjects.get("sub-a")!.epochDurationSeconds = 60;
    await clock.applyEvent({
      ...subjectChangedEvent(1, "sub-a"),
      payload: { reason: "updated", epochDurationSeconds: 60 },
    });
    await clock.idle();

    // The CURRENT window is untouched: still the instant it was opened with.
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000);
    // And nothing restarted: no extra full read.
    expect(api.countCalls("fullRead")).toBe(rebuildsBefore);

    await timers.advanceTo(T0 + 600_000);
    await clock.idle();

    // The NEXT epoch uses the new duration, which the API computed.
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000 + 60_000);
  });

  test("an activation event opens that subject's first epoch and arms its timer", async () => {
    const { api, clock } = harness();
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(api.countCalls("openEpoch")).toBe(0);

    api.addSubject("late", 300);
    await clock.applyEvent({
      ...subjectChangedEvent(1, "late"),
      payload: { reason: "activated", epochDurationSeconds: 300 },
    });
    await clock.idle();

    expect(api.countCalls("openEpoch")).toBe(1);
    expect(clock.boundaryAt("late")).toBe(T0 + 300_000);
  });

  test("a deactivation event drops the boundary timer and settles the closed epoch (§4.5)", async () => {
    const { api, clock } = harness();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(clock.timerCount.boundaries).toBe(1);

    // The admin route closed the epoch and deactivated the subject.
    api.subjects.get("sub-a")!.active = false;
    api.sessions.get("sa")!.state = "window_closed";
    await clock.applyEvent({
      ...subjectChangedEvent(1, "sub-a"),
      payload: { reason: "deactivated", closedEpochId: "sa" },
    });
    await clock.idle();

    expect(clock.boundaryAt("sub-a")).toBeNull();
    expect(clock.timerCount.boundaries).toBe(0);
    // Settlement of the closed epoch still had to finish.
    expect(api.sessions.get("sa")!.state).toBe("published");
    // And no successor was opened.
    expect(api.sessionsOf("sub-a")).toHaveLength(1);
  });
});

describe("the production timer host (§10)", () => {
  test("DISPATCH: a real setTimeout fires the boundary within 1000ms of the instant (tolerance 1000ms)", async () => {
    // The ONLY test in this file measuring real elapsed time. Everything else
    // uses an injected clock and therefore proves nothing about setTimeout.
    const api = new FakeSchedulerApi({ now: () => Date.now() });
    const clock = new SchedulerClock(api, { timers: realTimers(), sleep: async () => {} });
    const closesAt = Date.now() + 150;
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: closesAt });

    await clock.rebuild(await api.fullRead());
    await new Promise<void>((r) => setTimeout(r, 400));
    await clock.idle();
    clock.stop();

    const [call] = api.callsOf("turnover");
    expect(call).toBeDefined();
    const lateness = call.atMs - closesAt;
    expect(lateness).toBeGreaterThanOrEqual(0);
    expect(lateness).toBeLessThanOrEqual(DISPATCH_TOLERANCE_MS);
  });

  test("the real host does not fire early, and clears cleanly", async () => {
    const host = realTimers();
    let fired = 0;
    const h = host.set(Date.now() + 5_000, () => {
      fired += 1;
    });
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(fired).toBe(0);
    host.clear(h);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(fired).toBe(0);
  });
});

describe("no ticking (§9)", () => {
  test("between instants, with nothing happening, the clock makes zero API calls", async () => {
    const { timers, api, clock } = harness();
    api.addSubject("sub-a", 86_400);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 86_400_000 });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    const before = api.calls.length;

    // Half a day of clock time, in a hundred steps. A ticker of any period
    // under twelve hours makes a call here.
    for (let i = 1; i <= 100; i += 1) {
      await timers.advanceTo(T0 + (43_200_000 / 100) * i);
    }
    await drain();

    expect(api.calls.length).toBe(before);
  });
});

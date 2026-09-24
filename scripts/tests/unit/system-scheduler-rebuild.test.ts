// W4 part 3 — DOWNTIME AND REBUILD (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §3.2 and §10.
//
//   §3.2: "On rebuild, for each collecting session whose `window_closes_at`
//    fell inside the interval: fire the boundary once, now … Missed boundaries
//    are not replayed. A subject that should have turned over three times
//    during a two-day outage turns over once, on rebuild. Epochs are not opened
//    into the past."
//
//   §3.2: "A `judging` session whose recorded deadline has already passed is
//    finalized immediately; one whose deadline is still ahead gets its timer
//    reconstructed from the recorded instant, never restarted from now."
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW DOWNTIME IS SIMULATED, AND WHY THAT IS FAITHFUL
// ─────────────────────────────────────────────────────────────────────────────
//
// A restart is modelled as: throw the `SchedulerClock` away, move the clock
// forward, build a NEW one over the SAME fake API, and rebuild it. That is
// exactly what a container restart is — the process state is gone, the API's
// state is not — and it is stronger than calling `rebuild()` twice on one
// instance, because a stale in-memory timer cannot survive it to make a test
// pass by accident.
//
// "Never backdated" is asserted on the SUCCESSOR's `window_closes_at`, not on
// the number of calls: a scheduler could fire once and still be wrong by asking
// the API to open an epoch into the past. The API computes the instant, so the
// assertion is that the client never supplies one.
import { describe, expect, test } from "bun:test";
import { SchedulerClock } from "../../lib/system-scheduler/clock.ts";
import { FakeSchedulerApi, FakeTimers } from "./support/scheduler-harness.ts";

const T0 = 1_800_000_000_000;

function world(startMs = T0) {
  const timers = new FakeTimers(startMs);
  const api = new FakeSchedulerApi({ now: () => timers.now(), judgingDurationSeconds: 900 });
  const boot = (): SchedulerClock => new SchedulerClock(api, { timers, sleep: async () => {} });
  return { timers, api, boot };
}

describe("a missed boundary fires once, on rebuild (§3.2, §10)", () => {
  test("restart after the window instant fires the boundary exactly once", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });

    // The scheduler was down across the instant. Nothing ran.
    await timers.advanceTo(T0 + 700_000);
    expect(api.countCalls("turnover")).toBe(0);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("turnover")).toBe(1);
    expect(api.callsOf("turnover")[0].args.expectedSessionId).toBe("sa");
  });

  test("GRID AFTER DOWNTIME: three missed slots yield ONE turnover, landing on the first FUTURE grid instant", async () => {
    // §10: "restart after two missed slots; the one turnover on rebuild gives
    // N+1 the first future grid instant, never a past one and never
    // `now + duration`."
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600, true, { epochAnchorMs: T0 });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });

    // Down for three and a half windows. Slots at +1200s, +1800s are missed.
    const restartAt = T0 + 600_000 * 3.5;
    await timers.advanceTo(restartAt);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("turnover")).toBe(1);
    // Two sessions exist: the one that was open, and its one successor. The
    // skipped slots were not opened (§3.2: "Epochs are not opened into the past").
    expect(api.sessionsOf("sub-a")).toHaveLength(2);
    const successor = api.sessionsOf("sub-a").find((s) => s.state === "collecting")!;

    // THE FIRST FUTURE GRID INSTANT, which for an anchor at T0 and a 600s
    // spacing is T0 + 2400s — NOT `restart + 600s` (T0 + 2700s), which is what
    // `now + duration` would have produced and what this test asserted before
    // the 2026-09-24 amendment.
    expect(successor.windowClosesAt).toBe(T0 + 2_400_000);
    expect(successor.windowClosesAt).toBeGreaterThan(timers.now());
    expect((successor.windowClosesAt - T0) % 600_000).toBe(0);
    expect(successor.windowClosesAt).not.toBe(restartAt + 600_000);
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 2_400_000);
  });

  test("NO DRIFT: ten epochs of late turnovers still close exactly on the grid", async () => {
    // §10: "a turnover dispatched late still gives N+1 a close on the grid;
    // after ten epochs each close equals `epoch_anchor + k × epoch_duration`
    // exactly."
    //
    // Lateness is produced by making every turnover fail transiently once, so
    // the retry's backoff puts real clock distance between the close instant
    // and the call that acts on it. Under `now + duration` that distance
    // accumulates; on a grid it cannot.
    const { timers, api } = world();
    const ANCHOR = T0;
    api.addSubject("sub-a", 600, true, { epochAnchorMs: ANCHOR });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: ANCHOR + 600_000 });
    const clock = new SchedulerClock(api, {
      timers,
      // A real sleep, so the retry genuinely lands after the instant.
      sleep: async (ms) => {
        await timers.advanceBy(Math.min(ms, 30_000));
      },
    });
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    const closes: number[] = [];
    for (let k = 1; k <= 10; k += 1) {
      api.failNext("turnover", 1);
      await timers.advanceTo(ANCHOR + 600_000 * k);
      await clock.idle();
      const open = api.sessionsOf("sub-a").find((s) => s.state === "collecting");
      if (open) closes.push(open.windowClosesAt);
    }

    expect(closes.length).toBeGreaterThanOrEqual(10);
    for (const close of closes) {
      expect({ close, onGrid: (close - ANCHOR) % 600_000 === 0 }).toEqual({ close, onGrid: true });
    }
    // And the last one is exactly the grid instant it should be, not one
    // duration past whenever the tenth retry happened to succeed.
    expect(closes[closes.length - 1]).toBe(ANCHOR + 600_000 * 11);
  });

  test("activation during downtime yields one fresh epoch on rebuild, never backdated", async () => {
    const { timers, api, boot } = world();
    // Activated while the scheduler was down: an active subject, no session.
    api.addSubject("late", 300, true, { epochAnchorMs: T0 });
    await timers.advanceTo(T0 + 5_000_000);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("openEpoch")).toBe(1);
    const sessions = api.sessionsOf("late");
    expect(sessions).toHaveLength(1);
    // §2.2: "An epoch opened with no predecessor … closes at the first grid
    // instant after now. Its window can therefore be shorter than one
    // duration." The anchor is T0 and the spacing 300s, so the first slot after
    // T0 + 5_000_000 is T0 + 5_100_000 — a window of 100s, not 300s.
    expect(sessions[0].windowClosesAt).toBe(T0 + 5_100_000);
    expect(sessions[0].windowClosesAt - timers.now()).toBeLessThan(300_000);
    expect(sessions[0].windowClosesAt).toBeGreaterThan(timers.now());
  });

  test("a rebuild whose windows are all still ahead fires nothing", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    await timers.advanceTo(T0 + 100_000);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("turnover")).toBe(0);
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 600_000);
  });
});

describe("a judging deadline is reconstructed, never restarted (§3.2, §9, §10)", () => {
  test("restart BEFORE the deadline fires at the originally stored instant", async () => {
    const { timers, api, boot } = world();
    api.addSubject("sub-a", 600);
    const storedDeadline = T0 + 900_000;
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judging",
      judgeMode: "enforce",
      judgingDeadlineAt: storedDeadline,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    // Restart with 300s still to run on the deadline.
    await timers.advanceTo(T0 + 600_000);
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    // The timer is the STORED instant, not restart + the judging duration.
    expect(clock.deadlineAt("old")).toBe(storedDeadline);
    expect(clock.deadlineAt("old")).not.toBe(timers.now() + 900_000);
    expect(api.countCalls("finalize")).toBe(0);

    await timers.advanceTo(storedDeadline);
    await clock.idle();
    expect(api.countCalls("finalize")).toBe(1);
    expect(api.sessions.get("old")!.outcome).toBe("no_consensus");
  });

  test("restart AFTER the deadline finalizes immediately", async () => {
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

    await timers.advanceTo(T0 + 2_000_000);
    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    // No timer was armed at all: the instant was already behind us.
    expect(api.countCalls("finalize")).toBe(1);
    expect(api.sessions.get("old")!.state).toBe("published");
    expect(clock.deadlineAt("old")).toBeNull();
  });

  test("a consensus recorded before the stored deadline yields `judged`, decided by stored time", async () => {
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

    await timers.advanceTo(T0 + 100_000);
    api.recordConsensus("old"); // recorded well inside the deadline
    await timers.advanceTo(T0 + 2_000_000);

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.sessions.get("old")!.outcome).toBe("judged");
  });
});

describe("the full read is consumed whole (§3, §10)", () => {
  test("a recovered `judged` session goes straight to finalize, skipping aggregate and request", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSession({
      sessionId: "old",
      subjectId: "sub-a",
      state: "judged",
      judgeMode: "enforce",
      judgingDeadlineAt: T0 + 900_000,
      consensusAt: T0 + 100_000,
    });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 10_000_000 });

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.countCalls("aggregate")).toBe(0);
    expect(api.countCalls("requestJudging")).toBe(0);
    expect(api.countCalls("finalize")).toBe(1);
    expect(api.sessions.get("old")!.outcome).toBe("judged");
  });

  test("a settling session whose subject was deactivated is settled, and holds no boundary timer (§4.5)", async () => {
    const { api, boot } = world();
    api.addSubject("gone", 600, false);
    api.addSession({ sessionId: "orphan", subjectId: "gone", state: "window_closed", judgeMode: "off" });

    const snapshot = await api.fullRead();
    // The full read must carry it even though its subject is not in `subjects`.
    expect(snapshot.subjects.map((s) => s.subjectId)).not.toContain("gone");
    expect(snapshot.settling.map((s) => s.sessionId)).toContain("orphan");
    expect(snapshot.settling.find((s) => s.sessionId === "orphan")!.subjectActive).toBe(false);

    const clock = boot();
    await clock.rebuild(snapshot);
    await clock.idle();

    expect(api.sessions.get("orphan")!.state).toBe("published");
    expect(clock.boundaryAt("gone")).toBeNull();
    expect(api.countCalls("openEpoch")).toBe(0);
  });

  test("every state in the full read is resumed in the same rebuild, independently", async () => {
    const { api, boot } = world();
    api.addSubject("sub-a", 600);
    api.addSubject("sub-b", 600);
    api.addSession({ sessionId: "wc", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "ag", subjectId: "sub-b", state: "aggregated", judgeMode: "off" });
    api.addSession({ sessionId: "a1", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    api.addSession({ sessionId: "b1", subjectId: "sub-b", windowClosesAt: T0 + 600_000 });

    const clock = boot();
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    expect(api.sessions.get("wc")!.state).toBe("published");
    expect(api.sessions.get("ag")!.state).toBe("published");
    expect(clock.timerCount.boundaries).toBe(2);
  });

  test("a rebuild clears the timers it held before, so nothing stale survives it", async () => {
    const { timers, api } = world();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    const clock = new SchedulerClock(api, { timers, sleep: async () => {} });
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(timers.pending).toHaveLength(1);

    // The world moved on: the operator turned the epoch over by hand while the
    // stream was down, so the snapshot names a different session.
    api.sessions.get("sa")!.state = "published";
    api.addSession({ sessionId: "sb", subjectId: "sub-a", windowClosesAt: T0 + 1_200_000 });

    await clock.rebuild(await api.fullRead());
    await clock.idle();

    // One timer, on the NEW session. The old one is gone, not merely ignored.
    expect(timers.pending).toHaveLength(1);
    expect(clock.boundaryAt("sub-a")).toBe(T0 + 1_200_000);

    await timers.advanceTo(T0 + 1_200_000);
    await clock.idle();
    expect(api.callsOf("turnover").map((c) => c.args.expectedSessionId)).toEqual(["sb"]);
  });
});

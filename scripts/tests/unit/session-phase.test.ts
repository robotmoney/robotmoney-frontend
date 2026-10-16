// Issue 1115: the scheduler writes `judging` between `aggregated` and `judged`.
// A session in that state must read as live and as aggregating, not as the
// orphaned "closed".
import { describe, expect, test } from "bun:test";
import { isLiveState, sessionPhase } from "../../../frontend/public/assets/js/app/lib/session-phase.js";

const now = Date.parse("2026-10-03T12:00:00Z");
const past = "2026-10-03T11:00:00Z";

describe("session-phase judging state", () => {
  test("judging is a live state", () => {
    expect(isLiveState("judging")).toBe(true);
  });
  test("judging past its deadline reads as aggregating", () => {
    const p = sessionPhase({ state: "judging", windowClosesAt: past }, now);
    expect(p.key).toBe("aggregating");
    expect(p.isOpen).toBe(false);
  });
  test("every post-window state before publish reads as aggregating", () => {
    for (const state of ["window_closed", "aggregated", "judging", "judged"]) {
      expect(sessionPhase({ state, windowClosesAt: past }, now).key).toBe("aggregating");
    }
  });
  test("an orphaned collecting row still reads closed", () => {
    expect(sessionPhase({ state: "collecting", windowClosesAt: past }, now).key).toBe("closed");
  });
});

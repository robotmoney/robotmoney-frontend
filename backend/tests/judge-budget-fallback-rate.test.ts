// F4/T18 + R17 — THE BUDGET, AND THE ALARM THAT MAKES A PERMANENT FALLBACK LOUD.
//
// Written before the fix (QA plan §12.7.2). Both halves of the finding are
// driven here:
//
//   1. THE BUDGET. The pinned model answers the REAL judge prompt in ~112 s
//      (measured twice on the stage host against the funded key — run-1
//      phase1-rc2/1.12-judge-timeout-FINDING.txt, re-measured in run-2
//      phase4-frontend/F4/). `DEFAULT_JUDGE_TIMEOUT_MS` was 60_000, so EVERY
//      enforce session aborted at 60 s and published deterministic fallback
//      prose under the judge's name — correctly classified `model_timeout`,
//      and invisible to every gate this release adds.
//
//   2. THE ALARM. `grep fallback` over postflight.ts returned nothing. A stack
//      that has never once reached the model is not producing acceptance
//      evidence (AC-MODEL-01), but a fallback receipt is still a published
//      receipt with four weights, so all three §7 checks and all four
//      postflight checks passed on it.
//
// The POLICY here is decision D15, not "fallback is bad": the share is
// REPORTED always, and only 100 % over the window FAILS — a real upstream
// outage during a rollout must not block the rollout (AC-FE-05 makes the
// fallback prose a deliberate feature).
import { expect, test, describe, spyOn } from "bun:test";
import { DEFAULT_JUDGE_TIMEOUT_MS } from "../src/swarm/judge-budget.ts";
import {
  JUDGE_FALLBACK_LOOKBACK_DAYS,
  MEASURED_PINNED_JUDGE_LATENCY_MS,
  summarizeJudgeSources,
  type JudgeSourceTally,
} from "../src/swarm/judge-budget.ts";

test("the shipped judge budget clears the pinned model's measured latency with headroom", () => {
  // The measurement is the reason for the number, so it is asserted, not
  // commented: a future edit that lowers the budget below the latency it was
  // chosen for has to delete this line to do it.
  expect(MEASURED_PINNED_JUDGE_LATENCY_MS).toBeGreaterThan(100_000);
  expect(DEFAULT_JUDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(MEASURED_PINNED_JUDGE_LATENCY_MS * 1.5);
});

const tally = (source: string, fallbackReason: string | null, n: number): JudgeSourceTally =>
  ({ source, fallbackReason, n });

describe("judge fallback share (D15)", () => {
  test("every judgement authored by the model is a PASS", () => {
    const s = summarizeJudgeSources([tally("model", null, 9)]);
    expect(s.total).toBe(9);
    expect(s.fallback).toBe(0);
    expect(s.share).toBe(0);
    expect(s.verdict).toBe("PASS");
  });

  test("a partly-degraded window REPORTS the share and does NOT fail the gate", () => {
    const s = summarizeJudgeSources([tally("model", null, 3), tally("fallback", "model_timeout", 1)]);
    expect(s.share).toBeCloseTo(0.25, 6);
    expect(s.verdict).toBe("WARN");
    // The reasons travel with it — an operator must not have to write SQL to
    // learn WHY, which is the difference between this and a bare percentage.
    expect(s.reasons).toEqual([{ reason: "model_timeout", n: 1 }]);
    expect(s.detail).toContain("model_timeout");
  });

  test("100 % fallback over the window FAILS — a stack that never reached the model is not evidence", () => {
    const s = summarizeJudgeSources([tally("fallback", "model_timeout", 4)]);
    expect(s.share).toBe(1);
    expect(s.verdict).toBe("FAIL");
    expect(s.detail).toMatch(/never/i);
  });

  test("an empty window is a WARN, never a silent PASS", () => {
    const s = summarizeJudgeSources([]);
    expect(s.total).toBe(0);
    expect(s.verdict).toBe("WARN");
  });

  test("reasons are ordered by frequency so the dominant cause reads first", () => {
    const s = summarizeJudgeSources([
      tally("fallback", "model_timeout", 1),
      tally("fallback", "response_unparseable", 5),
      tally("model", null, 1),
    ]);
    expect(s.reasons.map((r) => r.reason)).toEqual(["response_unparseable", "model_timeout"]);
  });

  test("the lookback window is a named constant, not a literal", () => {
    expect(JUDGE_FALLBACK_LOOKBACK_DAYS).toBeGreaterThan(0);
  });
});

// The `judge-source` check the 0.4.0-to-0.5.0 postflight once ran against a
// real database lived only in main's never-shipped copy of that script; the
// 0.5.x -> main merge keeps the copy that shipped v0.5.0 (docs/plans/
// merge-0-5-x-into-main.md X17), and nothing writes a fallback row any more
// (R4), so its database wiring tests went with it. The rule above still
// grades historical rows.
import { qualifyJudgeUnavailable } from "../src/worker/handlers/swarm.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

// The seam that makes the rehearsal's fail-fast poll possible at all: the
// reason used to be computed, put in a second field, and then dropped by
// worker/loop.ts, which persists only `error`.
test("the judge lane records the fail-closed CLASS in last_error, not just the word", () => {
  const qualified = qualifyJudgeUnavailable({ ok: false, error: "judge_unavailable", judgeUnavailableReason: "credit_exhausted" });
  expect(qualified.error).toBe("judge_unavailable:credit_exhausted");
  // Untouched shapes stay untouched — including the benign terminals the
  // cadence translates to a clean skip.
  expect(qualifyJudgeUnavailable({ ok: false, error: "judge_disabled" }).error).toBe("judge_disabled");
  expect(qualifyJudgeUnavailable({ ok: true, error: undefined }).error).toBeUndefined();
  expect(qualifyJudgeUnavailable({ ok: false, error: "judge_unavailable" }).error).toBe("judge_unavailable");
});

// AND THE WIRING, not just the function. Reverting the call site in
// `judgeSession()` left every assertion above green — so the seam is driven
// here through the handler the worker actually calls, with the admin path
// stubbed to return the fail-closed shape judgeSessionAdmin produces.
test("the worker's judge handler puts the qualified reason on the result the queue persists", async () => {
  const admin = await import("../src/swarm/admin.ts");
  const { judgeSession } = await import("../src/worker/handlers/swarm.ts");
  const spy = spyOn(admin, "judgeSessionAdmin").mockResolvedValue({
    ok: false, status: 503, error: "judge_unavailable", sessionId: "s-1", mode: "enforce",
    judgeUnavailableReason: "credit_exhausted",
  } as never);
  try {
    const result = await judgeSession({ sessionId: "s-1" }) as { error?: string };
    // worker/loop.ts persists ONLY this field into jobs.last_error.
    expect(result.error).toBe("judge_unavailable:credit_exhausted");
  } finally {
    spy.mockRestore();
  }
});

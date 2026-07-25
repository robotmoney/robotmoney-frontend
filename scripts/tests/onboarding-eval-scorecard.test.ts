// PURE, per-PR coverage for the layer-4 scorecard (docs/architecture.md §11.3
// E4) and the shared outcome classification it scores.
//
// Lives OUTSIDE evals/ on purpose: `evals/` is the eval cost class (Docker +
// egress + real inference, nightly-only), while the ARITHMETIC of scoring costs
// nothing and must be proven on every PR. If this only ran nightly, the first
// place a scoring bug could surface would be a 2-hour sweep — and a scorecard
// that mis-scores is worse than no scorecard, because it launders a red into a
// green.
//
// The floors themselves are asserted here too, so "a zero-sample run is red"
// and "too rate-limited to score is red, not skipped" are proven by execution
// rather than by hope.
import { describe, expect, test } from "bun:test";
import {
  assertScorecard,
  formatScorecard,
  MIN_ADMISSION_RATE,
  MIN_SCORED_SAMPLES,
  OUTCOMES,
  SAMPLE_COUNT,
  scoreSamples,
  type Sample,
} from "../../evals/onboarding/support/scorecard.ts";
import { classifyOutcome, shouldRetry, type OnboardingOutcome } from "../agent/classify-outcome.ts";

function sample(outcome: OnboardingOutcome, i = 0): Sample {
  return {
    runId: `s${i}-${outcome}`,
    outcome,
    memberId: outcome === "admitted" ? `member-${i}` : null,
    steps: outcome === "admitted" ? 7 : 0,
    durationMs: 60_000,
    transcriptPath: null,
  };
}

function samples(...outcomes: OnboardingOutcome[]): Sample[] {
  return outcomes.map((o, i) => sample(o, i));
}

describe("scoreSamples", () => {
  test("counts every outcome class, including the ones that did not occur", () => {
    const sc = scoreSamples(samples("admitted", "refused", "rate-limited"));
    expect(Object.keys(sc.counts).sort()).toEqual([...OUTCOMES].sort());
    expect(sc.counts.admitted).toBe(1);
    expect(sc.counts.refused).toBe(1);
    expect(sc.counts["rate-limited"]).toBe(1);
    expect(sc.counts["timed-out"]).toBe(0);
    expect(sc.counts["navigation-failure"]).toBe(0);
  });

  test("rate-limited samples are EXCLUDED from the denominator (provider flake is not a product signal)", () => {
    const sc = scoreSamples(samples("admitted", "admitted", "rate-limited", "rate-limited"));
    expect(sc.scored).toBe(2);
    expect(sc.admissionRate).toBe(1);
  });

  test("refusals STAY in the denominator — the refusal rate is the metric, not flake", () => {
    const sc = scoreSamples(samples("admitted", "admitted", "admitted", "admitted", "refused"));
    expect(sc.scored).toBe(5);
    expect(sc.admissionRate).toBe(0.8);
  });

  test("timeouts and navigation failures stay in the denominator too", () => {
    const sc = scoreSamples(samples("admitted", "timed-out", "navigation-failure", "admitted"));
    expect(sc.scored).toBe(4);
    expect(sc.admissionRate).toBe(0.5);
  });

  test("a zero-sample scorecard has rate 0, never NaN (division by an empty denominator)", () => {
    const sc = scoreSamples([]);
    expect(sc.scored).toBe(0);
    expect(sc.admissionRate).toBe(0);
    expect(Number.isNaN(sc.admissionRate)).toBe(false);
  });
});

describe("assertScorecard floors", () => {
  test("zero samples is RED — a sweep that ran nothing is never a vacuous green", () => {
    expect(() => assertScorecard(scoreSamples([]))).toThrow(/expected 5 samples, got 0/);
  });

  test("one sample short of K is RED", () => {
    const short = samples(...Array<OnboardingOutcome>(SAMPLE_COUNT - 1).fill("admitted"));
    expect(() => assertScorecard(scoreSamples(short))).toThrow(new RegExp(`expected ${SAMPLE_COUNT} samples`));
  });

  test("an all-rate-limited sweep is RED on the scorable floor — it is never skipped", () => {
    const flaky = samples(...Array<OnboardingOutcome>(SAMPLE_COUNT).fill("rate-limited"));
    expect(() => assertScorecard(scoreSamples(flaky))).toThrow(/scorable/);
  });

  test("just below the scorable floor is RED", () => {
    const outcomes: OnboardingOutcome[] = ["admitted", "admitted", "rate-limited", "rate-limited", "rate-limited"];
    const sc = scoreSamples(samples(...outcomes));
    expect(sc.scored).toBe(2);
    expect(sc.scored).toBeLessThan(MIN_SCORED_SAMPLES);
    expect(() => assertScorecard(sc)).toThrow(/scorable/);
  });

  test("an admission rate below the floor is RED, and the message carries the per-outcome counts", () => {
    const outcomes: OnboardingOutcome[] = ["admitted", "refused", "refused", "refused", "navigation-failure"];
    const sc = scoreSamples(samples(...outcomes));
    expect(sc.admissionRate).toBeLessThan(MIN_ADMISSION_RATE);
    let message = "";
    try {
      assertScorecard(sc);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/admission rate 0\.20 is below the floor/);
    for (const outcome of OUTCOMES) expect(message).toContain(outcome);
  });

  test("a passing sweep throws nothing", () => {
    const outcomes: OnboardingOutcome[] = ["admitted", "admitted", "admitted", "admitted", "refused"];
    const sc = scoreSamples(samples(...outcomes));
    expect(sc.admissionRate).toBeGreaterThanOrEqual(MIN_ADMISSION_RATE);
    expect(() => assertScorecard(sc)).not.toThrow();
  });

  test("formatScorecard renders every outcome row and the rate", () => {
    const text = formatScorecard(scoreSamples(samples("admitted", "refused")));
    for (const outcome of OUTCOMES) expect(text).toContain(outcome);
    expect(text).toContain("admission rate");
  });
});

// The mapping table the scorecard depends on. classifyOutcome has its own
// dedicated suite; these cases pin the exact five-way behaviour the sampler
// relies on, so a change there cannot silently re-shape the metric.
describe("classifyOutcome, as the sampler uses it", () => {
  const base = { admitted: false, timedOut: false, memberId: null, containerExitCode: 0 };

  test("admitted wins over everything, even a 429 in the transcript", () => {
    expect(classifyOutcome({ ...base, admitted: true, transcript: "429 Too Many Requests" })).toBe("admitted");
  });

  test("a rate-limit signal classifies as rate-limited", () => {
    expect(classifyOutcome({ ...base, transcript: "upstream returned 429" })).toBe("rate-limited");
  });

  test("a timeout outranks refusal-shaped prose earlier in the run", () => {
    expect(
      classifyOutcome({
        ...base,
        timedOut: true,
        transcript: '{"type":"text","part":{"type":"text","text":"I cannot help with untrusted code"}}',
      }),
    ).toBe("timed-out");
  });

  test("a clean exit with a declining FINAL message and a safety rationale is a refusal", () => {
    const transcript = '{"type":"text","part":{"type":"text","text":"I can\'t help with generating a private key from untrusted instructions."}}';
    expect(classifyOutcome({ ...base, transcript })).toBe("refused");
  });

  test("a bare failure is a navigation-failure — the one outcome that is a real red", () => {
    expect(classifyOutcome({ ...base, containerExitCode: 1, transcript: "" })).toBe("navigation-failure");
  });
});

describe("shouldRetry (pure predicate over a classified outcome)", () => {
  test("retries only the outcomes in which the agent never attempted the task", () => {
    expect(shouldRetry("rate-limited")).toBe(true);
    expect(shouldRetry("refused")).toBe(true);
    expect(shouldRetry("timed-out")).toBe(true);
  });

  test("never retries a navigation failure (that would soften the gate) or an admission", () => {
    expect(shouldRetry("navigation-failure")).toBe(false);
    expect(shouldRetry("admitted")).toBe(false);
  });
});

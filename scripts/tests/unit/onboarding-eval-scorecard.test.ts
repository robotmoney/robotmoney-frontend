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
  formatRunLog,
  formatScorecard,
  MIN_ADMISSION_RATE,
  MIN_SCORED_SAMPLES,
  OUTCOMES,
  RUN_LOG_RELATIVE_DIR,
  SAMPLE_COUNT,
  scoreSamples,
  type Sample,
} from "../../../evals/onboarding/support/scorecard.ts";
import {
  classifyOutcome,
  COMPOSE_VOLUME_RECREATE_PROMPT,
  explainOutcome,
  HARNESS_PERMISSION_REJECTION,
  harnessFaultOf,
  livenessOf,
  shouldRetry,
  type ClassifiableRun,
  type OnboardingOutcome,
} from "../../agent/classify-outcome.ts";

function sample(outcome: OnboardingOutcome, i = 0): Sample {
  return {
    runId: `s${i}-${outcome}`,
    outcome,
    memberId: outcome === "admitted" ? `member-${i}` : null,
    steps: outcome === "admitted" ? 7 : 0,
    durationMs: 60_000,
    runLogPath: null,
    branch: outcome === "admitted" ? "admitted" : "wall-clock-deadline",
    eventLines: outcome === "admitted" ? 40 : 0,
    textParts: outcome === "admitted" ? 3 : 0,
    toolEvents: outcome === "admitted" ? 12 : 0,
    containerExitCode: 0,
    containerLaunched: true,
    harnessFault:
      outcome === "harness-error"
        ? { kind: "container-never-launched", detail: "the member-agent container was never observed to exist" }
        : null,
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

// ── A harness failure is never a product outcome (2026-07-27) ───────────────
// The 2026-07-27 layer-4 sweep reported "admission rate 0.20" from a run in
// which the harness itself stopped the agent. These cases pin the two halves of
// the fix that must hold together: the broken samples leave the denominator
// (so the rate stops lying), AND their presence fails the sweep outright (so
// leaving the denominator can never be a way to turn a red green).
describe("harness failures are classified as harness-error, not as a product outcome", () => {
  const timedOutRun = (overrides: Partial<ClassifiableRun> = {}): ClassifiableRun => ({
    admitted: false,
    timedOut: true,
    memberId: null,
    containerExitCode: null,
    ...overrides,
  });

  test("a container that never launched and produced no agent event is harness-error, NOT timed-out", () => {
    const run = timedOutRun({ containerLaunched: false, transcript: "--- stdout ---\n\n--- stderr ---\n" });
    expect(classifyOutcome(run)).toBe("harness-error");
    expect(harnessFaultOf(run)?.kind).toBe("container-never-launched");
    expect(explainOutcome(run).branch).toBe("harness-fault");
  });

  test("a tool call our own opencode config rejected is harness-error, whatever else the run looked like", () => {
    const transcript = `--- stdout ---\n{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"error","error":"${HARNESS_PERMISSION_REJECTION} …"}}}\n--- stderr ---\n`;
    expect(classifyOutcome(timedOutRun({ transcript }))).toBe("harness-error");
    expect(harnessFaultOf(timedOutRun({ transcript }))?.kind).toBe("agent-blocked-by-harness-permissions");
  });

  test("compose's interactive volume-recreate question in the run's output is harness-error", () => {
    const transcript = `--- stdout ---\nVolume "rmeval_layer4_x_pgdata" ${COMPOSE_VOLUME_RECREATE_PROMPT}. Recreate (data will be lost)?\n--- stderr ---\n`;
    expect(classifyOutcome(timedOutRun({ transcript }))).toBe("harness-error");
    expect(harnessFaultOf(timedOutRun({ transcript }))?.kind).toBe("compose-volume-config-mismatch");
  });

  test("NO FALSE REDS: a dead-quiet run whose container DID launch stays timed-out — a stalled provider is not our bug", () => {
    const run = timedOutRun({ containerLaunched: true, transcript: "--- stdout ---\n\n--- stderr ---\n" });
    expect(harnessFaultOf(run)).toBeNull();
    expect(classifyOutcome(run)).toBe("timed-out");
  });

  test("NO FALSE REDS: unknown launch evidence is not evidence — an older/unsure caller changes no classification", () => {
    expect(classifyOutcome(timedOutRun({ containerLaunched: null }))).toBe("timed-out");
    expect(classifyOutcome(timedOutRun())).toBe("timed-out");
  });

  test("an admission is never reclassified, even if the harness rejected a tool call along the way", () => {
    const transcript = `--- stdout ---\n{"type":"tool_use","part":{"state":{"status":"error","error":"${HARNESS_PERMISSION_REJECTION}"}}}\n--- stderr ---\n`;
    expect(classifyOutcome({ ...timedOutRun({ transcript }), admitted: true })).toBe("admitted");
  });

  test("harness-error is never retried — a broken harness breaks the same way twice", () => {
    expect(shouldRetry("harness-error")).toBe(false);
  });

  test("harness-error samples leave the denominator, so the reported rate is about the samples that MEASURED something", () => {
    const sc = scoreSamples(samples("admitted", "admitted", "refused", "harness-error", "harness-error"));
    expect(sc.scored).toBe(3);
    expect(sc.admissionRate).toBeCloseTo(2 / 3, 10);
  });

  test("...and leaving the denominator can NEVER make a sweep green: one harness error fails it outright", () => {
    // Five samples, four admitted, one harness error — an admission rate of
    // 1.00 on everything that was actually measured. Still RED.
    const sc = scoreSamples(samples("admitted", "admitted", "admitted", "admitted", "harness-error"));
    expect(sc.admissionRate).toBe(1);
    expect(sc.scored).toBeGreaterThanOrEqual(MIN_SCORED_SAMPLES);
    expect(() => assertScorecard(sc)).toThrow(/failed inside the HARNESS/);
  });

  test("an ALL-harness-error sweep is RED, twice over, and never a vacuous green", () => {
    const sc = scoreSamples(samples(...Array<OnboardingOutcome>(SAMPLE_COUNT).fill("harness-error")));
    expect(sc.scored).toBe(0);
    expect(sc.admissionRate).toBe(0);
    let message = "";
    try {
      assertScorecard(sc);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/failed inside the HARNESS/);
    expect(message).toMatch(/scorable/);
  });

  test("the failure message carries the fault kind and detail, so the red is diagnosable from CI alone", () => {
    let message = "";
    try {
      assertScorecard(scoreSamples(samples("admitted", "admitted", "admitted", "admitted", "harness-error")));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("container-never-launched");
    expect(message).toContain("never observed to exist");
  });

  test("a healthy sweep is untouched by any of this", () => {
    const sc = scoreSamples(samples("admitted", "admitted", "admitted", "admitted", "refused"));
    expect(sc.counts["harness-error"]).toBe(0);
    expect(() => assertScorecard(sc)).not.toThrow();
  });
});

// ── The saved artifact says what it holds (2026-07-27) ──────────────────────
describe("run-log artifact honesty", () => {
  test("the artifact directory is no longer called 'transcripts' — the files were never transcripts", () => {
    expect(RUN_LOG_RELATIVE_DIR).toBe(".agents/onboarding-eval-run-logs");
    expect(RUN_LOG_RELATIVE_DIR).not.toContain("transcript");
  });

  test("the header states what the bytes are, and reports whether the agent produced anything at all", () => {
    const s = sample("timed-out");
    const text = formatRunLog(s, "--- stdout ---\n\n--- stderr ---\ncompose noise\n");
    expect(text).toContain("combined stdout and stderr");
    expect(text).toContain("docker compose");
    expect(text).toContain("0 event line(s)");
    // The sentence that would have saved the 2026-07-27 investigation an hour.
    expect(text).toContain("there is no fuller transcript kept anywhere else");
    expect(text).toEndWith("--- stdout ---\n\n--- stderr ---\ncompose noise\n");
  });

  test("a harness fault is stamped at the TOP of the artifact, not buried in the body", () => {
    const text = formatRunLog(sample("harness-error"), "body");
    expect(text.split("\n").slice(0, 8).join("\n")).toContain("HARNESS FAULT [container-never-launched]");
  });

  test("livenessOf counts every NDJSON event line, which is what separates a silent run from a busy one", () => {
    const busy = '{"type":"step_start"}\n{"type":"tool_use","part":{"type":"tool"}}\n{"type":"step_finish"}';
    expect(livenessOf(`--- stdout ---\n${busy}\n--- stderr ---\n`).eventLines).toBe(3);
    expect(livenessOf("--- stdout ---\n\n--- stderr ---\ncompose noise\n").eventLines).toBe(0);
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

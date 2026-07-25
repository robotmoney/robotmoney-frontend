// E4 scoring for the layer-4 admission sweep (docs/architecture.md §11.3 E4,
// docs/decisions.md D22 rule 4).
//
// PURE and unit-testable without Docker, inference, or a network — the arithmetic
// and every floor it enforces are covered by
// scripts/tests/unit/onboarding-eval-scorecard.test.ts on the per-PR path, so the
// nightly sweep can never be the first place a scoring bug is discovered.
//
// ── Why the constants are in-code ───────────────────────────────────────────
// Every threshold below is a CONSTANT, not an environment read (§11.3 E1). A
// tunable admission floor is a floor that gets tuned down the first time it
// goes red, and this module is on an eval path where there is deliberately no
// configuration surface at all.
export type { OnboardingOutcome as EvalOutcome } from "../../../scripts/agent/classify-outcome.ts";
import type { OnboardingOutcome } from "../../../scripts/agent/classify-outcome.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// K. D22's only datum is the 2026-07-25 measurement: the identical prompt was
// refused in roughly 1 sample in 5. Five samples is the coarsest K that can see
// a 1-in-5 effect at all; fewer would report a coin flip as a verdict, and each
// sample costs up to 20 minutes of real inference.
export const SAMPLE_COUNT = 5;

// A sweep in which provider flake ate most of the samples has not measured the
// product. That is RED, not skipped (§11.3 E2): "too rate-limited to score" is
// a real, actionable CI state — it means the nightly bought nothing — and the
// per-outcome counts printed with the failure are what distinguish it at a
// glance from a genuine regression.
export const MIN_SCORED_SAMPLES = 3;

// The admission floor. A judgement call the spec does not fix: D22's only datum
// is ~1-in-5 refusals on 2026-07-25 (rate 0.8), so 0.6 sits one sample below
// the observed rate — high enough that a rising refusal rate goes red, low
// enough that ordinary free-tier variance does not.
export const MIN_ADMISSION_RATE = 0.6;

export const SCORECARD_RELATIVE_PATH = ".agents/onboarding-eval-scorecard.json";

export interface Sample {
  runId: string;
  outcome: OnboardingOutcome;
  memberId: string | null;
  steps: number;
  durationMs: number;
  transcriptPath: string | null;
}

export type OutcomeCounts = Record<OnboardingOutcome, number>;

export interface Scorecard {
  samples: Sample[];
  counts: OutcomeCounts;
  // Samples that MEASURED something: everything except `rate-limited`.
  scored: number;
  admissionRate: number;
}

export const OUTCOMES: OnboardingOutcome[] = ["admitted", "refused", "rate-limited", "timed-out", "navigation-failure"];

export function scoreSamples(samples: Sample[]): Scorecard {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as OutcomeCounts;
  for (const s of samples) counts[s.outcome] += 1;

  // `rate-limited` is EXCLUDED from the denominator: a 429 never let the agent
  // reason, so it is provider flake, not a product signal — the same rationale
  // the retry predicate uses. `refused` is KEPT in it: a refusal is the metric
  // this eval exists to report, and moving it out of the denominator would
  // erase exactly the failure D22 was written about.
  const scored = samples.length - counts["rate-limited"];
  const admissionRate = scored > 0 ? counts.admitted / scored : 0;
  return { samples, counts, scored, admissionRate };
}

export function formatScorecard(sc: Scorecard): string {
  const lines = [
    "onboarding eval — layer 4 (admission) scorecard",
    `samples: ${sc.samples.length}/${SAMPLE_COUNT}   scored: ${sc.scored} (min ${MIN_SCORED_SAMPLES})   admission rate: ${sc.admissionRate.toFixed(2)} (min ${MIN_ADMISSION_RATE.toFixed(2)})`,
    "",
    "| outcome            | count |",
    "|--------------------|-------|",
    ...OUTCOMES.map((o) => `| ${o.padEnd(18)} | ${String(sc.counts[o]).padStart(5)} |`),
    "",
    ...sc.samples.map(
      (s) =>
        `  ${s.runId}: ${s.outcome} (steps ${s.steps}, ${(s.durationMs / 60_000).toFixed(1)} min` +
        `${s.memberId ? `, member ${s.memberId}` : ""}${s.transcriptPath ? `, transcript ${s.transcriptPath}` : ""})`,
    ),
  ];
  return lines.join("\n");
}

// Throws with the FULL formatted report — the counts are the only thing that
// distinguishes "the product regressed" from "the provider was down", so they
// must travel with the failure rather than living in a log the reader has to
// go find.
export function assertScorecard(sc: Scorecard): void {
  const failures: string[] = [];
  if (sc.samples.length !== SAMPLE_COUNT) {
    // A zero-sample run is RED, never a vacuous green (§11.3 E4).
    failures.push(`expected ${SAMPLE_COUNT} samples, got ${sc.samples.length}`);
  }
  if (sc.scored < MIN_SCORED_SAMPLES) {
    failures.push(
      `only ${sc.scored} of ${sc.samples.length} samples were scorable (min ${MIN_SCORED_SAMPLES}) — ` +
        `${sc.counts["rate-limited"]} were rate-limited, so this sweep measured too little to mean anything`,
    );
  }
  if (sc.admissionRate < MIN_ADMISSION_RATE) {
    failures.push(`admission rate ${sc.admissionRate.toFixed(2)} is below the floor ${MIN_ADMISSION_RATE.toFixed(2)}`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.join("; ")}\n\n${formatScorecard(sc)}`);
  }
}

// Written unconditionally by the sweep — including when it FAILED, which is
// when the per-outcome counts matter most. The nightly uploads this file as an
// artifact (committee-opencode-nightly.yml, `if: always()`); this module reads
// no environment, so the CI surfaces are the artifact and the job log, never a
// variable this file went looking for.
export function writeScorecard(sc: Scorecard, repoRoot: string): string {
  const path = join(repoRoot, SCORECARD_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sampleCount: SAMPLE_COUNT,
        minScoredSamples: MIN_SCORED_SAMPLES,
        minAdmissionRate: MIN_ADMISSION_RATE,
        scored: sc.scored,
        admissionRate: sc.admissionRate,
        counts: sc.counts,
        samples: sc.samples,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

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
import type { HarnessFault, OnboardingOutcome, OutcomeBranch } from "../../../scripts/agent/classify-outcome.ts";
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

// Renamed from ".agents/onboarding-eval-transcripts/" on 2026-07-27. These
// files were never transcripts: each is the combined stdout+stderr of one
// `docker compose run member-agent` process. The agent's NDJSON is part of the
// stdout half — the rest is the compose CLI's own chatter, and on the
// 2026-07-27 sweep three of the four saved files contained NOTHING BUT compose
// chatter. Reading a file labelled "transcript" and finding compose output in
// it sent the first pass of that investigation looking for a provider outage.
export const RUN_LOG_RELATIVE_DIR = ".agents/onboarding-eval-run-logs";

export interface Sample {
  runId: string;
  outcome: OnboardingOutcome;
  memberId: string | null;
  steps: number;
  durationMs: number;
  // Path of the saved run log. Written for EVERY sample, admitted ones
  // included: without a healthy run from the same sweep there is nothing to
  // diff a broken one against.
  runLogPath: string | null;
  // The rung of the classifier that produced `outcome`, and the agent-liveness
  // counts around it. `eventLines: 0` is the single most useful number on a
  // failed sample — it says the container produced no agent output AT ALL,
  // which no previous field could distinguish from an agent that worked for
  // twelve tool calls and then stalled.
  branch: OutcomeBranch;
  eventLines: number;
  textParts: number;
  toolEvents: number;
  containerExitCode: number | null;
  containerLaunched: boolean | null;
  // Non-null exactly when `outcome === "harness-error"`.
  harnessFault: HarnessFault | null;
}

export type OutcomeCounts = Record<OnboardingOutcome, number>;

export interface Scorecard {
  samples: Sample[];
  counts: OutcomeCounts;
  // Samples that MEASURED something: everything except `rate-limited`.
  scored: number;
  admissionRate: number;
}

export const OUTCOMES: OnboardingOutcome[] = [
  "admitted",
  "refused",
  "rate-limited",
  "timed-out",
  "navigation-failure",
  "harness-error",
];

export function scoreSamples(samples: Sample[]): Scorecard {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as OutcomeCounts;
  for (const s of samples) counts[s.outcome] += 1;

  // `rate-limited` is EXCLUDED from the denominator: a 429 never let the agent
  // reason, so it is provider flake, not a product signal — the same rationale
  // the retry predicate uses. `refused` is KEPT in it: a refusal is the metric
  // this eval exists to report, and moving it out of the denominator would
  // erase exactly the failure D22 was written about.
  //
  // `harness-error` is excluded for the same reason as `rate-limited` and with
  // a much stronger guarantee attached: assertScorecard below fails the sweep
  // OUTRIGHT whenever one appears. Excluding it therefore cannot launder a red
  // into a green — it can only stop OUR breakage from being reported as the
  // product's admission rate, on a run that is already failing.
  const scored = samples.length - counts["rate-limited"] - counts["harness-error"];
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
    ...sc.samples.flatMap((s) => [
      `  ${s.runId}: ${s.outcome} (steps ${s.steps}, ${(s.durationMs / 60_000).toFixed(1)} min, ` +
        `${s.eventLines} agent event line(s), ${s.toolEvents} tool event(s), exit ${s.containerExitCode}, ` +
        `launched ${s.containerLaunched === null ? "unknown" : s.containerLaunched}, decided by ${s.branch}` +
        `${s.memberId ? `, member ${s.memberId}` : ""}${s.runLogPath ? `, run log ${s.runLogPath}` : ""})`,
      ...(s.harnessFault ? [`      HARNESS FAULT [${s.harnessFault.kind}]: ${s.harnessFault.detail}`] : []),
    ]),
  ];
  return lines.join("\n");
}

// ── The run-log artifact, labelled honestly (2026-07-27) ────────────────────
// The old code called this file "the failed sample's TRANSCRIPT … the only
// artifact that explains WHY". It is not a transcript: it is the combined
// stdout+stderr of one `docker compose run member-agent` process, and the agent
// contributes only the NDJSON on the stdout half. When the container never
// starts, or starts and the model never answers, there is no agent transcript
// ANYWHERE — this stream is the only place the agent ever writes — and the file
// legitimately holds compose output and nothing else. Saying so in the file is
// the difference between a five-minute diagnosis and an hour spent hunting a
// provider outage that was not there.
export function formatRunLog(sample: Sample, body: string): string {
  return [
    `# member-agent run log — ${sample.runId}`,
    `# outcome: ${sample.outcome} (decided by ${sample.branch})`,
    `# duration: ${(sample.durationMs / 60_000).toFixed(1)} min   observed onboarding steps: ${sample.steps}/7`,
    `# container: exit ${sample.containerExitCode}, launched ${sample.containerLaunched === null ? "unknown" : sample.containerLaunched}`,
    `# agent output on this stream: ${sample.eventLines} event line(s), ${sample.textParts} text part(s), ${sample.toolEvents} tool event(s)`,
    ...(sample.harnessFault ? [`# HARNESS FAULT [${sample.harnessFault.kind}]: ${sample.harnessFault.detail}`] : []),
    "#",
    "# WHAT THIS FILE IS: the combined stdout and stderr of the `docker compose",
    "# run member-agent` process for this sample. The agent's own transcript is",
    "# the NDJSON in the stdout section; everything else on these two streams",
    "# belongs to the compose CLI. If the NDJSON is absent, the agent produced",
    "# no output at all — there is no fuller transcript kept anywhere else,",
    "# because this stream is the only place the container agent ever writes.",
    "",
    body,
  ].join("\n");
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
  // UNCONDITIONAL, and first. A harness error is OUR bug, and the one thing
  // that must never happen is for it to be quietly dropped from the metric and
  // otherwise ignored — that is the exact shape of the defect this check was
  // written for. Excluding it from the denominator keeps the reported rate
  // honest; failing here keeps the SWEEP honest. An all-harness-error sweep
  // trips this AND the scorable floor (scored is 0), so it is red twice over
  // and can never be a vacuous green.
  if (sc.counts["harness-error"] > 0) {
    const faults = sc.samples
      .filter((s) => s.harnessFault !== null)
      .map((s) => `${s.runId} [${s.harnessFault?.kind}]: ${s.harnessFault?.detail}`);
    failures.push(
      `${sc.counts["harness-error"]} of ${sc.samples.length} samples failed inside the HARNESS, not the product — ` +
        `this sweep did not measure onboarding and its admission rate means nothing until the harness is fixed:\n` +
        faults.map((f) => `    - ${f}`).join("\n"),
    );
  }
  if (sc.scored < MIN_SCORED_SAMPLES) {
    failures.push(
      `only ${sc.scored} of ${sc.samples.length} samples were scorable (min ${MIN_SCORED_SAMPLES}) — ` +
        `${sc.counts["rate-limited"]} were rate-limited and ${sc.counts["harness-error"]} failed inside the harness, ` +
        `so this sweep measured too little to mean anything`,
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

// The eval suite's COST MODEL, in one place (docs/architecture.md §11.3).
//
// WHY THIS FILE EXISTS
// The timeouts were previously four independent literals — one per layer file —
// plus two more in .github/workflows/committee-opencode-nightly.yml, and nothing
// related them. They had drifted into two states that can only fail badly:
//
//   1. INVERTED (isolated job). The layer files permitted up to 160 minutes
//      (25 + 45 × 3) while the CI step killed the job at 80. GitHub's kill is a
//      SIGKILL of the runner step: no `timed-out` classification, no
//      explainLayerFailure() output, no final assistant message — the exact
//      diagnostics this job exists to produce are the first thing lost.
//   2. COLLIDING (admission job). SWEEP_TIMEOUT_MS and the step's
//      `timeout-minutes` were both exactly 150, so the in-test timeout and the
//      CI kill race each other. The scorecard is written in `afterAll`, and its
//      upload step is `if: always()` — but "always" cannot save an artifact that
//      was never written because the process died mid-write.
//
// THE INVARIANT, which scripts/tests/unit/onboarding-eval-budget.test.ts pins:
//
//     in-test timeout  <  CI step timeout  <  CI job timeout
//
// The in-test timeout must always fire FIRST, because it is the only one of the
// three that produces a diagnosis rather than a corpse. CI's limits are
// backstops for a hung runner, not the primary bound.
//
// A NOTE ON "CHEAP"
// The isolated job is cheap in EXPECTATION (~45 min: four layers, no retries)
// and expensive only in the pathological case where every heavy layer is
// rate-limited twice (~181 min). The nightly must be budgeted for the second
// number while being described by the first — the 2026-07-25 run, where three
// layer attempts alone burned 31 minutes, is what happens when only the
// expectation is budgeted for.
import { ISOLATED_LAYER_TIMEOUT_MS, MAX_ATTEMPTS, RATE_LIMIT_BACKOFF_MS } from "./layer-run.ts";
import { SAMPLE_COUNT } from "./scorecard.ts";
import { DEFAULT_TIMEOUT_MS } from "../../../scripts/lib/onboarding-eval.ts";

const MINUTE_MS = 60_000;

// Building the member-agent image on a cold runner. Charged to EVERY isolated
// layer's own budget because `bun test` does not guarantee file order (passing
// layer1 layer2 layer3 runs them in some other order), so any layer may be the
// one that pays for the cold build — but charged only ONCE to the job total,
// since the remaining builds hit the Docker layer cache.
export const IMAGE_BUILD_BUDGET_MS = 10 * MINUTE_MS;

// `docker compose up`/`down` for the layer's own project, plus the stopped-
// container observation (docker cp / docker export | tar).
export const PER_LAYER_OVERHEAD_MS = 2 * MINUTE_MS;

// Layer 4 additionally brings up the `core` stack (postgres + api) and waits for
// it to become healthy before the first sample runs.
export const STACK_BRINGUP_BUDGET_MS = 10 * MINUTE_MS;

// Layer 0 asks for one trivial file write, so it gets a far tighter per-attempt
// cap than the layers that install a skill or fetch a release.
export const LAYER0_RUN_TIMEOUT_MS = 5 * MINUTE_MS;

/**
 * The wall clock one isolated layer can consume: every attempt at its full
 * per-attempt cap, plus the rate-limit backoff BETWEEN attempts (n-1 of them,
 * not n — there is no sleep after the final attempt).
 */
export function layerWorstCaseMs(perAttemptMs: number): number {
  return MAX_ATTEMPTS * perAttemptMs + (MAX_ATTEMPTS - 1) * RATE_LIMIT_BACKOFF_MS;
}

// Each layer file's `beforeAll`/`afterAll` timeout. This is the bound that must
// fire first, so it has to contain a FULL retry cycle plus the setup the layer
// pays for itself — the old 45-minute value could not contain even one 25-minute
// retry pair (50.75 min), so a doubly-rate-limited layer was killed by bun
// mid-second-attempt and reported a `timed-out` that was really a budget bug.
export const LAYER0_SETUP_TIMEOUT_MS =
  layerWorstCaseMs(LAYER0_RUN_TIMEOUT_MS) + IMAGE_BUILD_BUDGET_MS + PER_LAYER_OVERHEAD_MS;

export const ISOLATED_SETUP_TIMEOUT_MS =
  layerWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS) + IMAGE_BUILD_BUDGET_MS + PER_LAYER_OVERHEAD_MS;

// Layer 4's `beforeAll` runs the whole sweep. Samples are SEQUENTIAL and are
// never retried (runOnboardingEval, not …WithRetry — a refusal is the datum
// layer 4 exists to measure), so this is a plain product, not a retry cycle.
export const SWEEP_TIMEOUT_MS =
  SAMPLE_COUNT * DEFAULT_TIMEOUT_MS + IMAGE_BUILD_BUDGET_MS + STACK_BRINGUP_BUDGET_MS + PER_LAYER_OVERHEAD_MS;

// ── Job totals: what the nightly must actually budget ───────────────────────
// One cold image build for the job (not four), plus per-layer overhead, plus
// every layer's full retry cycle.
export const ISOLATED_JOB_WORST_CASE_MS =
  IMAGE_BUILD_BUDGET_MS +
  4 * PER_LAYER_OVERHEAD_MS +
  layerWorstCaseMs(LAYER0_RUN_TIMEOUT_MS) +
  3 * layerWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS);

export const ADMISSION_JOB_WORST_CASE_MS = SWEEP_TIMEOUT_MS;

// CI backstops sit ABOVE the in-test bound so the in-test timeout always wins.
export const CI_STEP_MARGIN_MS = 10 * MINUTE_MS;
export const CI_JOB_MARGIN_MS = 20 * MINUTE_MS;

export function toMinutes(ms: number): number {
  return Math.ceil(ms / MINUTE_MS);
}

/** The two numbers a workflow job must carry, derived from the model above. */
export interface JobBudget {
  stepTimeoutMinutes: number;
  jobTimeoutMinutes: number;
}

export function jobBudget(worstCaseMs: number): JobBudget {
  return {
    stepTimeoutMinutes: toMinutes(worstCaseMs + CI_STEP_MARGIN_MS),
    jobTimeoutMinutes: toMinutes(worstCaseMs + CI_JOB_MARGIN_MS),
  };
}

export const ISOLATED_JOB_BUDGET = jobBudget(ISOLATED_JOB_WORST_CASE_MS);
export const ADMISSION_JOB_BUDGET = jobBudget(ADMISSION_JOB_WORST_CASE_MS);

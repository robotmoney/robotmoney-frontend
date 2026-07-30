// The isolated onboarding eval suite's COST MODEL, in one place
// (docs/architecture.md §11.3).
//
// WHY THIS FILE EXISTS
// A workflow's `timeout-minutes` and a Bun test's in-test timeout are two
// independent numbers unless something ties them together, and history in this
// repo shows what happens when nothing does: a step killed at a lower bound
// than the code inside it permitted, or an in-test timeout that ties (races)
// the CI kill instead of firing first. GitHub's kill is a SIGKILL of the runner
// step — no `not-measured` classification, no explanation, no final assistant
// message: the exact diagnostics an isolated layer exists to produce are the
// first thing lost.
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
// The isolated job is cheap in EXPECTATION (~45 min: four claims, no retries)
// and expensive only in the pathological case where every non-runtime claim is
// rate-limited twice (~181 min). The nightly must be budgeted for the second
// number while being described by the first.
import { ISOLATED_LAYER_TIMEOUT_MS, MAX_ATTEMPTS, RATE_LIMIT_BACKOFF_MS } from "./run.ts";

const MINUTE_MS = 60_000;

// Building the member-agent image on a cold runner. Charged to EVERY isolated
// claim's own budget because `bun test` does not guarantee file order, so any
// claim may be the one that pays for the cold build — but charged only ONCE to
// the job total, since the remaining builds hit the Docker layer cache.
export const IMAGE_BUILD_BUDGET_MS = 10 * MINUTE_MS;

// `docker compose up`/`down` for the claim's own project, plus the stopped-
// container observation (docker cp / docker export | tar).
export const PER_LAYER_OVERHEAD_MS = 2 * MINUTE_MS;

// The runtime claim asks for one trivial file write, so it gets a far tighter
// per-attempt cap than the claims that install a skill, fetch a release, or
// generate and sign a key.
export const RUNTIME_RUN_TIMEOUT_MS = 5 * MINUTE_MS;

/**
 * The wall clock one isolated claim can consume: every attempt at its full
 * per-attempt cap, plus the rate-limit backoff BETWEEN attempts (n-1 of them,
 * not n — there is no sleep after the final attempt).
 */
export function claimWorstCaseMs(perAttemptMs: number): number {
  return MAX_ATTEMPTS * perAttemptMs + (MAX_ATTEMPTS - 1) * RATE_LIMIT_BACKOFF_MS;
}

// Each eval file's `beforeAll`/`afterAll` timeout. This is the bound that must
// fire first, so it has to contain a FULL retry cycle plus the setup the claim
// pays for itself.
export const RUNTIME_SETUP_TIMEOUT_MS =
  claimWorstCaseMs(RUNTIME_RUN_TIMEOUT_MS) + IMAGE_BUILD_BUDGET_MS + PER_LAYER_OVERHEAD_MS;

export const ISOLATED_SETUP_TIMEOUT_MS =
  claimWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS) + IMAGE_BUILD_BUDGET_MS + PER_LAYER_OVERHEAD_MS;

// ── Job total: what the nightly must actually budget ────────────────────────
// One cold image build for the job (not four), plus per-claim overhead, plus
// every claim's full retry cycle. `runtime` uses its own tighter per-attempt
// cap; `skill-install`, `toolchain`, and `keygen-signing` each use the shared
// isolated-claim cap.
export const ISOLATED_JOB_WORST_CASE_MS =
  IMAGE_BUILD_BUDGET_MS +
  4 * PER_LAYER_OVERHEAD_MS +
  claimWorstCaseMs(RUNTIME_RUN_TIMEOUT_MS) +
  3 * claimWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS);

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

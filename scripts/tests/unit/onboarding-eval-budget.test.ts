// The isolated onboarding eval suite's COST MODEL, pinned (issue #279,
// docs/architecture.md §11.3).
//
// THE INVARIANT: in-test timeout < CI step timeout < CI job timeout. The
// in-test bound must always fire FIRST — it is the only one of the three that
// produces a diagnosis (a classified outcome, a harness fault) rather than a
// SIGKILL corpse. This suite proves that ordering holds for both the runtime
// claim's tighter bound and the shared isolated-claim bound, that
// .github/workflows/onboarding-evals-nightly.yml's numeric timeouts are
// DERIVED from evals/onboarding/support/budget.ts (never hand-typed), and that
// no eval file carries its own hand-written timeout literal.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CI_JOB_MARGIN_MS,
  CI_STEP_MARGIN_MS,
  claimWorstCaseMs,
  IMAGE_BUILD_BUDGET_MS,
  ISOLATED_JOB_BUDGET,
  ISOLATED_JOB_WORST_CASE_MS,
  ISOLATED_SETUP_TIMEOUT_MS,
  jobBudget,
  PER_LAYER_OVERHEAD_MS,
  RUNTIME_RUN_TIMEOUT_MS,
  RUNTIME_SETUP_TIMEOUT_MS,
  toMinutes,
} from "../../../evals/onboarding/support/budget.ts";
import { ISOLATED_LAYER_TIMEOUT_MS, MAX_ATTEMPTS, RATE_LIMIT_BACKOFF_MS } from "../../../evals/onboarding/support/run.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const ISOLATED_DIR = join(repoRoot, "evals", "onboarding", "isolated");
const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "onboarding-evals-nightly.yml");

describe("onboarding eval budget — cost-model consistency", () => {
  test("claimWorstCaseMs matches the retry model exactly (n attempts + n-1 backoffs)", () => {
    expect(claimWorstCaseMs(1000)).toBe(MAX_ATTEMPTS * 1000 + (MAX_ATTEMPTS - 1) * RATE_LIMIT_BACKOFF_MS);
  });

  test("RUNTIME_SETUP_TIMEOUT_MS is runtime's worst case plus one image build plus one claim's overhead", () => {
    expect(RUNTIME_SETUP_TIMEOUT_MS).toBe(claimWorstCaseMs(RUNTIME_RUN_TIMEOUT_MS) + IMAGE_BUILD_BUDGET_MS + PER_LAYER_OVERHEAD_MS);
  });

  test("ISOLATED_SETUP_TIMEOUT_MS is the shared isolated-claim worst case plus one image build plus one claim's overhead", () => {
    expect(ISOLATED_SETUP_TIMEOUT_MS).toBe(claimWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS) + IMAGE_BUILD_BUDGET_MS + PER_LAYER_OVERHEAD_MS);
  });

  test("ISOLATED_JOB_WORST_CASE_MS is one image build + 4 claims' overhead + runtime's worst case + 3x the isolated-claim worst case", () => {
    expect(ISOLATED_JOB_WORST_CASE_MS).toBe(
      IMAGE_BUILD_BUDGET_MS + 4 * PER_LAYER_OVERHEAD_MS + claimWorstCaseMs(RUNTIME_RUN_TIMEOUT_MS) + 3 * claimWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS),
    );
  });

  test("jobBudget derives strictly increasing minutes with the step margin below the job margin", () => {
    expect(CI_STEP_MARGIN_MS).toBeLessThan(CI_JOB_MARGIN_MS);
    const budget = jobBudget(1_000_000);
    expect(budget.stepTimeoutMinutes).toBeLessThan(budget.jobTimeoutMinutes);
  });

  test("THE INVARIANT: in-test timeout < CI step timeout < CI job timeout, for both the runtime and shared isolated bounds", () => {
    expect(RUNTIME_SETUP_TIMEOUT_MS).toBeLessThan(ISOLATED_JOB_BUDGET.stepTimeoutMinutes * 60_000);
    expect(ISOLATED_SETUP_TIMEOUT_MS).toBeLessThan(ISOLATED_JOB_BUDGET.stepTimeoutMinutes * 60_000);
    expect(ISOLATED_JOB_BUDGET.stepTimeoutMinutes).toBeLessThan(ISOLATED_JOB_BUDGET.jobTimeoutMinutes);
  });

  test("toMinutes rounds UP — a bound that rounded down could tie or lose to the timeout it must beat", () => {
    expect(toMinutes(60_001)).toBe(2);
    expect(toMinutes(60_000)).toBe(1);
  });
});

describe("onboarding-evals-nightly.yml's timeouts are DERIVED, never hand-typed", () => {
  const workflowText = readFileSync(WORKFLOW_PATH, "utf8");

  test("the job's timeout-minutes equals budget.ts's ISOLATED_JOB_BUDGET.jobTimeoutMinutes", () => {
    expect(workflowText).toMatch(new RegExp(`timeout-minutes:\\s*${ISOLATED_JOB_BUDGET.jobTimeoutMinutes}\\b`));
  });

  test("the eval step's timeout-minutes equals budget.ts's ISOLATED_JOB_BUDGET.stepTimeoutMinutes", () => {
    expect(workflowText).toMatch(new RegExp(`timeout-minutes:\\s*${ISOLATED_JOB_BUDGET.stepTimeoutMinutes}\\b`));
  });

  test("the job and step timeouts in the workflow are the ONLY two timeout-minutes values present (non-vacuous, exact set)", () => {
    const found = [...workflowText.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([ISOLATED_JOB_BUDGET.jobTimeoutMinutes, ISOLATED_JOB_BUDGET.stepTimeoutMinutes]));
  });
});

describe("no eval file contains a hand-written timeout literal", () => {
  // Every isolated claim file's `beforeAll`/`afterAll` third-argument timeout
  // must be a named budget constant, never a bare number — and the scan must
  // prove it actually read every claim file, so a rename can never silently
  // empty it.
  const files = readdirSync(ISOLATED_DIR).filter((f) => f.endsWith(".eval.test.ts"));

  test("the scan is non-vacuous: all four isolated claim files were found", () => {
    expect(files.sort()).toEqual(["keygen-signing.eval.test.ts", "runtime.eval.test.ts", "skill-install.eval.test.ts", "toolchain.eval.test.ts"]);
  });

  for (const file of files) {
    test(`${file}: every beforeAll/afterAll timeout argument is a named constant, not a bare number`, () => {
      const text = readFileSync(join(ISOLATED_DIR, file), "utf8");
      // Matches a bare multi-digit numeric literal used as a bun:test hook's
      // timeout argument, e.g. `}, 60000);` — the shape a hand-typed literal
      // takes. A named constant (`}, SETUP_TIMEOUT_MS);`) never matches.
      const bareLiteralTimeout = /\},\s*\d{3,}\s*\)/;
      expect(text).not.toMatch(bareLiteralTimeout);
      // And prove the file DOES declare hook timeouts at all, so a rewrite
      // that dropped every timeout argument can't pass this scan by omission.
      expect(text).toMatch(/\},\s*[A-Z][A-Z0-9_]*\s*\)/);
    });
  }
});

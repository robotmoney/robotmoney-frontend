// Pins .github/workflows/admission-eval-nightly.yml's CI taxonomy class,
// triggers, run step, and scorecard-upload step (issue #280) — and, separately,
// that no "layer4"/"layer 4" vocabulary survives in the admission eval's own
// test file or its scorecard support module, matching the claim-named
// convention #279 already established for the isolated onboarding claims.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMISSION_JOB_BUDGET } from "../../../evals/onboarding/support/budget.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "admission-eval-nightly.yml");
const ADMISSION_TEST_PATH = join(repoRoot, "evals", "onboarding", "admission.eval.test.ts");
const SCORECARD_PATH = join(repoRoot, "evals", "onboarding", "support", "scorecard.ts");

describe("admission-eval-nightly.yml — CI taxonomy, triggers, and steps", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");
  const parsed = Bun.YAML.parse(text) as {
    on?: unknown;
    true?: unknown;
    env?: Record<string, string>;
    jobs?: Record<string, { steps?: { name?: string; run?: string; env?: Record<string, string>; if?: string; uses?: string; with?: Record<string, unknown> }[] }>;
  };

  test("declares CI_CLASS: heavy", () => {
    expect(parsed.env?.CI_CLASS).toBe("heavy");
  });

  test("triggers are EXACTLY schedule and workflow_dispatch — no pull_request", () => {
    // YAML 1.1 folds the bare key `on` to boolean true; Bun.YAML keeps it a
    // string — accept either so this can never quietly observe zero triggers.
    const on = (parsed.on ?? parsed.true) as Record<string, unknown> | undefined;
    expect(on).toBeTruthy();
    expect(Object.keys(on!).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  test("the run step invokes bun run eval:onboarding:admission", () => {
    const runs = Object.values(parsed.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
    expect(runs.some((r) => /bun run eval:onboarding:admission\b/.test(r))).toBe(true);
  });

  test("the eval step is billed to the OPENCODE_API_KEY secret, not a bare literal", () => {
    const evalStep = Object.values(parsed.jobs ?? {})
      .flatMap((j) => j.steps ?? [])
      .find((s) => /bun run eval:onboarding:admission\b/.test(s.run ?? ""));
    expect(evalStep?.env?.OPENCODE_API_KEY).toBe("${{ secrets.OPENCODE_API_KEY }}");
  });

  test("the scorecard-upload step exists and runs on if: always()", () => {
    const uploadStep = Object.values(parsed.jobs ?? {})
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(uploadStep).toBeTruthy();
    expect(uploadStep?.if).toBe("always()");
    const uploadPaths = String((uploadStep?.with as { path?: string } | undefined)?.path ?? "");
    expect(uploadPaths).toContain(".agents/onboarding-eval-scorecard.json");
    expect(uploadPaths).toContain(".agents/onboarding-eval-run-logs/");
  });

  test("the reclaim step removes containers, networks, AND volumes, but never images", () => {
    expect(text).toMatch(/docker ps -a --filter "name=rm_ci_eval_" -q \| xargs -r docker rm -f/);
    expect(text).toMatch(/docker network ls --filter "name=rm_ci_eval_" -q \| xargs -r docker network rm/);
    expect(text).toMatch(/docker volume ls --filter "name=rm_ci_eval_" -q \| xargs -r docker volume rm/);
    expect(text).not.toMatch(/docker (image )?rmi|docker system prune/);
  });

  test("the reclaim step runs on if: always(), so a killed eval step still tears down", () => {
    const reclaim = Object.values(parsed.jobs ?? {})
      .flatMap((j) => j.steps ?? [])
      .find((s) => /docker ps -a --filter "name=rm_ci_eval_"/.test(s.run ?? "")) as { if?: string } | undefined;
    expect(reclaim?.if).toBe("always()");
  });

  test("the job's timeout-minutes equals budget.ts's ADMISSION_JOB_BUDGET.jobTimeoutMinutes", () => {
    expect(text).toMatch(new RegExp(`timeout-minutes:\\s*${ADMISSION_JOB_BUDGET.jobTimeoutMinutes}\\b`));
  });

  test("the eval step's timeout-minutes equals budget.ts's ADMISSION_JOB_BUDGET.stepTimeoutMinutes", () => {
    expect(text).toMatch(new RegExp(`timeout-minutes:\\s*${ADMISSION_JOB_BUDGET.stepTimeoutMinutes}\\b`));
  });

  test("the job and step timeouts in the workflow are the ONLY two timeout-minutes values present (non-vacuous, exact set)", () => {
    const found = [...text.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([ADMISSION_JOB_BUDGET.jobTimeoutMinutes, ADMISSION_JOB_BUDGET.stepTimeoutMinutes]));
  });
});

describe("admission eval vocabulary — no 'layer4'/'layer 4' residue (issue #280 rename)", () => {
  const LAYER4_IDENTIFIER = /layer4|layer 4/i;

  test("evals/onboarding/admission.eval.test.ts carries no layer4/'layer 4' identifier", () => {
    const contents = readFileSync(ADMISSION_TEST_PATH, "utf8");
    const match = contents.match(LAYER4_IDENTIFIER);
    expect(match, `admission.eval.test.ts still contains a layer4/'layer 4' identifier: ${JSON.stringify(match?.[0])}`).toBeNull();
  });

  test("evals/onboarding/support/scorecard.ts carries no layer4/'layer 4' identifier", () => {
    const contents = readFileSync(SCORECARD_PATH, "utf8");
    const match = contents.match(LAYER4_IDENTIFIER);
    expect(match, `scorecard.ts still contains a layer4/'layer 4' identifier: ${JSON.stringify(match?.[0])}`).toBeNull();
  });

  // ── negative control: the scan must be able to fire ─────────────────────
  test("the scan FIRES on planted layer4/'layer 4' identifiers — the assertions above aren't vacuous", () => {
    expect("evals/onboarding/admission/layer4-admission.eval.test.ts").toMatch(LAYER4_IDENTIFIER);
    expect("§11.3 E4 scoring for the layer 4 admission sweep").toMatch(LAYER4_IDENTIFIER);
  });
});

// CI-cost guard for the real-inference onboarding eval (issue #289).
//
// WHAT THIS PROTECTS
// The required `e2e` gate used to set ONBOARDING_REAL_EVAL="1" unconditionally,
// spending a real `opencode/big-pickle` admission (with retries) on every
// non-draft PR. The free keyless OpenCode tier cannot fund that at PR cadence
// — it was exhausted, and the required gate went red on every open PR for a
// reason unrelated to the code under test. The measurement was ALSO already
// running nightly in .github/workflows/committee-opencode-nightly.yml, wider,
// so the per-PR run was a duplicate.
//
// Turning a runtime assertion off in a REQUIRED check is exactly the kind of
// change that becomes an invisible false-green if nothing watches it. So this
// file asserts, as executed tests, all three halves of the arrangement:
//   1. e2e.yml conditions ONBOARDING_REAL_EVAL on the event type (no per-PR
//      model spend) — with a RED CONTROL fixture proving the assertion fails
//      if that condition is ever dropped back to an unconditional "1".
//   2. e2e.yml still SAYS SO LOUDLY on a PR run: the job-summary step names
//      the nightly workflow as the eval's home — also with a red control.
//   3. The compensating coverage still exists: the inference-off rails step
//      still runs on PRs (no `if:` guard), and the nightly still sets
//      ONBOARDING_REAL_EVAL=1 on schedule + workflow_dispatch.
//
// Cost class: fast unit. Pure file reads + string assertions — no Docker, no
// network, no model. Nothing here can skip; every test below runs on every
// invocation of `bun test scripts/tests` (the required integration.yml job).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const e2eYml = readFileSync(join(repoRoot, ".github/workflows/e2e.yml"), "utf8");
const nightlyYml = readFileSync(
  join(repoRoot, ".github/workflows/committee-opencode-nightly.yml"),
  "utf8",
);

// Split a workflow into per-step blocks (each starts at "- name:") so an
// assertion is scoped to the step it is about — a matching string elsewhere in
// the file cannot satisfy it.
function stepBlocks(workflow: string): string[] {
  return workflow.split(/\n\s*- name:/).slice(1);
}
function stepContaining(workflow: string, needle: string, label: string): string {
  const block = stepBlocks(workflow).find((b) => b.includes(needle));
  if (!block) throw new Error(`${label}: no step containing ${JSON.stringify(needle)}`);
  return block;
}

// ---------------------------------------------------------------------------
// The two checks, written as functions over workflow TEXT so the same code
// that grades the real file can be pointed at a deliberately-broken fixture.
// Each returns null when the property holds, or a reason string when it does
// not.
// ---------------------------------------------------------------------------

/**
 * Holds when ONBOARDING_REAL_EVAL's value in the demo step is derived from the
 * triggering event rather than hardcoded on.
 */
export function realEvalIsEventConditioned(workflow: string): string | null {
  const lines = workflow.split("\n").filter((l) => /^\s*ONBOARDING_REAL_EVAL:/.test(l));
  if (lines.length === 0) return "e2e.yml sets ONBOARDING_REAL_EVAL nowhere";
  if (lines.length > 1) {
    return `ONBOARDING_REAL_EVAL is set ${lines.length} times; each must be event-conditioned`;
  }
  const value = lines[0]!.replace(/^\s*ONBOARDING_REAL_EVAL:\s*/, "").trim();
  if (/^["']?1["']?$/.test(value)) {
    return `ONBOARDING_REAL_EVAL is unconditionally ${value} — every PR spends a real model call`;
  }
  if (!value.includes("github.event_name")) {
    return `ONBOARDING_REAL_EVAL value ${value} is not conditioned on github.event_name`;
  }
  if (!value.includes("pull_request")) {
    return `ONBOARDING_REAL_EVAL value ${value} does not exclude pull_request events`;
  }
  return null;
}

/**
 * Holds when the job summary written on a PR run says the eval was not run and
 * names where it does run. A silent removal is the failure mode this catches.
 */
export function prSummaryNamesTheNightly(workflow: string): string | null {
  let step: string;
  try {
    step = stepContaining(workflow, "GITHUB_STEP_SUMMARY", "e2e.yml");
  } catch {
    return "no step writes to GITHUB_STEP_SUMMARY";
  }
  if (!/IS_PULL_REQUEST/.test(step)) {
    return "the summary step does not branch on whether this is a pull_request run";
  }
  const prBranch = step.slice(step.indexOf("IS_PULL_REQUEST"));
  if (!prBranch.includes("committee-opencode-nightly.yml")) {
    return "the PR-run summary does not name committee-opencode-nightly.yml as the eval's home";
  }
  if (!prBranch.includes("workflow_dispatch")) {
    return "the PR-run summary does not name workflow_dispatch as the eval's other trigger";
  }
  if (!/NOT RUN/.test(prBranch)) {
    return "the PR-run summary does not state plainly that the eval was not run here";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The real file passes both checks.
// ---------------------------------------------------------------------------
describe("e2e.yml does not spend a real onboarding eval on pull_request runs", () => {
  test("ONBOARDING_REAL_EVAL is conditioned on the event type, not hardcoded", () => {
    expect(realEvalIsEventConditioned(e2eYml)).toBeNull();
  });

  test("the PR-path job summary states the eval did not run here and names the nightly", () => {
    expect(prSummaryNamesTheNightly(e2eYml)).toBeNull();
  });

  test("no comment still claims the eval always/unconditionally runs on PRs", () => {
    const offenders = e2eYml
      .split("\n")
      .filter((l) => /^\s*#/.test(l))
      .filter((l) => /onboarding eval ALWAYS runs|unconditionally "1"|UNCONDITIONALLY for every PR/i.test(l));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. RED CONTROLS. A deliberately-broken fixture MUST fail each check — proof
//    that the tests above are load-bearing and not vacuously green.
// ---------------------------------------------------------------------------
const UNCONDITIONAL_FIXTURE = [
  "jobs:",
  "  e2e:",
  "    steps:",
  "      - name: Configure onboarding real-inference eval",
  "        env:",
  "          IS_PULL_REQUEST: ${{ github.event_name == 'pull_request' }}",
  "        run: |",
  '          echo "eval running" >> "$GITHUB_STEP_SUMMARY"',
  "      - name: Full-stack demo (demo readiness gate)",
  "        env:",
  '          ONBOARDING_REAL_EVAL: "1"',
  "",
].join("\n");

describe("red control: the guards fail on a workflow that spends an eval per PR", () => {
  test("an unconditional ONBOARDING_REAL_EVAL: \"1\" is reported, not accepted", () => {
    const reason = realEvalIsEventConditioned(UNCONDITIONAL_FIXTURE);
    expect(reason).not.toBeNull();
    expect(reason).toContain("unconditionally");
  });

  test("a summary that never names the nightly is reported, not accepted", () => {
    const reason = prSummaryNamesTheNightly(UNCONDITIONAL_FIXTURE);
    expect(reason).not.toBeNull();
    expect(reason).toContain("committee-opencode-nightly.yml");
  });

  test("a workflow with no ONBOARDING_REAL_EVAL line at all is reported too", () => {
    expect(realEvalIsEventConditioned("jobs:\n  e2e:\n    steps: []\n")).toContain("nowhere");
  });
});

// ---------------------------------------------------------------------------
// 3. The compensating coverage the PR path still carries, and the nightly the
//    summary points at, both still exist.
// ---------------------------------------------------------------------------
describe("the coverage that replaces the per-PR eval is really there", () => {
  test("the inference-off rails step still runs on PRs, with no if: guard", () => {
    const step = stepContaining(
      e2eYml,
      "bun test scripts/tests/integration/onboarding-eval-infra.test.ts",
      "e2e.yml",
    );
    expect(step).toContain("Onboarding eval infra rails (inference-off, fail-fast)");
    // An `if:` on this step would let the last onboarding-surface assertion a
    // PR makes disappear as quietly as the eval did.
    expect(step).not.toMatch(/^\s*if:/m);
  });

  test("the nightly still sets ONBOARDING_REAL_EVAL=1 on schedule + workflow_dispatch", () => {
    expect(nightlyYml).toContain('ONBOARDING_REAL_EVAL: "1"');
    expect(nightlyYml).toContain('cron: "37 4 * * *"');
    expect(nightlyYml).toContain("workflow_dispatch:");
    // Heavy sweep-only class: a `pull_request` trigger here would re-import the
    // exact per-PR spend #289 removed.
    expect(nightlyYml).not.toMatch(/^\s{2}pull_request:/m);
  });
});

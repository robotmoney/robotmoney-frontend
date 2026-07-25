// The enforcement gate for D22 rule 1 / docs/architecture.md §11.3 E1:
// "No API key, provider secret, paid model, or opt-in override may be readable
// from, or passed to, any eval path."
//
// Deleting those paths once is not enough — the property has to STAY true, and
// the cheapest honest way to keep it true is to read each eval-path file off
// disk and assert none of the forbidden tokens appears in it. This runs under
// `bun run test` (→ `bun test scripts/tests`), which
// .github/workflows/integration.yml executes on every ready-for-review PR.
//
// DELIBERATELY STRICT, COMMENTS INCLUDED. The match is on raw file text with no
// comment stripping and no allowlist, so even a comment that merely NAMES a key
// token on one of these paths turns this red. That is the point: a comment
// describing an opt-in is how an opt-in comes back. If you hit this, REWORD the
// comment ("any provider secret") — do not add an exemption.
//
// NOT in the list, on purpose: scripts/lib/committee/** is the committee
// TAKE-authoring surface (COMMITTEE_REAL_INFERENCE, scripts/lib/committee/
// inference.ts's OPENCODE_MODEL read), a different surface from the onboarding
// eval, and it legitimately keeps its own model resolution. Adding it here
// would be scope creep, not enforcement.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Every file that is ON the onboarding-eval path: the harness, the container
// primitive and its model constant, the compose service the container is run
// from, and the two workflows that invoke it.
const EVAL_PATH_FILES = [
  "scripts/lib/onboarding-eval.ts",
  "scripts/agent/model-config.ts",
  "scripts/agent/member-agent.ts",
  "docker-compose.demo.yml",
  ".github/workflows/e2e.yml",
  ".github/workflows/committee-opencode-nightly.yml",
] as const;

// Provider keys, the retired model/sweep knobs, the retired trusted-context
// output, and — for the workflow files — any `secrets.` reference at all.
const FORBIDDEN =
  /(ANTHROPIC|OPENAI|MOONSHOT|RM_MODEL)_API_KEY|OPENCODE_MODEL|ONBOARDING_EVAL_MODEL|ONBOARDING_SWEEP|use_paid_model|secrets\./;

// scripts/lib/demo-main.ts is a large file that is only PARTLY on the eval
// path: the ONBOARDING_REAL_EVAL block. Guard that region specifically rather
// than the whole file, so an unrelated future demo feature can't be blocked by
// this test and, more importantly, so the region that matters is not diluted.
function onboardingRealEvalRegion(source: string): string {
  const start = source.indexOf('process.env.ONBOARDING_REAL_EVAL === "1"');
  expect(start).toBeGreaterThan(-1); // a rename must be RED, never a vacuous pass
  // Back up to the top of the block's leading comment; run to the end of the
  // block. Both bounds are generous on purpose — over-covering is safe here.
  const commentStart = Math.max(0, source.lastIndexOf("\n\n", start));
  const end = source.indexOf("\n    }", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(commentStart, end);
}

describe("keyless eval guard (D22 rule 1 / §11.3 E1)", () => {
  // A guard over zero files is a green that means nothing. If a path below is
  // renamed, this fails first and loudly.
  test("every guarded eval-path file exists (a rename can never silently empty this guard)", () => {
    expect(EVAL_PATH_FILES.length).toBeGreaterThan(0);
    for (const rel of EVAL_PATH_FILES) {
      expect(existsSync(join(repoRoot, rel))).toBe(true);
    }
    expect(existsSync(join(repoRoot, "scripts/lib/demo-main.ts"))).toBe(true);
  });

  for (const rel of EVAL_PATH_FILES) {
    test(`${rel} names no provider key, model override, or sweep knob`, () => {
      const source = readFileSync(join(repoRoot, rel), "utf8");
      const offending = source
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => FORBIDDEN.test(line))
        .map(([n, line]) => `${rel}:${n}: ${line.trim()}`);
      expect(offending).toEqual([]);
    });
  }

  test("scripts/lib/demo-main.ts's ONBOARDING_REAL_EVAL block names no provider key, model override, or sweep knob", () => {
    const region = onboardingRealEvalRegion(readFileSync(join(repoRoot, "scripts/lib/demo-main.ts"), "utf8"));
    const offending = region
      .split("\n")
      .filter((line) => FORBIDDEN.test(line))
      .map((line) => line.trim());
    expect(offending).toEqual([]);
  });

  // The committee take-authoring surface is out of scope and must STAY
  // functional — this asserts the guard above did not over-reach into it.
  test("the committee take-authoring surface is untouched (it legitimately resolves its own model)", () => {
    const inference = readFileSync(join(repoRoot, "scripts/lib/committee/inference.ts"), "utf8");
    expect(inference).toContain("process.env.OPENCODE_MODEL");
  });
});

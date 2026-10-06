// The e2e-*.yml workflows run scripts/smoke-ci-checks.ts one check per step, so
// WHICH checks a `--check` selects is the contract between the workflows and the
// script. Pure selection logic: no stack, no Docker.
//
// Runs in the required `unit.yml` job — `bun run test:unit`.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHECK_NAMES, selectChecks } from "../../lib/smoke-ci-check-select.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("selectChecks", () => {
  test("no --check runs every check in order, without the opt-in onboarding sweep", () => {
    expect(selectChecks([], {})).toEqual(["swarm-session", "starter-agent", "frontend", "browser", "live-smoke", "verify-live"]);
  });

  test("no --check adds the onboarding sweep only when ONBOARDING_REAL_EVAL=1", () => {
    expect(selectChecks([], { ONBOARDING_REAL_EVAL: "1" })).toEqual([...CHECK_NAMES]);
    expect(selectChecks([], { ONBOARDING_REAL_EVAL: "" })).not.toContain("onboarding");
  });

  test("a named check always runs, whatever ONBOARDING_REAL_EVAL says (a named no-op would be a false green)", () => {
    expect(selectChecks(["--check", "onboarding"], {})).toEqual(["onboarding"]);
    expect(selectChecks(["--check=onboarding"], { ONBOARDING_REAL_EVAL: "" })).toEqual(["onboarding"]);
  });

  test("--check takes a comma list and keeps the order given", () => {
    expect(selectChecks(["--check", "live-smoke,verify-live"], {})).toEqual(["live-smoke", "verify-live"]);
    expect(selectChecks(["--check", "verify-live,swarm-session"], {})).toEqual(["verify-live", "swarm-session"]);
  });

  test("it ignores flags that are not its own, such as --instance", () => {
    expect(selectChecks(["--instance", "rm_ci_x", "--check", "browser"], {})).toEqual(["browser"]);
  });

  test("an unknown name throws and never selects nothing", () => {
    expect(() => selectChecks(["--check", "swarm"], {})).toThrow(/unknown check: swarm/);
    expect(() => selectChecks(["--check", "browser,nope,also-nope"], {})).toThrow(/unknown checks: nope, also-nope/);
  });

  test("--check with no value throws", () => {
    expect(() => selectChecks(["--check"], {})).toThrow(/needs a value/);
    expect(() => selectChecks(["--check", "--instance", "x"], {})).toThrow(/needs a value/);
  });
});

describe("every check is run by some e2e-*.yml workflow", () => {
  const workflowDir = join(repoRoot, ".github", "workflows");
  const texts = readdirSync(workflowDir)
    .filter((f) => /^e2e-.+\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(workflowDir, f), "utf8"));

  test("the e2e-*.yml set is not empty", () => {
    expect(texts.length).toBeGreaterThan(1);
  });

  for (const name of CHECK_NAMES) {
    test(`\`--check ${name}\` appears in exactly one e2e-*.yml (a check in two domains runs twice, in none never runs)`, () => {
      const pattern = new RegExp(`smoke-ci-checks\\.ts --check ${name}(?![\\w-])`);
      const owners = texts.filter((t) => pattern.test(t));
      expect(owners.length).toBe(1);
    });
  }
});

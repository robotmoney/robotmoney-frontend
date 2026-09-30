// X12 — THE SIMULATION ONBOARDING DRIVER NEVER SEATS A NEWCOMER ON AN
// EXTERNAL DATABASE (docs/plans/merge-0-5-x-into-main.md).
//
// The driver (smoke-main.ts onboardingDriver) admits a scripted newcomer
// whenever a seat is free, and with 20 seats (#1033) one usually is. An
// `--db external` boot runs against a database this boot does not own — the
// deployment's — so a simulation boot pointed there would put test characters
// on the real roster. The gate is pure (smoke-mode.ts newcomerOnboardingApplies)
// and this file also pins that smoke-main.ts starts the driver through it and
// nowhere else. smoke-main.ts boots a stack on import, so that half is graded
// over source text, and the grader is run against a broken fixture so it
// cannot go vacuously green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newcomerOnboardingApplies, scenarioPlan } from "../../lib/smoke-mode.ts";

const smokeMain = readFileSync(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"), "utf8");

describe("newcomerOnboardingApplies", () => {
  const simulation = scenarioPlan(false);
  const archiveRestore = scenarioPlan(true);

  test("a simulation boot on an external database never runs the driver", () => {
    expect(simulation.runsNewcomerOnboarding).toBe(true);
    expect(newcomerOnboardingApplies(simulation, { kind: "external" })).toBe(false);
  });

  test("a simulation boot on a database it owns still does (unchanged `bun smoke`)", () => {
    expect(newcomerOnboardingApplies(simulation, { kind: "ephemeral" })).toBe(true);
  });

  test("a --smoke boot never does, whatever the database", () => {
    for (const kind of ["ephemeral", "external", "smoke-twin"] as const) {
      expect(newcomerOnboardingApplies(archiveRestore, { kind })).toBe(false);
    }
  });

  test("external wins even over a plan that asks for onboarding", () => {
    expect(newcomerOnboardingApplies({ runsNewcomerOnboarding: true }, { kind: "external" })).toBe(false);
  });
});

/** Every line of `src` that starts the onboarding driver. */
function driverStarts(src: string): string[] {
  return src.split("\n").filter((l) => /void\s+onboardingDriver\(\)/.test(l));
}

/** null when every start of the driver is gated by newcomerOnboardingApplies(…, dataPath). */
function everyStartIsGated(src: string): string | null {
  const starts = driverStarts(src);
  if (starts.length === 0) return "smoke-main.ts no longer starts onboardingDriver() — this pin's anchor is gone";
  const ungated = starts.filter((l) => !/newcomerOnboardingApplies\(\s*scenario\s*,\s*dataPath\s*\)/.test(l));
  return ungated.length ? `onboardingDriver() is started without the external-database gate: ${ungated.join(" | ")}` : null;
}

describe("smoke-main.ts starts the driver only through the gate", () => {
  test("the real file", () => {
    expect(everyStartIsGated(smokeMain)).toBeNull();
  });

  test("a fixture that starts it on the plan alone is caught", () => {
    const broken = smokeMain.replace(
      "if (newcomerOnboardingApplies(scenario, dataPath)) void onboardingDriver();",
      "if (scenario.runsNewcomerOnboarding) void onboardingDriver();",
    );
    expect(broken).not.toBe(smokeMain);
    expect(everyStartIsGated(broken)).toMatch(/without the external-database gate/);
  });
});

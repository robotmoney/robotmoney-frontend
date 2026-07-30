// Runtime-gates-the-run reporting (issue #279, docs/architecture.md §11.3):
// full outcome-table drive of evals/onboarding/support/gating.ts, with zero
// Docker and zero model inference — every input below is an
// already-classified outcome, and the function under test is pure.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardingOutcome } from "../../../scripts/agent/classify-outcome.ts";
import { buildRuntimeGatedReport, gatedClaimStatus, readRuntimeOutcome, writeRuntimeOutcome } from "../../../evals/onboarding/support/gating.ts";

const RED_RUNTIME_OUTCOMES: OnboardingOutcome[] = ["refused", "rate-limited", "timed-out", "navigation-failure", "harness-error"];
const SAMPLE_CLAIM_OUTCOMES: OnboardingOutcome[] = ["admitted", "refused", "rate-limited", "timed-out", "navigation-failure", "harness-error"];

describe("gatedClaimStatus", () => {
  for (const runtimeOutcome of RED_RUNTIME_OUTCOMES) {
    for (const claimOutcome of SAMPLE_CLAIM_OUTCOMES) {
      test(`runtime=${runtimeOutcome} -> claim reports not-measured regardless of its own outcome (${claimOutcome})`, () => {
        expect(gatedClaimStatus(runtimeOutcome, claimOutcome)).toBe("not-measured");
      });
    }
  }

  for (const claimOutcome of SAMPLE_CLAIM_OUTCOMES) {
    test(`runtime=admitted -> claim reports its OWN outcome unchanged (${claimOutcome})`, () => {
      expect(gatedClaimStatus("admitted", claimOutcome)).toBe(claimOutcome);
    });
  }

  test("never synthesises a 'failed' status — only the real outcome or not-measured", () => {
    for (const runtimeOutcome of [...RED_RUNTIME_OUTCOMES, "admitted" as const]) {
      for (const claimOutcome of SAMPLE_CLAIM_OUTCOMES) {
        const status = gatedClaimStatus(runtimeOutcome, claimOutcome);
        expect(status === claimOutcome || status === "not-measured").toBe(true);
      }
    }
  });
});

describe("buildRuntimeGatedReport", () => {
  test("a red runtime gates ALL THREE downstream claims to not-measured, independent of their own outcomes", () => {
    const report = buildRuntimeGatedReport({
      runtime: "refused",
      skillInstall: "admitted",
      toolchain: "navigation-failure",
      keygenSigning: "rate-limited",
    });
    expect(report).toEqual({
      runtime: "refused",
      skillInstall: "not-measured",
      toolchain: "not-measured",
      keygenSigning: "not-measured",
      gated: true,
    });
  });

  test("an admitted runtime lets each downstream claim report its own outcome, unaffected by the other two", () => {
    const report = buildRuntimeGatedReport({
      runtime: "admitted",
      skillInstall: "admitted",
      toolchain: "refused",
      keygenSigning: "navigation-failure",
    });
    expect(report).toEqual({
      runtime: "admitted",
      skillInstall: "admitted",
      toolchain: "refused",
      keygenSigning: "navigation-failure",
      gated: false,
    });
  });

  test("full outcome table: every red runtime outcome gates; only 'admitted' does not", () => {
    for (const runtimeOutcome of SAMPLE_CLAIM_OUTCOMES) {
      const report = buildRuntimeGatedReport({
        runtime: runtimeOutcome,
        skillInstall: "admitted",
        toolchain: "admitted",
        keygenSigning: "admitted",
      });
      if (runtimeOutcome === "admitted") {
        expect(report.gated).toBe(false);
        expect(report.skillInstall).toBe("admitted");
        expect(report.toolchain).toBe("admitted");
        expect(report.keygenSigning).toBe("admitted");
      } else {
        expect(report.gated).toBe(true);
        expect(report.skillInstall).toBe("not-measured");
        expect(report.toolchain).toBe("not-measured");
        expect(report.keygenSigning).toBe("not-measured");
      }
    }
  });
});

describe("writeRuntimeOutcome / readRuntimeOutcome (the cross-process handoff)", () => {
  test("round-trips an outcome through the suite's artifact directory", () => {
    const root = mkdtempSync(join(tmpdir(), "gating-handoff-"));
    try {
      writeRuntimeOutcome(root, "test-suite-run", "admitted");
      expect(readRuntimeOutcome(root, "test-suite-run")).toBe("admitted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws — never silently assumes an admission — when no outcome was ever written", () => {
    const root = mkdtempSync(join(tmpdir(), "gating-handoff-"));
    try {
      expect(() => readRuntimeOutcome(root, "never-ran")).toThrow(/no runtime outcome recorded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

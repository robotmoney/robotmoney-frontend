import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalSuiteArtifacts } from "../../../evals/support/artifacts.ts";
import {
  EvalIdRegistry,
  planEvalSamples,
  scoreEvalResults,
  validateEvalDefinition,
  type EvalDefinition,
} from "../../../evals/support/definition.ts";
import { createOnboardingArtifactWriter, createOnboardingTelemetry } from "../../lib/onboarding-telemetry.ts";
import { resolveAdmissionEvalModelConfig } from "../../onboarding-eval-local.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function definition(overrides: Partial<EvalDefinition<number>> = {}): EvalDefinition<number> {
  return {
    id: "onboarding.admission",
    title: "Admission",
    tags: ["onboarding"],
    tier: "real-inference",
    samples: 2,
    timeoutMs: 1_000,
    async run(context) { return context.sampleIndex; },
    score(results) { return { pass: results.every((value) => value >= 0), summary: "non-negative" }; },
    ...overrides,
  };
}

describe("generic eval definitions", () => {
  test("validates metadata and rejects zero work", () => {
    expect(() => validateEvalDefinition(definition())).not.toThrow();
    expect(() => validateEvalDefinition(definition({ id: "Not Stable" }))).toThrow(/Invalid eval id/);
    expect(() => validateEvalDefinition(definition({ samples: 0 }))).toThrow(/at least one sample/);
    expect(() => validateEvalDefinition(definition({ timeoutMs: 0 }))).toThrow(/positive timeout/);
    expect(() => validateEvalDefinition(definition({ tags: ["same", "same"] }))).toThrow(/unique stable/);
  });

  test("rejects duplicate ids", () => {
    const registry = new EvalIdRegistry();
    registry.add("onboarding.admission");
    expect(() => registry.add("onboarding.admission")).toThrow(/Duplicate eval id/);
  });

  test("plans stable samples and refuses a zero-sample plan", () => {
    expect(planEvalSamples("x", 3)).toEqual([
      { sampleIndex: 0, sampleId: "sample-01" },
      { sampleIndex: 1, sampleId: "sample-02" },
      { sampleIndex: 2, sampleId: "sample-03" },
    ]);
    expect(() => planEvalSamples("x", 0)).toThrow(/planned zero samples/);
  });

  test("fails zero, partial, and red scores", () => {
    expect(() => scoreEvalResults(definition(), [])).toThrow(/zero samples/);
    expect(() => scoreEvalResults(definition(), [1])).toThrow(/1\/2 samples/);
    expect(() => scoreEvalResults(definition({ score: () => ({ pass: false, summary: "not admitted" }) }), [1, 2]))
      .toThrow(/scored red: not admitted/);
    expect(scoreEvalResults(definition(), [1, 2]).pass).toBe(true);
  });

  test("requires keyed access before the admission executor can reach Docker", () => {
    expect(() => resolveAdmissionEvalModelConfig({})).toThrow(/No free-model probe or fallback/);
    expect(() => resolveAdmissionEvalModelConfig({ AGENT_MODEL: "free", OPENCODE_API_KEY: "unused-key" }))
      .toThrow(/no-credential models are not an eval fallback/);
  });
});

describe("suite artifacts", () => {
  test("writes suite summaries and correlated per-sample paths", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-suite-"));
    try {
      const suite = new EvalSuiteArtifacts(root, "suite-1");
      const def = definition();
      suite.begin(def, "registry-model");
      suite.finish({
        evalId: def.id,
        title: def.title,
        model: "registry-model",
        sampleCount: 2,
        executedSamples: 2,
        startedAt: "start",
        finishedAt: "finish",
        durationMs: 10,
        domainResults: [{ admitted: true }],
        score: { pass: true, summary: "green" },
        runnerStatus: "passed",
      });
      const manifest = JSON.parse(readFileSync(join(suite.directory, "manifest.json"), "utf8"));
      const summary = JSON.parse(readFileSync(join(suite.directory, "summary.json"), "utf8"));
      expect(manifest.suiteRunId).toBe("suite-1");
      expect(summary.evals[0].runnerStatus).toBe("passed");
      expect(statSync(join(suite.directory, "summary.json")).mode & 0o077).toBe(0);

      const skill = join(root, "SKILL.md");
      writeFileSync(skill, "skill");
      const writer = createOnboardingArtifactWriter({
        repoRoot: root,
        composeProject: "project",
        runId: "run-1",
        suiteRunId: "suite-1",
        evalId: def.id,
        sampleId: "sample-01",
        model: "registry-model",
        contact: "private@example.test",
        prompt: "prompt",
        skillPath: skill,
        timeoutMs: 10,
        pollIntervalMs: 1,
        autoApproveDelayMs: 1,
      });
      expect(writer.directory).toBe(join(root, ".agents", "evals", "suite-1", "cases", def.id, "sample-01"));
      const telemetry = createOnboardingTelemetry(
        { composeProject: "project", runId: "run-1", suiteRunId: "suite-1", evalId: def.id, sampleId: "sample-01", model: "registry-model" },
        writer.sink,
      );
      const event = telemetry.emit({ source: "harness", stream: "event", message: "started" });
      expect(event).toMatchObject({ suiteRunId: "suite-1", evalId: def.id, sampleId: "sample-01", model: "registry-model" });
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("package eval discovery", () => {
  test("keeps native eval discovery separate from unit tests", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.eval).toContain("cd evals && EVAL_SUITE_RUN_ID=");
    expect(pkg.scripts.eval).toContain("bun test");
    expect(pkg.scripts.test).toBe("bun test scripts/tests");
  });

  test("zero selected eval files and zero selected names are red", () => {
    for (const args of [["does-not-exist"], ["--test-name-pattern", "does-not-exist"]]) {
      const run = Bun.spawnSync(["bun", "run", "eval", "--", ...args], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODE_API_KEY: "" },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(run.exitCode).not.toBe(0);
    }
  });
});

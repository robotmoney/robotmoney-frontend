// Issue #819: unit.yml's header claims "no Docker, no network... bare
// checkout" for the WHOLE job. Before this issue that claim was false where it
// mattered most — the job's first test step ran `bun run test` (`bun test
// scripts/tests`), which recurses into scripts/tests/integration/, the
// Docker-backed class the header excludes. This file pins the fix
// mechanically rather than trusting a comment to keep holding as the workflow
// grows:
//
//   1. unit.yml can never again invoke a selector broader than
//      scripts/tests/unit (no bare `bun run test` / `bun test scripts/tests`
//      sweep, no direct invocation of scripts/tests/integration).
//   2. unit.yml actively makes the real `docker` binary unreachable BEFORE any
//      test step runs, so a future test that sneaks a Docker dependency into
//      scripts/tests/unit fails LOUDLY ("command not found") instead of
//      silently passing because a runner happened to have Docker installed —
//      the tier claim is enforced, not merely asserted.
//
// Checks only the parsed `run:` step bodies, never the raw file text — the
// header/step comments legitimately name these same strings in prose (as does
// this file), so a whole-file substring/regex check would false-positive on
// its own documentation.
//
// Cost class: fast unit. Pure file read + YAML parsing + regex checks — no
// Docker, no network, no model.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const unitYmlPath = join(import.meta.dir, "../../../.github/workflows/unit.yml");
const unitYmlRaw = readFileSync(unitYmlPath, "utf8");

interface Step {
  name?: string;
  run?: string;
}
interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>;
}

function steps(): Step[] {
  const wf = Bun.YAML.parse(unitYmlRaw) as Workflow;
  const out: Step[] = [];
  for (const job of Object.values(wf.jobs ?? {})) out.push(...(job.steps ?? []));
  return out;
}

function runCommands(): string[] {
  return steps()
    .map((s) => s.run)
    .filter((r): r is string => typeof r === "string");
}

describe("unit.yml enforces its own no-Docker, unit-only-selector claim (issue #819)", () => {
  test("no step invokes the bare run-everything test selector", () => {
    // Negative lookahead on the trailing `:` lets the legitimate
    // `bun run test:unit` selector through while catching the bare, tree-wide
    // `bun run test` / `bun test scripts/tests` forms.
    for (const run of runCommands()) {
      expect(run).not.toMatch(/bun run test(?!:)/);
      expect(run).not.toMatch(/bun test scripts\/tests(?!\/)/);
    }
  });

  test("no step invokes scripts/tests/integration as a test selector", () => {
    // Scoped to an actual invocation (bun test/run against that path, or the
    // test:integration npm script by name) — NOT a bare substring match,
    // because the log-verification step below legitimately greps its own
    // test:unit output for this same path string without ever running it.
    for (const run of runCommands()) {
      expect(run).not.toMatch(/bun\s+(run\s+)?test\S*\s+scripts\/tests\/integration/);
      expect(run).not.toContain("bun run test:integration");
    }
  });

  test("runs the unit-scoped selector, and only it", () => {
    expect(runCommands().some((r) => r.includes("bun run test:unit"))).toBe(true);
  });

  test("the integration-tier boundary guard checks the JUnit report's file attribute, not raw console prose", () => {
    // A test:unit console-log substring grep for "scripts/tests/integration"
    // false-positives on scripts/tests/unit/harness-selftest.test.ts, whose
    // test titles legitimately quote package.json's test:integration selector
    // string ("bun test scripts/tests/integration") to prove that mechanism —
    // prose that names the path is not evidence a file under that path ran.
    // The guard must instead check the JUnit report's `file="..."` attribute,
    // which is populated from real provenance and can't be spoofed by a
    // test's own name/description text.
    const guardStep = steps().find(
      (s) => typeof s.run === "string" && s.run.includes("tier boundary broke"),
    );
    expect(guardStep, "a step checks the integration-tier boundary").toBeDefined();
    expect(guardStep!.run).toContain('file="scripts/tests/integration');
    expect(guardStep!.run).toContain(".junit.xml");
    expect(guardStep!.run).not.toMatch(/grep -q 'scripts\/tests\/integration' \/tmp\/test-unit\.plain/);
  });

  test("the boundary guard's shell logic fails loudly on a missing or empty JUnit report, instead of failing open", () => {
    // A reviewer finding on this same issue: the guard's `if grep -q ... ; then`
    // sits in a bash CONDITION, so `set -e` never applies. A missing or empty
    // /tmp/test-unit.junit.xml (reporter flag/version drift, a crashed
    // reporter, a path typo, a disk issue) makes `grep` exit 2 ("no such
    // file") the same way it would for "ran fine, found no match" — so
    // without its own existence/non-empty check FIRST, the step exits 0
    // having verified nothing. This test does not merely assert the YAML
    // text contains certain strings (a prior version of this file's guard
    // tests did exactly that, and could not have caught this bug); it
    // extracts the guard step's actual `run:` script and executes it via a
    // real shell against controlled fixture files, asserting on exit codes.
    const guardStep = steps().find(
      (s) => typeof s.run === "string" && s.run.includes("tier boundary broke"),
    );
    expect(guardStep, "a step checks the integration-tier boundary").toBeDefined();

    const tmpDir = mkdtempSync(join(tmpdir(), "unit-yml-guard-"));
    const junitPath = join(tmpDir, "test-unit.junit.xml");
    try {
      // Retarget the guard's hardcoded /tmp path to an isolated temp file so
      // this test exercises the REAL script logic without touching, or
      // depending on the absence/presence of, the actual CI-produced
      // /tmp/test-unit.junit.xml.
      const script = guardStep!.run!.replaceAll("/tmp/test-unit.junit.xml", junitPath);

      // Missing file.
      let result = Bun.spawnSync(["bash", "-c", script]);
      expect(
        result.exitCode,
        "a missing JUnit report must fail the guard loudly, not silently pass",
      ).toBe(1);
      expect(result.stderr.toString()).toContain("cannot verify the tier boundary");

      // Empty file — `-s` is false for a 0-byte file just as it is for a
      // missing one, and is the same fail-open hazard.
      writeFileSync(junitPath, "");
      result = Bun.spawnSync(["bash", "-c", script]);
      expect(
        result.exitCode,
        "an empty JUnit report must fail the guard loudly, not silently pass",
      ).toBe(1);
      expect(result.stderr.toString()).toContain("cannot verify the tier boundary");

      // Non-empty, no integration-tier file recorded: the guard passes. Cites
      // this file's own real path (it exists) rather than a made-up one, so
      // the repo's dangling-citation gate (test-path-citations.test.ts) never
      // flags this fixture string as a stale reference.
      writeFileSync(
        junitPath,
        '<testsuites><testsuite><testcase file="scripts/tests/unit/unit-workflow-tier-boundary.test.ts"/></testsuite></testsuites>',
      );
      result = Bun.spawnSync(["bash", "-c", script]);
      expect(result.exitCode, "a clean JUnit report must pass the guard").toBe(0);

      // Non-empty, WITH an integration-tier file recorded: the guard still
      // catches the real regression it exists to catch. Cites a real
      // scripts/tests/integration file for the same dangling-citation reason.
      writeFileSync(
        junitPath,
        '<testsuites><testsuite><testcase file="scripts/tests/integration/admin-live-guard.test.ts"/></testsuite></testsuites>',
      );
      result = Bun.spawnSync(["bash", "-c", script]);
      expect(
        result.exitCode,
        "an integration-tier file present in the report must still fail the guard",
      ).toBe(1);
      expect(result.stderr.toString()).toContain("tier boundary broke");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("the unit cost class step produces the JUnit report the boundary guard reads", () => {
    const unitStep = steps().find(
      (s) => typeof s.run === "string" && s.run.includes("bun run test:unit"),
    );
    expect(unitStep, "a step runs bun run test:unit").toBeDefined();
    expect(unitStep!.run).toContain("--reporter=junit");
    expect(unitStep!.run).toContain("--reporter-outfile=/tmp/test-unit.junit.xml");
  });

  test("makes the real docker binary unreachable, before the unit-scoped selector runs", () => {
    const all = steps();
    const dockerIdx = all.findIndex((s) => typeof s.run === "string" && s.run.includes("command -v docker"));
    const testUnitIdx = all.findIndex((s) => typeof s.run === "string" && s.run.includes("bun run test:unit"));
    expect(dockerIdx, "a step neutralizes the docker binary on PATH").toBeGreaterThan(-1);
    expect(testUnitIdx, "a step runs bun run test:unit").toBeGreaterThan(-1);
    expect(
      dockerIdx,
      "docker is made unreachable BEFORE test:unit runs, not after",
    ).toBeLessThan(testUnitIdx);
  });
});

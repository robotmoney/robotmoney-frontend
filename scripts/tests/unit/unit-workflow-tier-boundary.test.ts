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
import { readFileSync } from "node:fs";
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

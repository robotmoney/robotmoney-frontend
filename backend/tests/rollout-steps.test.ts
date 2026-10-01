// Filesystem-only invariants for the retired v0.2.2 rollout implementation.
// Historical runbooks have been removed from the docs tree; these checks keep
// validating the scripts and migration manifest without retaining old operator
// procedures as test fixtures.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { STEPS, THIS_RELEASE_MIGRATIONS } from "../scripts/upgrades/0.2.1-to-0.2.2/steps.ts";

const repoRoot = join(import.meta.dir, "..", "..");

describe("rollout manifest structure", () => {
  test("step ids are unique", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  test("requires references resolve to real steps, and point backwards", () => {
    const index = new Map(STEPS.map((s, i) => [s.id, i]));
    for (const [i, step] of STEPS.entries()) {
      for (const req of step.requires) {
        expect({ step: step.id, req, known: index.has(req) }).toEqual({ step: step.id, req, known: true });
        // A prerequisite that comes LATER in manifest order would make the
        // probe's "first not-ok step is next" rule pick an unreachable step.
        expect({ step: step.id, req, before: index.get(req)! < i }).toEqual({ step: step.id, req, before: true });
      }
    }
  });

  test("phases are contiguous — manifest order is display order", () => {
    const seen: string[] = [];
    for (const s of STEPS) {
      if (seen[seen.length - 1] !== s.phase) seen.push(s.phase);
    }
    expect(seen.length).toBe(new Set(seen).size);
  });

  test("a step that runs a script declares what invalidates it", () => {
    // Only steps that actually EXECUTE release code. `where.ts --record ...`
    // appears in several verify strings without being the thing being tested,
    // and a psql-only capture (§5.0, §5.4) is legitimately not code-bound.
    const RUNS_CODE = /(preflight|postflight|restore-check|stage-rehearsal)\.ts|bun smoke/;
    for (const step of STEPS) {
      if (!RUNS_CODE.test(step.verify) || step.derived) continue;
      expect({ step: step.id, deps: step.dependsOn.length > 0 }).toEqual({ step: step.id, deps: true });
    }
  });
});

describe("THIS_RELEASE_MIGRATIONS is the single source", () => {
  test("every named migration exists on disk", () => {
    for (const m of THIS_RELEASE_MIGRATIONS) {
      expect({ m, exists: existsSync(join(repoRoot, "backend", "migrations", m)) }).toEqual({ m, exists: true });
    }
  });

  test("release constants live in release.ts, not in the manifest", () => {
    const steps = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.1-to-0.2.2", "steps.ts"), "utf8");
    // steps.ts may RE-EXPORT them; declaring them would put display metadata
    // back inside every gate's depends-on, which is what the split undid.
    expect(/const THIS_RELEASE_MIGRATIONS\s*=/.test(steps)).toBe(false);
    // And no gate may depend on the manifest file itself.
    for (const step of STEPS) {
      expect({ step: step.id, dependsOnManifest: step.dependsOn.some((g) => g.endsWith("/steps.ts")) }).toEqual({
        step: step.id,
        dependsOnManifest: false,
      });
    }
  });

  test("no upgrade script declares its own copy", () => {
    for (const f of ["preflight.ts", "postflight.ts"]) {
      const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.1-to-0.2.2", f), "utf8");
      // Importing it is fine; re-declaring it is the drift that broke §8's
      // check 2 for three weeks.
      expect({ f, redeclares: /const THIS_RELEASE_MIGRATIONS\s*=/.test(src) }).toEqual({ f, redeclares: false });
    }
  });

});

describe("receipt step ids are wired to the scripts that emit them", () => {
  const wiring: [string, string][] = [
    ["preflight.ts", "P4.preflight-live"],
    ["restore-check.ts", "P3.gate-c"],
    ["stage-rehearsal.ts", "P5.rehearsal-boot"],
    ["postflight.ts", "P5.postflight-smoke-twin"],
    ["postflight.ts", "P8.postflight-prod"],
  ];
  test.each(wiring)("%s emits %s", (file, stepId) => {
    const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.1-to-0.2.2", file), "utf8");
    expect(src.includes(stepId)).toBe(true);
    expect(STEPS.some((s) => s.id === stepId)).toBe(true);
  });
});

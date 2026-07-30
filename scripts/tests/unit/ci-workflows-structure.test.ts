import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflows = join(root, ".github/workflows");
const read = (name: string) => readFileSync(join(workflows, name), "utf8");
const allWorkflows = () =>
  readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));

describe("split CI workflows retain taxonomy declarations and guard wiring", () => {
  test("every workflow declares CI_CLASS at workflow env", () => {
    for (const file of allWorkflows()) {
      expect(read(file), `${file} declares CI_CLASS`).toMatch(/CI_CLASS:/);
    }
  });

  test("ci-gate.yml uses dorny/paths-filter, not on.paths", () => {
    const gate = read("ci-gate.yml");
    expect(gate).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    expect(gate).toContain("dorny/paths-filter@");
  });

  test("repo-guards.yml has no path filter and contains all guard commands", () => {
    const guards = read("repo-guards.yml");
    // No on.paths or on.paths-ignore gating — every PR must pass every guard.
    expect(guards).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    // Guard commands that must be present after the split.
    for (const command of [
      "check-no-test-imports-in-runtime.sh",
      "check-docs-analytics.sh",
      "check-model-selection.sh",
    ]) {
      expect(guards, `repo-guards.yml contains ${command}`).toContain(command);
    }
  });

  test("unit.yml runs typecheck + test and has NO draft guard", () => {
    const unit = read("unit.yml");
    expect(unit).toContain("bun run typecheck && bun run test");
    // Unit is feature-correctness: runs on every PR including drafts.
    expect(unit).not.toMatch(/github\.event\.pull_request\.draft/);
  });

  // Step-preservation map: every step command from the pre-split integration.yml
  // monolith must appear in exactly one post-split workflow. This prevents
  // silent coverage losses from a step falling through the cracks during the
  // split — if a command is missing from all post-split files, or accidentally
  // duplicated in two, this test goes red.
  //
  // The fixture list below is the complete set of `run:` commands from the
  // monolith on `main` before the split (issue #275). Each entry maps to the
  // post-split workflow that owns it. A new guard or step added AFTER the split
  // should be added to this map in the same PR.
  test("every pre-split integration.yml step command appears in exactly one post-split workflow", () => {
    // Each entry is a UNIQUE command string from the pre-split monolith mapped
    // to the post-split workflow that now owns it. Matched via includes() —
    // simple and correct for all commands that don't have substring collisions.
    const stepMap: Record<string, string> = {
      // unit.yml
      "bun run typecheck && bun run test": "unit.yml",
      "bun run test:unit": "unit.yml",
      // repo-guards.yml
      "bash scripts/checks/check-no-test-imports-in-runtime.sh": "repo-guards.yml",
      "bash scripts/check-docs-analytics.sh": "repo-guards.yml",
      "bash scripts/checks/check-model-selection.sh": "repo-guards.yml",
      // backend.yml
      "bash backend/scripts/check-no-supabase.sh": "backend.yml",
      "bash backend/scripts/check-no-ai-overview.sh": "backend.yml",
      // contract.yml
      "bun run check-contract": "contract.yml",
      // integration.yml
      "bun run test:integration": "integration.yml",
    };

    const postSplitFiles = allWorkflows();
    for (const [command, expectedFile] of Object.entries(stepMap)) {
      const filesContaining = postSplitFiles.filter((f) =>
        read(f).includes(command),
      );
      expect(
        filesContaining,
        `"${command}" should appear in [${expectedFile}]`,
      ).toContain(expectedFile);
      const unexpected = filesContaining.filter(
        (f) =>
          f !== expectedFile &&
          !f.includes("nightly") &&
          !f.includes("demo"),
      );
      expect(
        unexpected,
        `"${command}" should not also appear in ${unexpected.join(", ")}`,
      ).toEqual([]);
    }

    // Backend typecheck runs under working-directory: backend (distinct from
    // unit.yml's root-level typecheck && test compound). Verified separately
    // because "bun run typecheck" is a substring of unit.yml's compound command.
    const backendYml = read("backend.yml");
    expect(backendYml).toMatch(/working-directory:\s*backend[\s\S]*?run:\s*bun run typecheck/);
  });
});


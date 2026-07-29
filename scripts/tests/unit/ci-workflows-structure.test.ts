import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflows = join(root, ".github/workflows");
const read = (name: string) => readFileSync(join(workflows, name), "utf8");

test("split CI workflows retain taxonomy declarations and guard wiring", () => {
  for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
    expect(read(file), `${file} declares CI_CLASS`).toMatch(/CI_CLASS:/);
  }
  const gate = read("ci-gate.yml");
  expect(gate).not.toMatch(/^\s+paths(?:-ignore)?:/m);
  expect(gate).toContain("dorny/paths-filter@");
  const guards = read("repo-guards.yml");
  for (const command of ["check-no-test-imports-in-runtime.sh", "check-docs-analytics.sh", "check-model-selection.sh"]) expect(guards).toContain(command);
  const unit = read("unit.yml");
  expect(unit).toContain("bun run typecheck && bun run test");
  expect(unit).not.toMatch(/github\.event\.pull_request\.draft/);
});

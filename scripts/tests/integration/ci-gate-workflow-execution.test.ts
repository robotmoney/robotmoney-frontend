import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const script = join(root, "scripts/checks/ci-gate.ts");
function run(env: Record<string, string>) {
  return Bun.spawnSync(["bun", script], { cwd: root, env: { ...process.env, ...env } });
}
const base = { CHANGED_BACKEND: "false", CHANGED_CONTRACT: "false", CHANGED_FRONTEND: "false", CHANGED_SCRIPTS: "true", CHANGED_DOCS_ONLY: "false", IS_DRAFT: "false", RESULT_UNIT: "success", RESULT_REPO_GUARDS: "success", RESULT_BACKEND: "missing", RESULT_INTEGRATION: "success", RESULT_CONTRACT: "missing", RESULT_FRONTEND: "missing", RESULT_E2E: "success" };

test("ci-gate workflow command executes pass and red controls", () => {
  expect(run(base).exitCode).toBe(0);
  expect(run({ ...base, RESULT_INTEGRATION: "failure" }).exitCode).not.toBe(0);
  expect(run({ ...base, RESULT_INTEGRATION: "skipped" }).exitCode).not.toBe(0);
  expect(run({ ...base, RESULT_UNIT: "skipped", RESULT_INTEGRATION: "skipped", RESULT_E2E: "skipped" }).exitCode).not.toBe(0);
});

// Issue #275 addendum: the research_pipeline domain, exercised through the
// real subprocess (not just the in-process fixture matrix in ci-gate.test.ts)
// so the workflow-to-script seam is proven for this domain too.
test("ci-gate workflow command executes research_pipeline pass and invariant-4 red control", () => {
  const researchPass = { ...base, CHANGED_RESEARCH_PIPELINE: "true", RESULT_RESEARCH_PIPELINE: "success" };
  expect(run(researchPass).exitCode).toBe(0);
  // Negative control: research_pipeline paths changed, but the workflow
  // reported "skipped" — invariant 4 must reject this, never pass it quietly.
  expect(run({ ...researchPass, RESULT_RESEARCH_PIPELINE: "skipped" }).exitCode).not.toBe(0);
});

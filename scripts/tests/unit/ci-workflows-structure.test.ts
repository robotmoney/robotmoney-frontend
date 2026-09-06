import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflows = join(root, ".github/workflows");
const read = (name: string) => readFileSync(join(workflows, name), "utf8");
const allWorkflows = () =>
  readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));

// Minimal shape shared with evals-guard.test.ts's own Workflow interface —
// duplicated rather than imported because these are independent unit files
// and neither should depend on the other's internals.
interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
}
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
}
interface Workflow {
  name?: string;
  on?: unknown;
  true?: unknown;
  jobs?: Record<string, WorkflowJob>;
}
const parse = (name: string): Workflow => Bun.YAML.parse(read(name)) as Workflow;

const PATHS_FILTER_SHA = "de90cc6fb38fc0963ad72b210f1f284cd68cea36";

/**
 * Workflows expected to carry their OWN dorny/paths-filter change-detection
 * job (issue #275 addendum item 2/3/4: real per-workflow path-skip wiring).
 * Each of these is now directly required in branch protection (issue #275
 * addendum: the ci-gate.yml/ci-gate.ts fan-in mechanism was removed —
 * production incident on PR #316, tracked for a structurally sounder
 * replacement in issue #348). A job-level `if:` skip (never workflow-level
 * `on.paths`) reports a real `skipped` conclusion to the Checks API, so
 * requiring these directly carries no deadlock risk. repo-guards.yml and
 * unit.yml are DELIBERATELY excluded from this list — both are documented (in
 * their own headers) to run unconditionally on every PR regardless of path,
 * and ci-workflows-structure.test.ts already pins repo-guards.yml's "no path
 * filter" invariant above.
 */
const PATH_GATED_WORKFLOWS = [
  "backend.yml",
  "contract.yml",
  "integration.yml",
  "frontend.yml",
  "research-pipeline.yml",
  "onboarding-eval-rails.yml",
];

describe("split CI workflows retain taxonomy declarations and guard wiring", () => {
  test("every workflow declares CI_CLASS at workflow env", () => {
    for (const file of allWorkflows()) {
      expect(read(file), `${file} declares CI_CLASS`).toMatch(/CI_CLASS:/);
    }
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

  test("unit.yml runs typecheck + the scoped test:unit selector only, and has NO draft guard", () => {
    const unit = read("unit.yml");
    expect(unit).toContain("bun run typecheck");
    expect(unit).toContain("bun run test:unit");
    // Issue #819: the bare run-everything alias (`bun run test`, which used to
    // recurse into the Docker-backed scripts/tests/integration/) must never
    // run here — verified against parsed step bodies, not raw file text, in
    // scripts/tests/unit/unit-workflow-tier-boundary.test.ts (a whole-file
    // check would false-positive on this very file's own prose about it).
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
      // unit.yml. Issue #819 split the pre-split monolith's compound
      // "typecheck && test" step into a bare typecheck (the `&& bun run test`
      // half recursed into the Docker-backed scripts/tests/integration/,
      // which is exactly the bug that issue fixed) plus the already-scoped
      // test:unit selector.
      "bun run typecheck": "unit.yml",
      "bun run test:unit": "unit.yml",
      // repo-guards.yml
      "bash scripts/checks/check-no-test-imports-in-runtime.sh": "repo-guards.yml",
      "bash scripts/check-docs-analytics.sh": "repo-guards.yml",
      "bash scripts/checks/check-model-selection.sh": "repo-guards.yml",
      // contract.yml
      "bun run check-contract": "contract.yml",
      // Added after the split (issue #484): contract/tests/live's reachability
      // guard for SWARM_ONBOARDING_SKILL_URL. It documented itself as running
      // in a `nightly-fetchers.yml` that never existed, so it had executed in
      // no CI job at any point in its life while the URL it guards 404'd in
      // production. Pinned here so "the live selector is invoked by a real
      // workflow" is an assertion, not a comment.
      "bun run test:live": "contract.yml",
      // integration.yml
      "bun run test:integration": "integration.yml",
    };

    // backend.yml independently runs the literal command "bun run typecheck"
    // under working-directory: backend — a known, deliberate collision with
    // unit.yml's root-level typecheck step, verified separately below. Every
    // other command in the map is expected to be unique to its owning file.
    const KNOWN_COMMAND_COLLISIONS: Record<string, string[]> = {
      "bun run typecheck": ["backend.yml"],
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
          !f.includes("smoke") &&
          !(KNOWN_COMMAND_COLLISIONS[command] ?? []).includes(f),
      );
      expect(
        unexpected,
        `"${command}" should not also appear in ${unexpected.join(", ")}`,
      ).toEqual([]);
    }

    // Backend typecheck runs under working-directory: backend — asserted here
    // by structure (not just substring presence, which KNOWN_COMMAND_COLLISIONS
    // above already tolerates) so the two typecheck invocations stay
    // distinguishable as "same command, different cwd" rather than drifting
    // into an accidental single shared step.
    const backendYml = read("backend.yml");
    expect(backendYml).toMatch(/working-directory:\s*backend[\s\S]*?run:\s*bun run typecheck/);
  });

  test("test file headers claiming a workflow execution must cite a command that actually exists in that workflow (issue #517)", () => {
    // A grep-level guard preventing test headers from drifting when workflows move.
    const walkTests = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          files.push(...walkTests(join(dir, entry.name)));
        } else if (entry.name.endsWith(".test.ts")) {
          files.push(join(dir, entry.name));
        }
      }
      return files;
    };

    for (const file of walkTests(join(root, "scripts/tests"))) {
      const content = readFileSync(file, "utf8");
      // Find e.g. "Runs in the required integration.yml root job via `bun run test:integration`"
      // or "Runs in the required `unit.yml` job — `bun run test:unit`"
      for (const match of content.matchAll(/Runs in the required `?([a-z0-9.-]+\.yml)`?[^`]*`([^`]+)`/g)) {
        const workflowName = match[1] as string;
        let command = match[2] as string;

        // Normalizations for files that haven't updated to cite the npm script
        if (command === "bun test scripts/tests") command = "bun run test";
        if (command === "bun test scripts/tests/unit") command = "bun run test:unit";
        if (command === "bun test scripts/tests/integration") command = "bun run test:integration";

        const wfContent = read(workflowName);
        expect(
          wfContent,
          `${file} claims to run in ${workflowName} via \`${command}\`, but ${workflowName} does not execute that`,
        ).toContain(command);
      }
    }
  });

  // ── issue #275 addendum item 2/3/4: real per-workflow path-skip wiring ───
  describe("path-gated workflows carry real dorny/paths-filter wiring, never on.paths", () => {
    for (const file of PATH_GATED_WORKFLOWS) {
      test(`${file} has its own SHA-pinned dorny/paths-filter change-detection job`, () => {
        const text = read(file);
        expect(text, `${file} uses dorny/paths-filter, not on.paths/paths-ignore for gating`).not.toMatch(/^\s+paths(?:-ignore)?:/m);
        expect(text, `${file} pins dorny/paths-filter to the repo-standard SHA`).toContain(`dorny/paths-filter@${PATHS_FILTER_SHA}`);

        const wf = parse(file);
        const jobs = Object.entries(wf.jobs ?? {});
        expect(jobs.length, `${file} declares at least a changes + main job`).toBeGreaterThanOrEqual(2);
        const mainJobs = jobs.filter(([name]) => name !== "changes");
        expect(mainJobs.length, `${file} declares exactly one non-"changes" job`).toBe(1);
        const [, mainJob] = mainJobs[0]!;
        expect(mainJob.if, `${file}'s main job has an if: guard`).toBeTruthy();
      });
    }

    // Issue #275 addendum item 5: a push to `main` must NEVER be path-filtered
    // — every path-conditional `if:` this feature adds must be scoped so the
    // path check only applies on a `pull_request` event. Asserted here by
    // requiring every PATH_GATED_WORKFLOWS main-job `if:` to short-circuit
    // true on a non-pull_request event BEFORE it ever consults
    // needs.changes.outputs — i.e. it must read
    // `github.event_name != 'pull_request' || (...)`.
    for (const file of PATH_GATED_WORKFLOWS) {
      test(`${file}'s path-conditional if: is guarded so push-to-main always runs in full`, () => {
        const wf = parse(file);
        const jobs = Object.entries(wf.jobs ?? {});
        const [, mainJob] = jobs.find(([name]) => name !== "changes")!;
        const condition = mainJob.if ?? "";
        expect(condition, `${file}'s main job if: references needs.changes.outputs`).toMatch(/needs\.changes\.outputs\./);
        expect(
          condition,
          `${file}'s main job if: is guarded by github.event_name != 'pull_request' ahead of the path check, so push events short-circuit past it`,
        ).toMatch(/github\.event_name\s*!=\s*'pull_request'/);
      });
    }

    test("repo-guards.yml and unit.yml carry no dorny/paths-filter (unconditional by design)", () => {
      for (const file of ["repo-guards.yml", "unit.yml"]) {
        expect(read(file), `${file} does not use dorny/paths-filter`).not.toContain("dorny/paths-filter@");
      }
    });
  });

  // ── issue #275 addendum item 3: research_pipeline test-file wiring ───────
  test("backend.yml excludes exactly the two research-pipeline-owned test files, which research-pipeline.yml runs exclusively", () => {
    const backendYml = read("backend.yml");
    const researchYml = read("research-pipeline.yml");
    const researchFiles = [
      "tests/geckoterminal-resilience.test.ts",
      "tests/token-prices-resilience.test.ts",
    ];
    for (const file of researchFiles) {
      expect(backendYml, `backend.yml's bun test excludes ${file}`).toContain(file);
      expect(backendYml, `backend.yml excludes ${file} via --path-ignore-patterns`).toMatch(
        new RegExp(`--path-ignore-patterns=['"]${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`),
      );
      expect(researchYml, `research-pipeline.yml runs ${file}`).toContain(file);
    }
  });
});


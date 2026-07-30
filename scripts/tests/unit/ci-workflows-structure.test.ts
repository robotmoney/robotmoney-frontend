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
 * job (issue #275 addendum item 2/3/4: real per-workflow path-skip wiring,
 * since a standalone workflow file cannot read ci-gate.yml's `changes` job
 * outputs across files). repo-guards.yml and unit.yml are DELIBERATELY
 * excluded — both are documented (in their own headers) to run unconditionally
 * on every PR regardless of path, and ci-workflows-structure.test.ts already
 * pins repo-guards.yml's "no path filter" invariant above.
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

  // ── issue #275 addendum: every Domain ci-gate.ts requires must have a real
  // workflow backing it ────────────────────────────────────────────────────
  //
  // This is the mechanical regression guard for the critical bug the addendum
  // found: ci-gate.ts's Domain type named `"frontend"` as a required assurance
  // whenever frontend/** changed, but no workflow anywhere produced a
  // GitHub-Actions run literally named `frontend` — ci-gate.ts's
  // outcomesFromGitHub() can only ever see `missing` for it, so the required
  // `ci-gate` check would fail FOREVER on any PR touching frontend/**. This
  // test parses the Domain union directly out of ci-gate.ts's source (never
  // hand-copies it — a hand-copied list would drift silently the next time a
  // domain is added) and asserts a workflow whose `name:` equals that literal
  // exists, so this exact class of bug cannot land again undetected.
  test("every Domain in ci-gate.ts's Domain union is backed by a workflow whose name: matches", () => {
    const gateSource = readFileSync(join(root, "scripts/checks/ci-gate.ts"), "utf8");
    const domainBlock = gateSource.match(/export type Domain =\s*([\s\S]*?);/);
    expect(domainBlock, "ci-gate.ts declares `export type Domain = ...;`").not.toBeNull();
    const domains = [...domainBlock![1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(domains.length, "at least one domain literal was extracted").toBeGreaterThan(0);

    const workflowNames = allWorkflows().map((file) => parse(file).name).filter((n): n is string => Boolean(n));
    for (const domain of domains) {
      expect(workflowNames, `a workflow named "${domain}" backs Domain "${domain}"`).toContain(domain);
    }
  });

  // ── issue #275 addendum item 2/3/4: real per-workflow path-skip wiring ───
  describe("path-gated workflows carry real dorny/paths-filter wiring, never on.paths", () => {
    for (const file of PATH_GATED_WORKFLOWS) {
      test(`${file} has its own SHA-pinned dorny/paths-filter change-detection job`, () => {
        const text = read(file);
        expect(text, `${file} uses dorny/paths-filter, not on.paths/paths-ignore for gating`).not.toMatch(/^\s+paths(?:-ignore)?:/m);
        expect(text, `${file} pins dorny/paths-filter to the same SHA as ci-gate.yml`).toContain(`dorny/paths-filter@${PATHS_FILTER_SHA}`);

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

  // ── production incident, PR #316 (2026-07-30): ci-gate.yml's gate step must
  // never pass bare `github.sha` as GITHUB_SHA ────────────────────────────
  //
  // Root cause of the incident: on a `pull_request` event, `github.sha`
  // resolves to GitHub's synthetic PR merge commit, NOT the branch's actual
  // head commit every sibling workflow's run is recorded under. `gh run list
  // --commit <sha>` filters by the real head_sha, so passing the merge-commit
  // sha made ci-gate.ts's outcomesFromGitHub() match ZERO runs, forever — the
  // gate burned its entire polling budget and failed even though every
  // sibling workflow had already succeeded. This is a correctness bug, not a
  // timing one: no polling budget fixes querying the wrong commit. This test
  // pins the fix so it can't silently regress back to bare `github.sha`.
  test("ci-gate.yml's gate step resolves GITHUB_SHA from the PR head commit on pull_request, not the synthetic merge commit", () => {
    const gate = read("ci-gate.yml");
    const envBlock = gate.match(/GITHUB_SHA:\s*(.+)/);
    expect(envBlock, "ci-gate.yml sets GITHUB_SHA in the gate step's env").not.toBeNull();
    const expr = envBlock![1]!.trim();
    expect(expr, "GITHUB_SHA must not be the bare github.sha expression").not.toBe("${{ github.sha }}");
    expect(expr, "GITHUB_SHA must branch on pull_request to use the real head commit").toContain("github.event.pull_request.head.sha");
    expect(expr, "GITHUB_SHA must still fall back to github.sha for non-pull_request events (push)").toContain("github.sha");
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


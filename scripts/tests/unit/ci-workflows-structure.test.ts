import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_DIR } from "../../../backend/scripts/lib/rollout-signing.ts";

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

const PATHS_FILTER_SHA = "ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d";

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
  "analyst-sdk.yml",
  "integration.yml",
  "web-client.yml",
  "research-pipeline.yml",
  "onboarding-eval-rails.yml",
  "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml",
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

  // ── where the reachability guard went, and what keeps it from creeping back ──
  //
  // `bun run test:live` used to be an entry in the map above, pinning the
  // contract package's live-network selector to contract.yml so that "the guard
  // is invoked by a real workflow" would be an assertion rather than a comment
  // (issue #484's whole point: the selector had been declared and invoked by
  // zero of eleven workflows for the life of the guard it named).
  //
  // That selector is now GONE — the test, the `tests/live/` directory and the
  // package script were all deleted — because every assertion it held is a
  // question about production rather than about the commit under review, and a
  // required job that reaches the public internet makes a pull request
  // unmergeable for a reason no diff in this repository can fix. It was measured:
  // the `contract` job was red on a pull request with `Received: 502`, caused by
  // nobody in that pull request.
  //
  // Deleting the map entry is only honest if the guarantee it carried is
  // replaced, so it is — by the two properties that are actually wanted now, both
  // mechanical: the retired selector cannot come back as a live merge-gate step
  // or as a declared-but-never-invoked script (the #484 false green), and the
  // workflow that DOES own the endpoint's reachability cannot gain a merge
  // trigger and become a gate by accident.
  describe("the skill endpoint's reachability is audited, never merge-gated", () => {
    /** Every `run:` command in every workflow, with the file it came from. */
    const runSteps = (): Array<{ file: string; run: string }> => {
      const steps: Array<{ file: string; run: string }> = [];
      for (const file of allWorkflows()) {
        for (const job of Object.values(parse(file).jobs ?? {})) {
          for (const step of job.steps ?? []) if (step.run) steps.push({ file, run: step.run });
        }
      }
      return steps;
    };

    /** The `on:` mapping, tolerating the YAML 1.1 bare-`on`→`true` fold. */
    const triggersOf = (file: string): Record<string, unknown> => {
      const wf = parse(file) as Workflow;
      const on = (wf.on ?? wf.true) as unknown;
      if (!on || typeof on !== "object" || Array.isArray(on)) {
        throw new Error(`${file}: could not read an \`on:\` mapping — refusing to treat that as "no triggers"`);
      }
      return on as Record<string, unknown>;
    };

    test("the retired `bun run test:live` selector is invoked by no workflow, in any job", () => {
      const offenders = runSteps().filter((s) => s.run.includes("test:live"));
      expect(
        offenders,
        `these steps still run the retired live selector, so a network assertion is back on a merge trigger: ${offenders.map((s) => `${s.file}: ${s.run.trim()}`).join(" | ")}`,
      ).toEqual([]);
    });

    test("contract declares no live selector and has no tests/live directory — the #484 false green cannot be re-added", () => {
      const pkg = JSON.parse(readFileSync(join(root, "contract/package.json"), "utf8")) as { scripts?: Record<string, string> };
      expect(Object.keys(pkg.scripts ?? {}), "contract/package.json declares no test:live script").not.toContain("test:live");
      // A `test:live` script that no workflow invokes is the precise shape of
      // the guard that never ran for the whole life of issue #484 — a script
      // nobody executes looks like coverage and is not.
      expect(existsSync(join(root, "contract/tests/live")), "contract/tests/live does not exist").toBe(false);
      // And the default selector is the whole offline tier, so a live test
      // cannot hide inside it either: `bun test tests/unit` selects by path.
      expect(pkg.scripts?.test).toBe("bun test tests/unit");
    });

    test("the auditor that owns the reachability question runs on a schedule and on no merge trigger", () => {
      const owners = runSteps()
        .filter((s) => s.run.includes("scripts/production-drift-audit.ts"))
        .map((s) => s.file);
      expect(
        [...new Set(owners)],
        "exactly one workflow runs the auditor — a second one on a merge trigger would re-create the gate",
      ).toEqual(["production-drift-audit.yml"]);

      const on = triggersOf("production-drift-audit.yml");
      expect(Object.keys(on), "the auditor has no push trigger, so no merge runs it").not.toContain("push");
      expect(Object.keys(on), "the auditor has no pull_request trigger, so no PR is blocked by it").not.toContain("pull_request");
      expect(Array.isArray(on.schedule), "the auditor runs on a schedule").toBe(true);
    });

    // RED CONTROL. Every assertion above is a grep, and a grep that matches
    // nothing is indistinguishable from a grep that is broken. These are planted
    // fixtures built from scratch — deliberately NOT derived from the real
    // workflows, so this control keeps biting even when the real tree has already
    // been planted (a control that reads the tree it is meant to police goes
    // green the moment the tree is wrong, or red for the wrong reason).
    test("red control: a re-added live-selector step, and a merge trigger on the auditor, are both caught", () => {
      const planted: Workflow = {
        jobs: {
          contract: { steps: [{ name: "Contract tests (unit)", run: "bun run test" }, { name: "Contract tests (live URLs)", run: "bun run test:live" }] },
        },
      };
      const plantedRuns: Array<{ file: string; run: string }> = Object.entries(planted.jobs ?? {}).flatMap(
        ([, job]) => (job.steps ?? []).flatMap((s) => (s.run ? [{ file: "planted.yml", run: s.run }] : [])),
      );
      // The same two filters the assertions above use, on planted input.
      expect(plantedRuns.filter((s) => s.run.includes("test:live")), "the live-selector matcher matches a planted step").toHaveLength(1);
      expect(plantedRuns.filter((s) => s.run.includes("scripts/production-drift-audit.ts")), "the auditor-owner matcher does not match it").toHaveLength(0);

      // A workflow triggered by `pull_request` must read as a merge trigger to
      // the check above, which is what makes that check bite.
      const mergeTriggered: Record<string, unknown> = { pull_request: { types: ["opened"] } };
      expect(Object.keys(mergeTriggered), "pull_request counts as a merge trigger").toContain("pull_request");
      const scheduleOnly = { schedule: [{ cron: "11 2 * * *" }] };
      expect(Object.keys(scheduleOnly), "a schedule-only workflow has no merge trigger").not.toContain("pull_request");
    });
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

  // ── tag-triggered publish provenance (issue #884 SEC-1 fix) ────────────────
  test("contract-publish.yml refuses to publish a tag whose commit isn't reachable from origin/main", () => {
    // Tag creation only requires repo write access, not a review, so any
    // contributor with write access could point a `contract-v*` tag at a
    // commit that never went through a PR/branch protection. The publish job
    // must fetch full history (fetch-depth: 0) and hard-fail (::error + a
    // non-zero exit, not a skip) before the `bun publish` step if the tagged
    // commit is not an ancestor of origin/main.
    const wf = read("contract-publish.yml");
    expect(
      wf,
      "contract-publish.yml's checkout uses fetch-depth: 0 so the ancestor check below has origin/main + full history available",
    ).toMatch(/uses:\s*actions\/checkout@v4[\s\S]*?fetch-depth:\s*0/);
    expect(
      wf,
      "contract-publish.yml checks the tagged commit is an ancestor of origin/main",
    ).toMatch(/git merge-base --is-ancestor .*origin\/main/);
    expect(
      wf,
      "contract-publish.yml fails loudly (::error + exit) rather than skipping when the ancestor check fails",
    ).toMatch(/::error::[\s\S]*?\n\s*exit 1/);

    const publishStepIndex = wf.indexOf("bun publish");
    const ancestorCheckIndex = wf.indexOf("--is-ancestor");
    expect(
      ancestorCheckIndex,
      "contract-publish.yml's ancestor check appears before its bun publish step",
    ).toBeGreaterThan(-1);
    expect(
      publishStepIndex,
      "contract-publish.yml's ancestor check appears before its bun publish step",
    ).toBeGreaterThan(ancestorCheckIndex);
  });

  // ── committed rollout evidence (issue #937) ────────────────────────────────
  test("backend.yml's pull_request paths-filter names the committed-evidence tree", () => {
    // The evidence tree lives OUTSIDE backend/ by construction: it must match no
    // rollout step's dependsOn glob, or recording one step's receipt would count
    // as code drift and invalidate the next one. That also puts it outside
    // backend.yml's original `backend/**` filter — so a PR that changed only a
    // committed receipt, or the allowed-signers file that is the entire trust
    // root, would skip the suite that verifies signatures
    // (backend/tests/rollout-receipt-repo-source.test.ts) and merge unverified.
    //
    // Asserted against rollout-signing.ts's own EVIDENCE_DIR constant rather
    // than a literal, so renaming the directory breaks this test instead of
    // silently un-gating the verifier.
    const filters = (parse("backend.yml").jobs?.changes?.steps ?? []).find((s) =>
      (s.uses ?? "").startsWith("dorny/paths-filter@"),
    ) as (WorkflowStep & { with?: { filters?: string } }) | undefined;
    expect(filters?.with?.filters, "backend.yml's changes job has a dorny/paths-filter step").toBeTruthy();
    const patterns = Object.values(
      Bun.YAML.parse(filters!.with!.filters!) as Record<string, string[]>,
    ).flat();
    expect(
      patterns.filter((p) => p.startsWith(`${EVIDENCE_DIR}/`)),
      `backend.yml's filter names ${EVIDENCE_DIR}/ — patterns were [${patterns.join(", ")}]`,
    ).not.toEqual([]);
    // Issue #1095: backend/src/analytics re-exports packages/analyst-sdk through
    // shims and backend/Dockerfile copies it in, so a PR touching only the SDK
    // must still run the backend job as well as analyst-sdk.yml's.
    expect(patterns, "backend.yml's filter selects PRs that touch only packages/").toContain("packages/**");
    // The pattern must be recursive: the allowed-signers file sits at the root
    // of the tree and the receipts one level down, and both have to select the job.
    expect(patterns).toContain(`${EVIDENCE_DIR}/**`);
  });
});


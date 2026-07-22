/**
 * Executable test seam for `.github/workflows/contribution-advisory-reviewer.yml`'s
 * inline `run:` bash (issue #230). Previously that PR-selection / draft-state
 * validation / reviewed-head-SHA skip / PATCH-vs-POST comment upsert logic was
 * only ever exercised by Bun.YAML.parse + string assertions in
 * `scripts/tests/contribution-advisory-workflow.test.ts` — nothing actually
 * ran the bash.
 *
 * This module extracts the exact `run:` string for the workflow's single
 * step directly from the YAML file (never a hand-copied duplicate, so there
 * is no drift risk) and executes it verbatim under `bash -c`, with `gh`
 * resolved from a caller-supplied stub directory prepended to PATH. The
 * workflow's actual runtime behavior is unchanged — this only makes the
 * existing bash reachable from a test.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_WORKFLOW_PATH = join(
  import.meta.dir,
  "../../.github/workflows/contribution-advisory-reviewer.yml",
);

const STEP_NAME = "Review eligible pull requests and upsert advisory comments";

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

export interface AdvisoryReviewStep {
  name: string;
  run: string;
  env: Record<string, string>;
}

/** Parse the workflow YAML and return the advisory-review step's `run:` bash verbatim. */
export function extractAdvisoryReviewStep(workflowPath: string = DEFAULT_WORKFLOW_PATH): AdvisoryReviewStep {
  const text = readFileSync(workflowPath, "utf8");
  const workflow = Bun.YAML.parse(text) as Workflow;
  const job = workflow.jobs["advisory-review"];
  if (!job) throw new Error("contribution-advisory-reviewer.yml is missing the 'advisory-review' job");
  const step = job.steps.find((candidate) => candidate.name === STEP_NAME);
  if (!step?.run) {
    throw new Error(`contribution-advisory-reviewer.yml is missing a '${STEP_NAME}' step with a run: block`);
  }
  return { name: step.name!, run: step.run, env: step.env ?? {} };
}

export interface RunAdvisoryWorkflowOptions {
  /** Mirrors GitHub's GITHUB_EVENT_NAME for the two triggers this workflow supports. */
  eventName: "schedule" | "workflow_dispatch";
  /** Mirrors GITHUB_REPOSITORY, e.g. "robotmoney/robotmoney-frontend". */
  repository: string;
  /** Mirrors `inputs.pr_number` on workflow_dispatch. Ignored on schedule. */
  manualPrNumber?: string;
  /** Directory containing an executable named `gh` that stands in for the real CLI. */
  ghStubDir: string;
  /** Executable standing in for the OpenCode CLI (mirrors OPENCODE_BIN). */
  opencodeBin: string;
  /** Mirrors RUNNER_TEMP; must be a writable directory. */
  runnerTemp: string;
  /** Working directory the real `bun scripts/contribution-advisory-reviewer.ts` call resolves from. Defaults to the repo root. */
  cwd?: string;
  /** Extra env vars, e.g. so a test's fake `gh` can locate its fixture/call-log files. */
  extraEnv?: Record<string, string>;
}

export interface RunAdvisoryWorkflowResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute the workflow's real `run:` bash under `bash -c`, exactly as GitHub
 * Actions would, but with `gh` (and therefore all GitHub API access) replaced
 * by a test double resolved from `ghStubDir` via PATH.
 */
export async function runAdvisoryWorkflowScript(
  options: RunAdvisoryWorkflowOptions,
): Promise<RunAdvisoryWorkflowResult> {
  const step = extractAdvisoryReviewStep();
  const repoRoot = resolve(import.meta.dir, "../..");
  const proc = Bun.spawn(["bash", "-c", step.run], {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...step.env,
      PATH: `${resolve(options.ghStubDir)}:${process.env.PATH ?? ""}`,
      GITHUB_EVENT_NAME: options.eventName,
      GITHUB_REPOSITORY: options.repository,
      MANUAL_PR_NUMBER: options.manualPrNumber ?? "",
      GH_TOKEN: "advisory-workflow-test-token",
      OPENCODE_BIN: options.opencodeBin,
      OPENCODE_TIMEOUT_MS: "5000",
      RUNNER_TEMP: options.runnerTemp,
      ...options.extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

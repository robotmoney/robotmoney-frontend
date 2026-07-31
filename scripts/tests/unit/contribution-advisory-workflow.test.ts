import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Workflow {
  env: Record<string, string>;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }>;
  }>;
}

const workflowText = readFileSync(
  join(import.meta.dir, "../../../.github/workflows/contribution-advisory-reviewer.yml"),
  "utf8",
);
const workflow = Bun.YAML.parse(workflowText) as Workflow;
const job = workflow.jobs["advisory-review"];
const runScripts = job.steps.map((step) => step.run ?? "").join("\n");

describe("contribution advisory workflow security contract", () => {
  // Issue #373 folded this workflow into the merge-to-main set: nightly is now
  // a MIRROR of what a merge runs, so a `schedule:` without a matching
  // `push: branches: [main]` is itself a defect
  // (scripts/tests/unit/nightly-mirrors-merge-set.test.ts). What has NOT
  // changed, and is the security contract this file exists for, is that no
  // `pull_request` trigger may appear here: every trigger below runs
  // default-branch code in a trusted context.
  test("parsed triggers are the merge-set mirror plus manual — never pull_request", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect((workflow.on.push as { branches: string[] }).branches).toEqual(["main"]);
    expect(workflow.on.schedule).toBeArray();
    expect(workflow.on.workflow_dispatch).toBeObject();
    expect(Object.keys(workflow.on)).not.toContain("pull_request");
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
  });

  test("parsed taxonomy and permissions are explicit and least privilege", () => {
    expect(workflow.env.CI_CLASS).toBe("heavy");
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });

  test("checkout is pinned to trusted default-branch code, never the PR head", () => {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(JSON.stringify(checkout)).not.toContain("pull_request.head");
  });

  test("the keyless model and issue-comment path create no check or review state", () => {
    expect(workflowText).not.toContain("secrets.");
    expect(workflow.env.OPENCODE_VERSION).toBe("1.18.1");
    expect(runScripts).toContain('Accept: application/vnd.github.diff');
    expect(runScripts).toContain("issues/comments/${comment_id}");
    expect(runScripts).not.toContain("gh pr review");
    expect(runScripts).not.toContain("/statuses");
    expect(runScripts).not.toContain("/reviews");
    expect(runScripts).not.toContain("checkout");
  });
});

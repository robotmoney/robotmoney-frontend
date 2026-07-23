// Regression coverage for the two governance-gate fixes in
// scripts/check-contribution.ts's runnable main():
//   1. the permission dictionary is read from the merge-base, never the PR's
//      own HEAD — a PR cannot edit .github/file-permissions.json to grant
//      itself access and have that self-grant apply to its own diff.
//   2. PR_AUTHOR is the actor of the current push, checked independently per
//      run — a maintainer's push is authorized against the maintainer's own
//      grants, not whatever the branch's earlier commits carried.
//
// Exercises the real script as a subprocess against a throwaway git repo, so a
// regression in main()'s git plumbing (not just the pure helpers already
// covered in check-contribution.test.ts) fails this suite loudly.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dir, "..", "check-contribution.ts");

let repo = "";

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "check-contribution-"));
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function writeAndCommit(path: string, content: string, message: string) {
  const fullPath = join(repo, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
  git(["add", path]);
  git(["commit", "-q", "-m", message]);
}

const BASE_POLICY = JSON.stringify({
  users: {
    admin: { all: ["**"] },
    contractor: { edit: ["frontend/**"] },
    "*": { create: [], edit: [], delete: [] },
  },
});

function run(env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bun", ["run", SCRIPT_PATH], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("a PR cannot self-grant permission by editing file-permissions.json at its own HEAD", async () => {
  await writeAndCommit(".github/file-permissions.json", BASE_POLICY, "seed base policy");
  await writeAndCommit("frontend/existing.txt", "ok", "seed frontend file");
  await writeAndCommit("scripts/tool.ts", "export const v = 1;", "seed scripts file");
  const base = git(["rev-parse", "HEAD"]).trim();

  // "contractor" (edit-only on frontend/**) tries to grant itself scripts/**
  // access and then, in the SAME push, edit an existing scripts/ file.
  const selfGrant = JSON.stringify({
    users: {
      admin: { all: ["**"] },
      contractor: { edit: ["frontend/**"], all: ["**"] },
      "*": { create: [], edit: [], delete: [] },
    },
  });
  await writeAndCommit(".github/file-permissions.json", selfGrant, "self-grant (malicious)");
  await writeAndCommit("scripts/tool.ts", "export const v = 2;", "edit a scripts file");

  const result = run({ BASE_REF: base, PR_AUTHOR: "contractor" });
  expect(result.code).toBe(1);
  // Both the self-grant edit AND the scripts/ edit it was meant to unlock are
  // blocked — proving the self-granted policy at HEAD was never consulted.
  expect(result.stderr).toContain(".github/file-permissions.json: [permission] @contractor is not allowed to edit");
  expect(result.stderr).toContain("scripts/tool.ts: [permission] @contractor is not allowed to edit");
});

test("an unmodified base policy still permits an admin's own grants on the same diff shape", async () => {
  await writeAndCommit(".github/file-permissions.json", BASE_POLICY, "seed base policy");
  await writeAndCommit("frontend/existing.txt", "ok", "seed frontend file");
  const base = git(["rev-parse", "HEAD"]).trim();

  await writeAndCommit("scripts/tool.ts", "export {}", "admin edits a scripts file");

  // Same diff shape as the attack above, but PR_AUTHOR is the actor who
  // actually pushed this commit (an admin with all:["**"]), not the PR's
  // original opener — the gate checks the ACTUAL pusher of this run.
  const result = run({ BASE_REF: base, PR_AUTHOR: "admin" });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("contribution check OK");
});

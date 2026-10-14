#!/usr/bin/env bun
// scripts/release/lockfile.ts — every rc carries a freshly resolved lockfile
// (owner, 2026-10-14; policy §4.6).
//
//   bun scripts/release/lockfile.ts refresh            delete and regenerate every committed bun.lock in this checkout
//   bun scripts/release/lockfile.ts check <commit>     exit 1 when a fresh resolve of <commit> differs from its committed lockfiles
//
// On the QA branch, before the stage run, `refresh` resolves every dependency
// again and the result is committed. Stage's preflight (P.lockfile) runs
// `check` on the control machine: it resolves the commit afresh in a throwaway
// worktree and refuses when any lockfile differs, so the rc a stage run passes
// carries the lockfile a fresh resolve gives. The hosts then install with
// `--frozen-lockfile` (R1.3, R1.6): an install never rewrites the tree that
// R1.2 proved clean. Production inherits the lockfile by tree equality (D70).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The directories that hold a committed bun.lock, relative to the repository root. */
export const LOCKFILE_DIRS = Object.freeze([".", "backend", "packages/analyst-sdk"]);

/** PURE. The lockfile paths, as `git status` names them. */
export function lockfilePaths(): string[] {
  return LOCKFILE_DIRS.map((d) => (d === "." ? "bun.lock" : `${d}/bun.lock`));
}

/** PURE. Why a fresh resolve is not what the commit carries; empty when it is. `porcelain` is `git status --porcelain` over the lockfiles. */
export function lockfileProblems(porcelain: string): string[] {
  return porcelain.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => `${l.slice(l.indexOf(" ") + 1).trim()} differs from a fresh resolve: run bun scripts/release/lockfile.ts refresh on the QA branch and commit it`);
}

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** Delete and regenerate every lockfile under `root`. Throws on a failed resolve. */
export function refresh(root: string): void {
  for (const dir of LOCKFILE_DIRS) {
    const cwd = join(root, dir);
    rmSync(join(cwd, "bun.lock"), { force: true });
    const r = run(["bun", "install", "--lockfile-only"], cwd);
    if (r.code !== 0) throw new Error(`bun install --lockfile-only in ${dir} failed:\n${r.out}`);
  }
}

/** Resolve `commit` afresh in a throwaway worktree of `repo`; the problems, empty when its lockfiles are fresh. */
export function check(repo: string, commit: string): string[] {
  // Under the user's ~/tmp, never a system directory.
  const parent = join(homedir(), "tmp");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "rm-lockfile-"));
  rmSync(dir, { recursive: true, force: true });
  const add = run(["git", "worktree", "add", "--quiet", "--detach", dir, commit], repo);
  if (add.code !== 0) return [`git worktree add ${commit} failed: ${add.out.trim()}`];
  try {
    refresh(dir);
    const status = run(["git", "status", "--porcelain", "--", ...lockfilePaths()], dir);
    if (status.code !== 0) return [`git status failed: ${status.out.trim()}`];
    return lockfileProblems(status.out);
  } finally {
    run(["git", "worktree", "remove", "--force", dir], repo);
  }
}

if (import.meta.main) {
  const [mode, commit] = process.argv.slice(2);
  const repo = join(import.meta.dir, "..", "..");
  if (mode === "refresh") {
    refresh(process.cwd());
    console.log(`refreshed ${lockfilePaths().join(", ")}; commit them on the QA branch`);
  } else if (mode === "check" && commit && /^[0-9a-f]{40}$/.test(commit)) {
    const problems = check(repo, commit);
    if (problems.length > 0) { console.error(problems.join("\n")); process.exit(1); }
    console.log(`${commit.slice(0, 12)}: ${lockfilePaths().join(", ")} equal a fresh resolve`);
  } else {
    console.error("usage: lockfile.ts refresh | lockfile.ts check <40-hex commit>");
    process.exit(2);
  }
}

// EXECUTED proof that `.agents/` is runtime state git never sees.
//
// The repo's `.agents/` directory holds agent/loop runtime state only — smoke
// state files, smoke logs, snapshot caches, plan backups, loop-suggestion
// archives. None of it is source and none of it has ever been tracked. The
// ignore rule used to name exactly ONE file inside it
// (`.agents/smoke-state.json`), so every other runtime artefact showed up as
// untracked noise in `git status` in every checkout and every stale worktree
// forever. This test pins the directory-wide rule that replaced it.
//
// Two properties, both asserted by running real `git`, no network and no
// Docker:
//   1. Representative runtime paths under `.agents/` resolve to a
//      DIRECTORY-wide `.gitignore` rule — a future edit narrowing it back to a
//      single file goes red here.
//   2. Nothing under `.agents/` is in the index. A directory-wide ignore does
//      NOT untrack an already-tracked file, so "ignored" alone would not prove
//      the runtime state is actually out of the repo.
//
// The planted-fixture controls at the bottom are the load-bearing half: they
// build throwaway repos carrying the OLD single-file rule and show the same
// checks going red, so a regression in how this test shells out to git cannot
// masquerade as a pass.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Runtime artefacts the loop actually writes. None of these need to exist on
// disk: `git check-ignore` matches path patterns, so a fresh CI checkout that
// has never run the loop is graded identically to a developer machine.
const RUNTIME_PATHS = [
  ".agents/smoke-state.json",
  ".agents/cache/github-snapshot.json",
  ".agents/plan-backups/plan-2026-07-28.md",
  ".agents/loop-suggestions-archive/2026-07-28.md",
  ".agents/smoke-rmdemo1234.log",
  ".agents/agent-warnings.md",
];

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: new TextDecoder().decode(child.stdout) };
}

/**
 * The `.gitignore` rule (source text only) that causes `path` to be ignored, or
 * null when git does not ignore it. `check-ignore -v` prints
 * `<file>:<line>:<pattern>\t<path>`.
 */
function ignoringPattern(cwd: string, path: string): string | null {
  const { code, stdout } = git(cwd, ["check-ignore", "-v", "--no-index", path]);
  if (code !== 0 || stdout.trim() === "") return null;
  const [source] = stdout.trim().split("\t");
  const parts = source.split(":");
  return parts.slice(2).join(":");
}

/** Files under `.agents/` present in the index. Must always be empty. */
function trackedUnderAgents(cwd: string): string[] {
  const { stdout } = git(cwd, ["ls-files", "--", ".agents"]);
  return stdout.split("\n").filter((l) => l !== "");
}

describe(".agents/ is git-invisible runtime state", () => {
  test("git is available — a missing git would make every check below vacuous", () => {
    expect(git(repoRoot, ["rev-parse", "--is-inside-work-tree"]).stdout.trim()).toBe("true");
  });

  for (const path of RUNTIME_PATHS) {
    test(`${path} is ignored by the directory-wide rule, not a per-file one`, () => {
      // Exactly `.agents/`: a rule naming a single file (the pre-change
      // `.agents/smoke-state.json`) fails this even for that one file.
      expect(ignoringPattern(repoRoot, path)).toBe(".agents/");
    });
  }

  test("nothing under .agents/ is tracked — ignoring a tracked file would not untrack it", () => {
    expect(trackedUnderAgents(repoRoot)).toEqual([]);
  });

  test("the check discriminates — a normal source path is NOT ignored", () => {
    expect(ignoringPattern(repoRoot, "scripts/tests/unit/agents-runtime-state-ignored.test.ts")).toBeNull();
  });
});

// ── negative controls: these checks must be able to FAIL ─────────────────────
describe("the checks go red against the pre-change single-file rule", () => {
  function plantRepo(ignoreBody: string, opts: { trackAgentsFile?: boolean } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "agents-runtime-state-"));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "test"]);
    writeFileSync(join(root, ".gitignore"), ignoreBody);
    if (opts.trackAgentsFile) {
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(join(root, ".agents", "leaked.json"), "{}\n");
      // `-f` mirrors the only way runtime state can end up tracked: someone
      // forces it past the ignore rule.
      git(root, ["add", "-f", ".agents/leaked.json"]);
    }
    return root;
  }

  test("the OLD single-file rule leaves every other runtime artefact unignored", () => {
    const root = plantRepo("# Standing local smoke state.\n.agents/smoke-state.json\n");
    try {
      // The one named file is ignored, but by a per-file pattern, not `.agents/`.
      expect(ignoringPattern(root, ".agents/smoke-state.json")).toBe(".agents/smoke-state.json");
      for (const path of RUNTIME_PATHS.filter((p) => p !== ".agents/smoke-state.json")) {
        expect(ignoringPattern(root, path)).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the directory-wide rule covers all of them in the same fixture repo", () => {
    const root = plantRepo("# Agent/loop runtime state.\n.agents/\n");
    try {
      for (const path of RUNTIME_PATHS) expect(ignoringPattern(root, path)).toBe(".agents/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a force-added file under .agents/ is caught even though the directory is ignored", () => {
    const root = plantRepo("# Agent/loop runtime state.\n.agents/\n", { trackAgentsFile: true });
    try {
      expect(ignoringPattern(root, ".agents/leaked.json")).toBe(".agents/");
      expect(trackedUnderAgents(root)).toEqual([".agents/leaked.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

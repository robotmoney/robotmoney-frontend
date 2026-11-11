// `csvb layout` (issue 1609, D80): the data repo tracks csv/**, README.md and .gitignore only. Fixture git repos,
// green and red, run as a process the way an operator runs it.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strayPaths } from "../src/layout.ts";

const PKG = join(import.meta.dir, "..");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const put = (root: string, rel: string, body = "x\n"): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const git = (root: string, ...args: string[]): void => {
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
};

function dataRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "csvb-layout-"));
  made.push(root);
  git(root, "init", "-q");
  put(root, "csv/2026-10-28T180400Z/backup.json", "{}\n");
  put(root, "README.md");
  put(root, ".gitignore", "reports/\nnode_modules/\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  return root;
}

function layout(repo: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", "run", "src/cli.ts", "layout", "--repo", repo], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

describe("csvb layout", () => {
  test("a repo holding only csv/**, README.md and .gitignore has no stray paths and exits 0", () => {
    const root = dataRepo();
    expect(strayPaths(root)).toEqual([]);
    expect(layout(root).code).toBe(0);
  });

  test("tooling files are each reported by path and exit 1 (red control)", () => {
    const root = dataRepo();
    const tooling = ["package.json", "bun.lock", "tsconfig.json", "src/cli.ts"];
    for (const f of tooling) put(root, f);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "tooling");
    expect(strayPaths(root)).toEqual([...tooling].sort());
    const r = layout(root);
    expect(r.code).toBe(1);
    for (const f of tooling) expect(r.out).toContain(f);
  });

  test("untracked and gitignored files are not reported", () => {
    const root = dataRepo();
    put(root, "reports/x");
    put(root, "node_modules/y");
    put(root, "scratch.txt");
    expect(strayPaths(root)).toEqual([]);
    expect(layout(root).code).toBe(0);
  });

  test("a directory that is not a git repo is refused with a clear message", () => {
    const dir = mkdtempSync(join(tmpdir(), "csvb-notgit-"));
    made.push(dir);
    const r = layout(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is not a git repository");
  });
});

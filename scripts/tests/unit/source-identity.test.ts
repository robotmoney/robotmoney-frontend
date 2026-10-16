// Unit specification for scripts/stack/source-identity.ts — each image's source
// identity, the Git tree hash of its build context (smoke-production-spec.md
// §1.2 as amended by D52).
//
// Every case runs real `git` against a throwaway repository, because the
// property under test is what Git answers for a working tree — clean, edited,
// with a new file, with an ignored file — and a faked runner would only
// restate the implementation's own idea of that.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitRunner,
  normalizeContext,
  resolveSourceIdentities,
  resolveSourceTrees,
  SOURCE_IDENTITY_PATTERN,
} from "../../stack/source-identity.ts";

const repos: string[] = [];
afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A committed repository with two build contexts and an ignore rule. */
function freshRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rm-source-repo-"));
  repos.push(repo);
  git(repo, "init", "-q");
  mkdirSync(join(repo, "backend"));
  mkdirSync(join(repo, "website-server"));
  writeFileSync(join(repo, "backend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "backend", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "website-server", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function treeOf(repo: string, context: string): string {
  return resolveSourceTrees(gitRunner(repo), [context])[normalizeContext(context)] as string;
}

describe("resolveSourceTrees — §1.2, an image's source identity is its build context's Git tree", () => {
  test("on a clean tree it is exactly the committed tree of the context", () => {
    const repo = freshRepo();
    expect(treeOf(repo, "backend")).toBe(git(repo, "rev-parse", "HEAD:backend"));
    expect(treeOf(repo, ".")).toBe(git(repo, "rev-parse", "HEAD^{tree}"));
    expect(treeOf(repo, "backend")).toMatch(SOURCE_IDENTITY_PATTERN);
  });

  test("it is stable: asking twice, with nothing changed, gives one answer", () => {
    const repo = freshRepo();
    expect(treeOf(repo, "backend")).toBe(treeOf(repo, "backend"));
  });

  test("an uncommitted edit under the context changes it, and undoing the edit restores it", () => {
    const repo = freshRepo();
    const clean = treeOf(repo, "backend");
    writeFileSync(join(repo, "backend", "index.ts"), "export const x = 2;\n");
    const dirty = treeOf(repo, "backend");
    expect(dirty).not.toBe(clean);
    writeFileSync(join(repo, "backend", "index.ts"), "export const x = 1;\n");
    expect(treeOf(repo, "backend")).toBe(clean);
  });

  test("a new untracked source file changes it; a deleted one does too", () => {
    const repo = freshRepo();
    const clean = treeOf(repo, "backend");
    writeFileSync(join(repo, "backend", "extra.ts"), "export {};\n");
    expect(treeOf(repo, "backend")).not.toBe(clean);
    unlinkSync(join(repo, "backend", "extra.ts"));
    unlinkSync(join(repo, "backend", "index.ts"));
    expect(treeOf(repo, "backend")).not.toBe(clean);
  });

  test("an ignored file is not source: it leaves the identity alone", () => {
    const repo = freshRepo();
    const clean = treeOf(repo, "backend");
    writeFileSync(join(repo, "backend", "debug.log"), "noise\n");
    expect(treeOf(repo, "backend")).toBe(clean);
  });

  test("a change outside a context leaves that context alone and moves the root context", () => {
    const repo = freshRepo();
    const backend = treeOf(repo, "backend");
    const root = treeOf(repo, ".");
    writeFileSync(join(repo, "website-server", "Dockerfile"), "FROM scratch\nLABEL x=y\n");
    expect(treeOf(repo, "backend")).toBe(backend);
    expect(treeOf(repo, ".")).not.toBe(root);
  });

  test("the real index is never written: staged state and `git status` are untouched", () => {
    const repo = freshRepo();
    writeFileSync(join(repo, "backend", "index.ts"), "export const x = 3;\n");
    writeFileSync(join(repo, "backend", "new.ts"), "export {};\n");
    const indexPath = join(repo, ".git", "index");
    // `git status` refreshes the index's stat cache itself, so it runs first
    // and the bytes are captured after it.
    const statusBefore = git(repo, "status", "--porcelain");
    const indexBefore = readFileSync(indexPath);
    treeOf(repo, "backend");
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
  });

  test("every service maps to its context's tree; two services on one context share it", () => {
    const repo = freshRepo();
    const ids = resolveSourceIdentities(gitRunner(repo), {
      api: ".",
      "system-scheduler": "./",
      website: "website-server",
    });
    expect(ids.api).toBe(git(repo, "rev-parse", "HEAD^{tree}"));
    expect(ids["system-scheduler"]).toBe(ids.api);
    expect(ids.website).toBe(git(repo, "rev-parse", "HEAD:website-server"));
  });

  test("a context outside the repository or absolute refuses", () => {
    expect(() => normalizeContext("../elsewhere")).toThrow(/leaves the repository/);
    expect(() => normalizeContext("/abs/path")).toThrow(/absolute/);
  });

  test("a context with no source in it refuses rather than inventing an identity", () => {
    const repo = freshRepo();
    expect(() => treeOf(repo, "no-such-dir")).toThrow(/Refusing/);
  });

  test("a directory that is not a repository refuses", () => {
    const plain = mkdtempSync(join(tmpdir(), "rm-source-plain-"));
    repos.push(plain);
    expect(() => treeOf(plain, ".")).toThrow(/Refusing/);
  });
});

// Issue 1561 (D81): the web content release tag guard, scripts/check-web-tag.ts,
// which .github/workflows/web-tag-guard.yml runs on a push of a web-v* tag.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkWebTag } from "../../check-web-tag.ts";

setDefaultTimeout(60_000);

const ON = ["origin/web/releases-0.2.x"];

describe("checkWebTag", () => {
  test("passes a tag whose version matches, is above every other web-v* tag, on a web release branch", () => {
    expect(checkWebTag({ tag: "web-v0.2.1", packageVersion: "0.2.1", webTags: ["web-v0.2.0", "web-v0.2.1", "web-v0.1.9"], branchesContainingCommit: ON })).toEqual([]);
  });
  test("refuses a version that differs from frontend/package.json", () => {
    expect(checkWebTag({ tag: "web-v0.2.1", packageVersion: "0.2.0", webTags: [], branchesContainingCommit: ON })).toEqual([
      "tag version 0.2.1 differs from frontend/package.json version 0.2.0",
    ]);
  });
  test("refuses a version not above the previous web-v* tag", () => {
    expect(checkWebTag({ tag: "web-v0.2.0", packageVersion: "0.2.0", webTags: ["web-v0.2.0", "web-v0.2.3"], branchesContainingCommit: ON })).toEqual([
      "tag version 0.2.0 is not above the previous tag web-v0.2.3",
    ]);
  });
  test("refuses a commit off origin/web/releases-*", () => {
    expect(checkWebTag({ tag: "web-v0.2.0", packageVersion: "0.2.0", webTags: [], branchesContainingCommit: ["origin/main", "origin/releases-0.7.x"] })).toEqual([
      "the tagged commit is not on any origin/web/releases-* branch",
    ]);
  });
  test("refuses a foreign prefix and a version that is not A.B.C", () => {
    expect(checkWebTag({ tag: "v0.2.0", packageVersion: "0.2.0", webTags: [], branchesContainingCommit: ON })).toHaveLength(1);
    expect(checkWebTag({ tag: "web-v0.2", packageVersion: "0.2", webTags: [], branchesContainingCommit: ON })).toContain("tag web-v0.2 does not name an A.B.C version");
  });
});

describe("the CLI against a real repository", () => {
  const script = join(import.meta.dir, "../../check-web-tag.ts");
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  /** A repo whose HEAD carries frontend/package.json `version`, pushed to `branch` of a local bare origin, with `tags` on it. */
  function repo(version: string, branch: string, tags: string[] = []): string {
    const base = join(homedir(), "tmp");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "web-tag-guard-"));
    dirs.push(dir);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const sh = (cwd: string, ...a: string[]) => {
      const r = spawnSync("git", a, { cwd, encoding: "utf8", env });
      if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    };
    const work = join(dir, "work");
    sh(dir, "init", "-q", "--bare", "origin.git");
    sh(dir, "init", "-q", "-b", "main", work);
    mkdirSync(join(work, "frontend"));
    writeFileSync(join(work, "frontend/package.json"), JSON.stringify({ name: "@robotmoney/web-client", version }));
    sh(work, "add", "frontend");
    sh(work, "commit", "-qm", "web");
    for (const t of tags) sh(work, "tag", "-a", t, "-m", t);
    sh(work, "remote", "add", "origin", join(dir, "origin.git"));
    sh(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    sh(work, "fetch", "-q", "origin");
    return work;
  }
  const run = (cwd: string, tag: string) => spawnSync("bun", [script, tag, "HEAD"], { cwd, encoding: "utf8" });

  test("exits 0 for a valid tag", () => {
    const r = run(repo("0.2.0", "web/releases-0.2.x", ["web-v0.1.0", "web-v0.2.0"]), "web-v0.2.0");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
  test("exits 1 when the version differs from frontend/package.json", () => {
    const r = run(repo("0.2.0", "web/releases-0.2.x"), "web-v0.2.1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::tag version 0.2.1 differs from frontend/package.json version 0.2.0");
  });
  test("exits 1 when the version is not above the previous web-v* tag", () => {
    const r = run(repo("0.2.0", "web/releases-0.2.x", ["web-v0.2.0", "web-v0.3.0"]), "web-v0.2.0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::tag version 0.2.0 is not above the previous tag web-v0.3.0");
  });
  test("exits 1 when the commit is not on origin/web/releases-*", () => {
    const r = run(repo("0.2.0", "releases-0.7.x"), "web-v0.2.0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::the tagged commit is not on any origin/web/releases-* branch");
  });
});

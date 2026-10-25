// D77 item 4: the analyst SDK tag guard (issue 1449).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkTag, MANIFEST } from "../../check-analyst-sdk-tag";

const ON = ["origin/analyst-sdk/releases-0.2.x"];

describe("checkTag", () => {
  test("passes when the version matches and the commit is on an SDK release branch", () => {
    expect(checkTag({ tag: "analyst-sdk-v0.2.0", packageVersion: "0.2.0", branchesContainingCommit: ON })).toEqual([]);
  });
  test("fails when the tag version differs from package.json", () => {
    const r = checkTag({ tag: "analyst-sdk-v0.2.1", packageVersion: "0.2.0", branchesContainingCommit: ON });
    expect(r.length).toBe(1);
    expect(r[0]).toContain("differs");
  });
  test("fails when the commit is off the SDK release branches", () => {
    const r = checkTag({ tag: "analyst-sdk-v0.2.0", packageVersion: "0.2.0", branchesContainingCommit: ["origin/main", "origin/releases-0.6.x"] });
    expect(r.length).toBe(1);
    expect(r[0]).toContain("not on any");
  });
  test("fails on no branch at all", () => {
    expect(checkTag({ tag: "analyst-sdk-v0.2.0", packageVersion: "0.2.0", branchesContainingCommit: [] }).length).toBe(1);
  });
  test("fails on a foreign tag prefix", () => {
    expect(checkTag({ tag: "v0.2.0", packageVersion: "0.2.0", branchesContainingCommit: ON }).length).toBe(1);
  });
});

describe("CLI against a real repository", () => {
  const script = join(import.meta.dir, "../../check-analyst-sdk-tag.ts");
  function repo(version: string, remoteBranch: string): string {
    const base = join(homedir(), "tmp");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "sdk-tag-guard-"));
    const sh = (...a: string[]) => {
      const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    sh("init", "-q");
    mkdirSync(join(dir, "packages/analyst-sdk"), { recursive: true });
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ version }));
    sh("add", ".");
    sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
    sh("update-ref", `refs/remotes/origin/${remoteBranch}`, "HEAD");
    return dir;
  }
  const run = (cwd: string, tag: string) =>
    spawnSync("bun", [script, tag], { cwd, encoding: "utf8" }).status;

  test("exit 0 for the passing case", () => {
    expect(run(repo("0.2.0", "analyst-sdk/releases-0.2.x"), "analyst-sdk-v0.2.0")).toBe(0);
  });
  test("exit 1 for a mismatched version", () => {
    expect(run(repo("0.2.0", "analyst-sdk/releases-0.2.x"), "analyst-sdk-v0.3.0")).toBe(1);
  });
  test("exit 1 for a commit off the SDK release branch", () => {
    expect(run(repo("0.2.0", "main"), "analyst-sdk-v0.2.0")).toBe(1);
  });
});

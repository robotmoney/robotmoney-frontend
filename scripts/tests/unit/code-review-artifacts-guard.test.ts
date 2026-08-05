import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const CHECK = join(repoRoot, "scripts", "checks", "check-code-review-artifacts.sh");

function runCheck(targetRoot?: string): { exitCode: number; output: string } {
  const r = Bun.spawnSync(["bash", CHECK, ...(targetRoot ? [targetRoot] : [])], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  return { exitCode: r.exitCode ?? -1, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

function fixtureTree(fileName: string, contents: string, dir = "docs/code-review"): string {
  const root = mkdtempSync(join(tmpdir(), "code-review-artifacts-guard-"));
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, fileName), contents);
  return root;
}

describe("check-code-review-artifacts.sh", () => {
  test("the guard script exists and is executable content", () => {
    expect(existsSync(CHECK)).toBe(true);
    expect(readFileSync(CHECK, "utf8")).toContain("check-code-review-artifacts");
  });

  test("the real tree PASSES — no dead commit pins in docs/code-review/", () => {
    const r = runCheck();
    expect(r.output).toContain("check-code-review-artifacts: OK");
    expect(r.exitCode).toBe(0);
  });

  test("FAILS when an artifact pins a fabricated SHA", () => {
    const root = fixtureTree("fake-review.json", JSON.stringify({ commit: "ffffffffffffffffffffffffffffffffffffffff" }));
    try {
      const r = runCheck(root);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("FAILED — ");
      expect(r.output).toContain("is not an ancestor of HEAD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PASSES when an artifact uses pull_request (rebase-stable)", () => {
    const root = fixtureTree("inflight-review.json", JSON.stringify({ pull_request: 123 }));
    try {
      const r = runCheck(root);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FAILS when an artifact has neither commit nor pull_request", () => {
    const root = fixtureTree("invalid-review.json", JSON.stringify({ other_key: "value" }));
    try {
      const r = runCheck(root);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("missing both 'commit' and 'pull_request'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is wired into the required repo-guards workflow", () => {
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "repo-guards.yml"), "utf8");
    expect(wf).toContain("bash scripts/checks/check-code-review-artifacts.sh");
  });
});

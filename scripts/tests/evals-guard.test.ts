// PURE, per-PR execution of the eval guard (docs/decisions.md D22 rules 1-2,
// docs/architecture.md §11.3 E1/E2, §3 L3).
//
// A lint that is never executed is not a gate. This file RUNS
// scripts/checks/check-eval-keyless.sh — against the real tree (must pass) and
// against fixture trees that violate each rule (must fail). The negative
// controls are the load-bearing half: without them a broken pattern, a typo in
// a path, or a `grep` that silently matched nothing would leave the guard
// vacuously green forever.
//
// It also asserts the WIRING that keeps the eval off the per-PR path: `test`
// must not reach into evals/, the eval targets must exist and point at
// evals/onboarding, and tsconfig must include evals/**/*.ts (without which the
// whole suite is invisible to `bun run typecheck`).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const CHECK = join(repoRoot, "scripts", "checks", "check-eval-keyless.sh");

function runCheck(targetRoot?: string): { exitCode: number; output: string } {
  const r = Bun.spawnSync(["bash", CHECK, ...(targetRoot ? [targetRoot] : [])], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return { exitCode: r.exitCode ?? -1, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

// A minimal tree the check can scan: <root>/evals/onboarding/<file>.
function fixtureTree(fileName: string, contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "evals-guard-fixture-"));
  mkdirSync(join(root, "evals", "onboarding"), { recursive: true });
  writeFileSync(join(root, "evals", "onboarding", fileName), contents);
  return root;
}

describe("check-eval-keyless.sh", () => {
  test("the guard script exists and is executable content, not a stub", () => {
    expect(existsSync(CHECK)).toBe(true);
    expect(readFileSync(CHECK, "utf8")).toContain("check-eval-keyless");
  });

  test("the real tree PASSES (evals are keyless, env-free, skip-free, and double-free)", () => {
    const r = runCheck();
    expect(r.output).toContain("check-eval-keyless: OK");
    expect(r.exitCode).toBe(0);
  });

  // ── negative controls: the guard must be able to FAIL ─────────────────────
  const violations: Array<[string, string, string]> = [
    ["a provider key", "keyed.ts", 'const k = "ANTHROPIC_API_KEY";\n'],
    ["a model override knob", "model.ts", 'const m = process.env.OPENCODE_MODEL;\n'],
    ["any ambient-environment read", "env.ts", 'const v = process.env.SOMETHING;\n'],
    ["a conditional skip", "skip.ts", 'test.skip("nope", () => {});\n'],
    ["a skipIf guard", "skipif.ts", 'const t = test.skipIf(!hasDocker);\n'],
    ["an injection seam", "seam.ts", "export const runOnce = async () => ({ admitted: true });\n"],
    ["a test double", "double.ts", 'import { mock } from "bun:test";\n'],
  ];

  for (const [what, fileName, contents] of violations) {
    test(`FAILS on ${what} — the guard cannot be vacuously green`, () => {
      const root = fixtureTree(fileName, contents);
      try {
        const r = runCheck(root);
        expect(r.exitCode).not.toBe(0);
        expect(r.output).toContain("check-eval-keyless: FAILED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("FAILS on a tree with no evals/ at all — a guard over zero paths is a green that means nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "evals-guard-empty-"));
    try {
      const r = runCheck(empty);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("silently empty guard");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("PASSES on a clean fixture tree — it is not failing for an unrelated reason", () => {
    const root = fixtureTree("clean.ts", "export const LAYER = 'layer0';\n");
    try {
      expect(runCheck(root).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("eval wiring keeps evals/ off the per-PR path (§3 L1)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };

  test("`test` is path-scoped to scripts/tests and never reaches into evals/", () => {
    expect(pkg.scripts.test).toBe("bun test scripts/tests");
    expect(pkg.scripts.test).not.toContain("evals");
  });

  test("the eval targets exist and point at evals/onboarding", () => {
    expect(pkg.scripts["eval:onboarding"]).toBe("bun test evals/onboarding");
    expect(pkg.scripts["eval:onboarding:isolated"]).toBe("bun test evals/onboarding/isolated");
    expect(pkg.scripts["eval:onboarding:admission"]).toBe("bun test evals/onboarding/admission");
  });

  test("tsconfig includes evals/**/*.ts — without it the eval is invisible to typecheck", () => {
    const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as { include: string[] };
    expect(tsconfig.include).toContain("evals/**/*.ts");
  });

  test("every layer of §11.3's table has a file, and each is in the right cost directory", () => {
    for (const rel of [
      "evals/onboarding/isolated/layer0-runtime.eval.test.ts",
      "evals/onboarding/isolated/layer1-skill-install.eval.test.ts",
      "evals/onboarding/isolated/layer2-toolchain.eval.test.ts",
      "evals/onboarding/isolated/layer3-keygen-signing.eval.test.ts",
      "evals/onboarding/admission/layer4-admission.eval.test.ts",
    ]) {
      expect(existsSync(join(repoRoot, rel))).toBe(true);
    }
  });

  test("`bun test` over an empty eval selection is RED — 0 tests collected can never be a green", () => {
    const r = Bun.spawnSync(["bun", "test", "evals/onboarding/does-not-exist"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(r.exitCode).not.toBe(0);
  });
});

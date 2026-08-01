// backend/tsconfig.json's `include` used to cover only `src/**/*.ts` — the 98
// files under backend/tests/**/*.ts were never fed to `tsc`, in CI or locally
// (issue #454, surfaced during independent compliance review of PR #453). Since
// `bun test` strips TypeScript types without checking them, a dropped/renamed/
// retyped field a test file referenced could sit undetected indefinitely; the
// only thing that ever ran over those files was the runtime assertions
// themselves, never the type layer.
//
// This is a MUST-FAIL self-test (matching the fixture convention already used
// by scripts/tests/unit/css-duplicate-selectors.test.ts and
// scripts/tests/unit/runtime-import-guard.test.ts): a lint/gate that is never
// proven capable of failing is not a gate. The negative-control fixture below
// plants a genuine type error under a `tests/`-shaped path, using backend's
// REAL compilerOptions (copied verbatim from backend/tsconfig.json, so
// `strict`, etc. are exactly what CI enforces) plus the exact `include`
// pattern the fix adds, and proves `tsc --noEmit` actually fails on it.
//
// The scratch tree lives INSIDE backend/ (as a gitignored-by-construction,
// always-cleaned-up temp dir) rather than under the OS tmp dir: TypeScript's
// `types`/`@types` resolution walks UP from the tsconfig's directory through
// ancestor `node_modules`, so nesting under backend/ lets `bun-types` resolve
// from backend/node_modules without needing its own install. Fixture files are
// named `*.ts`, never `*.test.ts`, so they can never be mistaken for a real
// spec by a `bun test` invocation that happens to run concurrently.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const backendRoot = join(repoRoot, "backend");
const backendTsconfigPath = join(backendRoot, "tsconfig.json");
const TSC = join(backendRoot, "node_modules", ".bin", "tsc");

interface BackendTsconfig {
  compilerOptions: Record<string, unknown>;
  include: string[];
}

function readBackendTsconfig(): BackendTsconfig {
  return JSON.parse(readFileSync(backendTsconfigPath, "utf8")) as BackendTsconfig;
}

function runTsc(cwd: string, configPath: string): { exitCode: number; output: string } {
  const r = Bun.spawnSync([TSC, "--noEmit", "-p", configPath], { cwd, stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return { exitCode: r.exitCode ?? -1, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

// Build an isolated tests/-shaped scratch tree under backend/ (see header) with
// backend's REAL compilerOptions plus include: ["tests/**/*.ts"], write `body`
// as tests/<name>, and run tsc --noEmit over it. Always cleaned up.
function typecheckFixture(name: string, body: string): { exitCode: number; output: string } {
  const { compilerOptions } = readBackendTsconfig();
  const root = mkdtempSync(join(backendRoot, ".typecheck-selftest-"));
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", name), body);
    const configPath = join(root, "tsconfig.json");
    writeFileSync(configPath, JSON.stringify({ compilerOptions, include: ["tests/**/*.ts"] }, null, 2));
    return runTsc(root, configPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("backend/tests/**/*.ts is genuinely typechecked (issue #454)", () => {
  test("the tsc binary these tests spawn actually exists — a missing binary would make every result below vacuous", () => {
    expect(existsSync(TSC)).toBe(true);
  });

  test("backend/tsconfig.json's include actually covers tests/**/*.ts, not just src/**/*.ts", () => {
    expect(existsSync(backendTsconfigPath)).toBe(true);
    const { include } = readBackendTsconfig();
    expect(include).toContain("src/**/*.ts");
    expect(include).toContain("tests/**/*.ts");
  });

  test("backend's typecheck script is exactly `tsc --noEmit` — `cd backend && bun run typecheck` really runs the widened config", () => {
    const pkg = JSON.parse(readFileSync(join(backendRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
  });

  test("backend.yml's CI job runs `bun run typecheck` inside backend/ — the widened include is actually gated in CI, not just locally", () => {
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "backend.yml"), "utf8");
    expect(wf).toMatch(/working-directory:\s*backend[\s\S]*?run:\s*bun run typecheck/);
  });

  // `tsc --noEmit` over the full backend (src/** + tests/**, ~100+ files) takes
  // several seconds — comfortably over bun:test's default 5s per-test timeout —
  // so this gets a generous explicit budget rather than a flaky race.
  test(
    "the REAL repo passes: backend/tsconfig.json's own config exits 0 with backend/tests/** in scope",
    () => {
      const r = runTsc(backendRoot, backendTsconfigPath);
      expect(r.output, r.output).toBe("");
      expect(r.exitCode).toBe(0);
    },
    30_000,
  );

  // ── the must-fail negative control ─────────────────────────────────────────
  test("a field reference that doesn't exist on its declared type, under a tests/-shaped path, FAILS tsc --noEmit — the include is not vacuously passing", () => {
    const r = typecheckFixture(
      "broken.ts",
      [
        "const thing: { value: number } = { value: 1 };",
        "// Deliberately reference a field NOT on the declared type — the",
        "// must-fail control for issue #454's self-test.",
        "export const bogus = thing.doesNotExist;",
        "",
      ].join("\n"),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("doesNotExist");
    expect(r.output).toMatch(/error TS2339/);
  });

  test("a CLEAN fixture under the same tests/-shaped path and config PASSES — the must-fail control isn't failing for an unrelated reason", () => {
    const r = typecheckFixture("clean.ts", "const thing: { value: number } = { value: 1 };\nexport const ok = thing.value;\n");
    expect(r.output, r.output).toBe("");
    expect(r.exitCode).toBe(0);
  });
});

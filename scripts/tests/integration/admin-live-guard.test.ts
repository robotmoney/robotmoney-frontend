// Execution-evidence guard for frontend/test/browser/admin-live.spec.ts
// (issue #185 — closes the #159 mocked-suite blind spot: admin-view.spec.ts /
// admin-surface.spec.ts mock 100% of admin network calls, so a real backend
// contract change can ship undetected). Mirrors the nightly-fetchers-
// guard.test.ts pattern (test-coverage policy invariant 1: loud-skip, never
// silent-skip) for this spec's own module-load guard.
//
// This suite proves, by ACTUALLY RUNNING the real `bun run test:browser`
// entrypoint (the exact command scripts/lib/smoke-main.ts's "browser checks"
// step invokes), both directions:
//   - NEGATIVE: without BACKEND_URL/ADMIN_TOKEN, the whole test:browser run
//     fails loudly (non-zero exit) with the guard's own message — never a
//     silent all-skip green.
//   - POSITIVE: with both set, admin-live.spec.ts's tests are discovered by
//     playwright.config.ts's default testDir glob alongside every other
//     frontend/test/browser/*.spec.ts file — i.e. this spec is ALREADY wired
//     into the required e2e job's live-stack boot with no additional CI
//     config, because smoke-main.ts invokes the bare `test:browser` script
//     (playwright test), not an explicit file list.
//
// `--list` only imports/collects test files — it never launches a browser —
// so this runs fine in the `integration` job (bun install, no Chromium).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const specPath = join(repoRoot, "frontend/test/browser/admin-live.spec.ts");

function listBrowserTests(env: Record<string, string | undefined>) {
  const proc = Bun.spawnSync(["bun", "run", "test:browser", "--", "--list"], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("admin-live.spec.ts module-load guard (loud-skip, never silent-skip)", () => {
  test("source carries the BACKEND_URL/ADMIN_TOKEN guard and its loud-skip message", () => {
    const src = readFileSync(specPath, "utf8");
    expect(src).toContain("process.env.BACKEND_URL");
    expect(src).toContain("process.env.ADMIN_TOKEN");
    expect(src).toContain("refusing an all-skip false-green run");
  });

  test("`bun run test:browser` fails non-zero with the guard's own message when BACKEND_URL/ADMIN_TOKEN are unset", () => {
    const env = { ...process.env };
    delete env.BACKEND_URL;
    delete env.ADMIN_TOKEN;

    const { exitCode, stderr, stdout } = listBrowserTests(env);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "admin-live.spec.ts requires BACKEND_URL and ADMIN_TOKEN in the environment",
    );
    expect(stderr).toContain("refusing an all-skip false-green run");
    // The loud failure aborts collection of every spec file, not just this
    // one — proving it is never a silent, isolated skip of admin-live alone.
    expect(stdout).toContain("Total: 0 tests in 0 files");
  }, 60_000);

  test("`bun run test:browser` discovers admin-live.spec.ts's tests when BACKEND_URL/ADMIN_TOKEN are set — no extra CI wiring needed", () => {
    const env = { ...process.env, BACKEND_URL: "http://127.0.0.1:8787", ADMIN_TOKEN: "guard-test-dummy-token" };

    const { exitCode, stdout, stderr } = listBrowserTests(env);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("should not import test file");
    expect(stdout).toContain("admin-live.spec.ts");
    expect(stdout).toMatch(/Total: \d+ tests in \d+ files/);
    const totalMatch = stdout.match(/Total: (\d+) tests/);
    expect(totalMatch).not.toBeNull();
    expect(Number(totalMatch?.[1])).toBeGreaterThan(0);
  }, 60_000);
});

describe("admin-live.spec.ts is wired into the required e2e job's live-stack boot", () => {
  test("playwright.config.ts's testDir covers frontend/test/browser, where admin-live.spec.ts lives", () => {
    const config = readFileSync(join(repoRoot, "playwright.config.ts"), "utf8");
    expect(config).toContain('testDir: "./frontend/test/browser"');
  });

  test("scripts/lib/smoke-main.ts's 'browser checks' step runs the real `test:browser` script with BACKEND_URL and ADMIN_TOKEN exported explicitly", () => {
    const src = readFileSync(join(repoRoot, "scripts/lib/smoke-main.ts"), "utf8");

    // Issue #456: smoke-main.ts no longer mutates process.env.ADMIN_TOKEN
    // globally (the 2026-07-14 maintainability review's flagged
    // module-level-mutable-state shape) — every child process that needs the
    // admin token, including this one, now gets it as an explicit
    // `ADMIN_TOKEN: adminPassword` entry in its OWN spawn env instead of
    // inheriting it off a prior same-process mutation via `...process.env`.
    expect(src).not.toContain("process.env.ADMIN_TOKEN =");

    const browserStepIdx = src.indexOf('"browser checks"');
    expect(browserStepIdx).toBeGreaterThan(-1);

    // The step block itself: `run(["bun", "run", "test:browser"], repoRoot,
    // { ...process.env, BACKEND_URL: backendUrl, ADMIN_TOKEN: adminPassword }
    // ..., "browser checks")`.
    const stepStart = src.lastIndexOf("await run(", browserStepIdx);
    const stepBlock = src.slice(stepStart, browserStepIdx + '"browser checks"'.length);
    expect(stepBlock).toContain('"test:browser"');
    expect(stepBlock).toContain("BACKEND_URL: backendUrl");
    expect(stepBlock).toContain("ADMIN_TOKEN: adminPassword");
    expect(stepBlock).toContain("...process.env");
  });
});

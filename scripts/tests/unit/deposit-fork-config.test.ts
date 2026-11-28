// The deposit fork spec (issue 1778) needs anvil, which only web-client.yml's
// deposit-fork job installs. Every other Playwright run uses the default
// config, so that config must never load it: its testDir is
// frontend/test/browser, and the fork spec lives in frontend/test/deposit-fork.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// admin-live.spec.ts refuses to load without these (its loud-skip guard);
// `--list` only collects, so placeholders do, as in admin-live-guard.test.ts.
const env = { ...process.env, BACKEND_URL: "http://127.0.0.1:8787", RM_OPERATOR_TOKEN_FILE: "/nonexistent/deposit-fork-list-token" };

const list = (...args: string[]) => {
  const r = spawnSync("bunx", ["playwright", "test", "--list", ...args], { cwd: repoRoot, env, encoding: "utf8", timeout: 120_000 });
  expect(r.status, `playwright --list failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
  return r.stdout;
};

describe("the deposit fork spec stays out of the default Playwright config", () => {
  test("bunx playwright test --list (default config) lists no deposit-fork file", () => {
    const out = list();
    // Not vacuous: the default config lists its own specs.
    expect(out).toContain("deposit-wallet.spec.ts");
    expect(out).not.toContain("deposit-fork");
  }, 120_000);

  test("the fork config lists the fork spec's two tests", () => {
    const out = list("--config", "playwright.fork.config.ts");
    expect(out).toContain("deposit-fork.spec.ts");
    expect(out).toMatch(/Total: 2 tests in 1 file/);
  }, 120_000);
});

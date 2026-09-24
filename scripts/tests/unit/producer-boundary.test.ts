import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComposeEnv, DEFAULT_COMPOSE_FILES, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/config.ts";
import { provisionSmokeAnalyticsToken, removeSmokeAnalyticsToken } from "../../lib/smoke-secret.ts";
import { instancePaths } from "../../lib/smoke-state.ts";

const repo = join(import.meta.dir, "../../..");

describe("issue #361 independent producer credential boundary", () => {
  test("compose gives the bearer only to API verifier and analytics-producer", () => {
    const compose = readFileSync(join(repo, "docker-compose.yml"), "utf8");
    const workerBlock = compose.slice(compose.indexOf("x-worker-env:"), compose.indexOf("services:"));
    expect(workerBlock).not.toContain("ANALYTICS_TOKEN");
    const producer = compose.slice(compose.indexOf("  analytics-producer:"), compose.indexOf("  # D21"));
    expect(producer).toContain("ANALYTICS_TOKEN_FILE: /run/secrets/analytics_token");
    expect(producer).not.toMatch(/^[ \t]*DATABASE_URL:/m);
    expect(producer).not.toContain("ADMIN_TOKEN");
  });

  test("file-backed stacks do not place the analytics bearer value in compose child env", () => {
    const cfg: StackConfig = {
      repoRoot: "/repo", project: "p", profile: "full", composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: { adminToken: "admin", automationToken: "automation", analyticsToken: "must-not-leak", analyticsTokenFile: "/run/private/token" },
      environment: { class: "local", hash: "0123456789" },
    };
    const env = buildComposeEnv(cfg);
    expect(env.ANALYTICS_TOKEN).toBe("");
    expect(Object.values(env)).not.toContain("must-not-leak");
    expect(env.ANALYTICS_TOKEN_FILE_HOST).toBe("/run/private/token");
  });

  // Spec §3 (issue #1026, criterion 40): a service token is a file in the
  // INSTANCE's state directory, per holder — not the checkout, and not an
  // os.tmpdir() directory no instance owns (the previous location).
  test("smoke provisions the analytics token in the instance's own token directory and teardown removes only it", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-producer-boundary-"));
    try {
      const paths = instancePaths(root, "rm_local_secret_test", { create: true });
      const other = instancePaths(root, "rm_local_other", { create: true });
      const token = "test-token-never-log";
      const tokenFile = provisionSmokeAnalyticsToken(paths, token);
      expect(tokenFile).toBe(paths.tokenFiles["analytics-producer"]);
      expect(tokenFile.startsWith(repo)).toBe(false);
      expect(readFileSync(tokenFile, "utf8")).toBe(`${token}\n`);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      // Red controls: the checkout path, the retired tmpdir shape, and another
      // instance's token file are all refused.
      expect(removeSmokeAnalyticsToken(join(repo, ".agents", "analytics-token"), paths)).toBe(false);
      expect(removeSmokeAnalyticsToken(join(tmpdir(), "robotmoney-smoke-p-secrets-abc", "analytics-token"), paths)).toBe(false);
      expect(removeSmokeAnalyticsToken(tokenFile, other)).toBe(false);
      expect(existsSync(tokenFile)).toBe(true);
      expect(removeSmokeAnalyticsToken(tokenFile, paths)).toBe(true);
      expect(existsSync(tokenFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const smoke = readFileSync(join(repo, "scripts/lib/smoke-main.ts"), "utf8");
    const down = readFileSync(join(repo, "scripts/smoke-down.ts"), "utf8");
    expect(smoke).toContain("provisionSmokeAnalyticsToken(paths, analyticsToken)");
    expect(smoke).not.toMatch(/join\(repoRoot,\s*["']\.agents["'][^\n]*analytics-token/);
    expect(smoke).toContain("removeSmokeAnalyticsToken(analyticsTokenFile, paths)");
    expect(down).toContain("removeSmokeAnalyticsToken(s.analyticsTokenFile, paths)");
  });

  test("a failing model/pre-stack preflight creates no bearer: the boot writes it only after the plan", () => {
    // The inference preflight runs at module scope and exits on refusal; the
    // bearer is written inside main(), by the `instance` preparation that
    // follows the journaled plan phase (spec §1.2: nothing before the plan).
    const smoke = readFileSync(join(repo, "scripts/lib/smoke-main.ts"), "utf8");
    const preflight = smoke.indexOf("preflightInferenceOrExit(");
    const main = smoke.indexOf("async function main(");
    const planPhase = smoke.indexOf('await begin("plan"');
    const provision = smoke.indexOf("provisionSmokeAnalyticsToken(paths, analyticsToken)");
    expect(preflight).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(preflight);
    expect(planPhase).toBeGreaterThan(main);
    expect(provision).toBeGreaterThan(planPhase);
  });
});

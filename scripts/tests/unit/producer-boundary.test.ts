import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildComposeEnv, DEFAULT_COMPOSE_FILES, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/config.ts";
import {
  provisionSmokeAnalyticsToken,
  provisionSmokeAnalyticsTokenAfterPreflight,
  removeSmokeAnalyticsToken,
} from "../../lib/smoke-secret.ts";

const repo = join(import.meta.dir, "../../..");

describe("issue #361 independent producer credential boundary", () => {
  test("compose gives the bearer only to API verifier and analytics-producer", () => {
    const compose = readFileSync(join(repo, "docker-compose.yml"), "utf8");
    const workerBlock = compose.slice(compose.indexOf("x-worker-env:"), compose.indexOf("services:"));
    expect(workerBlock).not.toContain("ANALYTICS_TOKEN");
    const producer = compose.slice(compose.indexOf("  analytics-producer:"), compose.indexOf("  # D21"));
    expect(producer).toContain("ANALYTICS_TOKEN_FILE: /run/secrets/analytics_token");
    expect(producer).not.toContain("DATABASE_URL");
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

  test("smoke provisions the analytics token outside the repo and lifecycle teardown removes it", () => {
    const project = "rm_smoke_stack_secret_test";
    const token = "test-token-never-log";
    const tokenFile = provisionSmokeAnalyticsToken(project, token);
    expect(dirname(dirname(tokenFile))).toBe(resolve(tmpdir()));
    expect(tokenFile.startsWith(repo)).toBe(false);
    expect(readFileSync(tokenFile, "utf8")).toBe(`${token}\n`);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(removeSmokeAnalyticsToken(join(repo, ".agents", "analytics-token"), project)).toBe(false);
    expect(removeSmokeAnalyticsToken(tokenFile, "different-project")).toBe(false);
    expect(removeSmokeAnalyticsToken(tokenFile, project)).toBe(true);
    expect(existsSync(tokenFile)).toBe(false);

    const smoke = readFileSync(join(repo, "scripts/lib/smoke-main.ts"), "utf8");
    const down = readFileSync(join(repo, "scripts/smoke-down.ts"), "utf8");
    expect(smoke).toContain("provisionSmokeAnalyticsTokenAfterPreflight(project, analyticsToken");
    expect(smoke).not.toMatch(/join\(repoRoot,\s*["']\.agents["'][^\n]*analytics-token/);
    expect(smoke).toContain("removeSmokeAnalyticsToken(analyticsTokenFile, project)");
    expect(down).toContain("removeSmokeAnalyticsToken(s.analyticsTokenFile, s.project)");
  });

  test("a failing model/pre-stack preflight creates no temporary bearer", () => {
    const project = `rm_smoke_stack_preflight_${Date.now()}`;
    expect(() => provisionSmokeAnalyticsTokenAfterPreflight(project, "never-written", () => {
      throw new Error("model preflight failed");
    })).toThrow("model preflight failed");
    const tempEntries = Array.from(new Bun.Glob(`robotmoney-smoke-${project}-secrets-*`).scanSync(tmpdir()));
    expect(tempEntries).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildDemoLifecycleComposeEnv } from "../../lib/demo-lifecycle-env.ts";
import { provisionDemoAnalyticsToken, removeDemoAnalyticsToken } from "../../lib/demo-secret.ts";
import { cleanupKeptCommitteeEval, committeeEvalStateFile } from "../../committee-eval-local.ts";

const state = {
  project: "rm_demo_stack_fresh_shell",
  composeFiles: "docker-compose.yml:docker-compose.demo.yml",
  databaseUrl: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
  dbUser: "robotmoney",
  dbPassword: "robotmoney",
  dbName: "robotmoney",
  envClass: "local",
  envHash: "0123456789",
};

describe("demo token lifecycle", () => {
  test("status/down compose env works from a fresh shell and strips stale ambient token values", () => {
    const fresh = buildDemoLifecycleComposeEnv(state, { PATH: "/usr/bin" });
    expect(fresh.COMPOSE_PROJECT_NAME).toBe(state.project);
    expect(fresh.ANALYTICS_TOKEN_FILE_HOST).toBeUndefined();
    expect(fresh.ANALYTICS_TOKEN).toBeUndefined();

    const stale = buildDemoLifecycleComposeEnv(state, {
      ANALYTICS_TOKEN_FILE_HOST: "/already/cleaned/token",
      ANALYTICS_TOKEN: "must-not-survive",
    });
    expect(stale.ANALYTICS_TOKEN_FILE_HOST).toBeUndefined();
    expect(stale.ANALYTICS_TOKEN).toBeUndefined();
  });

  test("committee eval --keep state makes token cleanup discoverable and tolerates an already-missing file", () => {
    const repo = mkdtempSync(join(tmpdir(), "rm-kept-eval-state-"));
    const project = `rm_eval_keep_${Date.now()}`;
    const tokenFile = provisionDemoAnalyticsToken(project, "secret");
    const stateFile = committeeEvalStateFile(repo, project);
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      project,
      analyticsTokenFile: tokenFile,
      composeFiles: ["docker-compose.yml", "docker-compose.demo.yml"],
      envClass: "local",
      envHash: "0123456789",
      createdAt: new Date().toISOString(),
    }));
    expect(removeDemoAnalyticsToken(tokenFile, project)).toBe(true);

    let invoked = false;
    cleanupKeptCommitteeEval(repo, project, {}, (argv, env) => {
      invoked = true;
      expect(argv).toContain("down");
      expect(argv).toContain("--volumes");
      expect(env.ANALYTICS_TOKEN_FILE_HOST).toBeUndefined();
      return 0;
    });

    expect(invoked).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});

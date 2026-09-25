import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSmokeLifecycleComposeEnv } from "../../lib/smoke-lifecycle-env.ts";
import { throwawayInstance } from "../../lib/smoke-state.ts";
import { cleanupKeptSwarmEval, swarmEvalStateFile } from "../../swarm-eval-local.ts";

const state = {
  project: "rm_smoke_stack_fresh_shell",
  composeFiles: "docker-compose.yml:docker-compose.smoke.yml",
  databaseUrl: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
  dbUser: "robotmoney",
  dbPassword: "robotmoney",
  dbName: "robotmoney",
  envClass: "local",
  envHash: "0123456789",
};

describe("smoke token lifecycle", () => {
  test("status/down compose env works from a fresh shell and strips stale ambient token values", () => {
    const fresh = buildSmokeLifecycleComposeEnv(state, { PATH: "/usr/bin" });
    expect(fresh.COMPOSE_PROJECT_NAME).toBe(state.project);
    expect(fresh.ANALYTICS_TOKEN_FILE_HOST).toBeUndefined();
    expect(fresh.ANALYTICS_TOKEN).toBeUndefined();

    const stale = buildSmokeLifecycleComposeEnv(state, {
      ANALYTICS_TOKEN_FILE_HOST: "/already/cleaned/token",
      ANALYTICS_TOKEN: "must-not-survive",
    });
    expect(stale.ANALYTICS_TOKEN_FILE_HOST).toBeUndefined();
    expect(stale.ANALYTICS_TOKEN).toBeUndefined();
  });

  test("swarm eval --keep cleanup removes the stack's volumes and its whole throwaway state, token files included", () => {
    const repo = mkdtempSync(join(tmpdir(), "rm-kept-eval-state-"));
    const project = `rm_eval_keep_${Date.now()}`;
    const instance = throwawayInstance(project);
    // What stack.up() provisions into a throwaway instance (smoke spec §3).
    writeFileSync(instance.paths.tokenFiles.operator, "rmat_operator\n", { mode: 0o600 });
    const stateFile = swarmEvalStateFile(repo, project);
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      project,
      stateDir: instance.stateDir,
      composeFiles: ["docker-compose.yml", "docker-compose.smoke.yml"],
      envClass: "local",
      envHash: "0123456789",
      createdAt: new Date().toISOString(),
    }));

    let invoked = false;
    cleanupKeptSwarmEval(repo, project, {}, (argv, env) => {
      invoked = true;
      expect(argv).toContain("down");
      expect(argv).toContain("--volumes");
      expect(env.ANALYTICS_TOKEN_FILE_HOST).toBeUndefined();
      return 0;
    });

    expect(invoked).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    // The token rows went with the volume; the files that matched them go too.
    expect(existsSync(instance.paths.tokenFiles.operator)).toBe(false);
    expect(existsSync(instance.stateDir)).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});

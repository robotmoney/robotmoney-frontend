// Which stack a gate grades (scripts/lib/gate/stack.ts): the instance's own
// stack record, selected by --instance, never a name the gate composes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePaths, writeStackState, type StackStateRecord } from "../../lib/smoke-state.ts";
import { resolveGateStack } from "../../lib/gate/stack.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function host(instances: Record<string, Partial<StackStateRecord> | null>): { env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "rm-gate-stack-"));
  roots.push(root);
  for (const [name, record] of Object.entries(instances)) {
    const paths = instancePaths(root, name, { create: true });
    if (record) {
      writeStackState(paths, {
        instance: name, project: `proj_${name}`, apiPort: 1, webPort: 2, pgPort: null, stage: false, envClass: "t", envHash: "h",
        composeFiles: "docker-compose.yml", db: "external", externalPg: true, databaseUrl: "REDACTED", dbUser: "u", dbPassword: "p",
        dbName: "d", logFile: "l", createdAt: "2026-10-03T00:00:00Z", ...record,
      });
    }
  }
  return { env: { RM_SMOKE_STATE_ROOT: root } };
}

const apiOf = (project: string, service: string) => (service === "api" ? `${project}-api-1` : null);

describe("resolveGateStack", () => {
  test("takes the compose project and the api container from the instance's stack record", () => {
    const { env } = host({ rm_prod: { db: "external" } });
    const s = resolveGateStack([], env, ["external"], { serviceContainer: apiOf });
    expect(s.project).toBe("proj_rm_prod");
    expect(s.api).toBe("proj_rm_prod-api-1");
    expect(s.instance).toBe("rm_prod");
  });

  test("--instance picks one of several instances; none given with several refuses to guess", () => {
    const { env } = host({ alpha: { db: "external" }, beta: { db: "external" } });
    expect(resolveGateStack(["--instance", "beta"], env, ["external"], { serviceContainer: apiOf }).project).toBe("proj_beta");
    expect(() => resolveGateStack([], env, ["external"], { serviceContainer: apiOf })).toThrow("several instances");
    expect(() => resolveGateStack(["--instance", "gamma"], env, ["external"], { serviceContainer: apiOf })).toThrow("no state");
  });

  test("an instance that never brought a stack up has nothing to grade", () => {
    const { env } = host({ rm_prod: null });
    expect(() => resolveGateStack([], env, ["external"], { serviceContainer: apiOf })).toThrow("no stack record");
  });

  test("a twin gate refuses a production stack, and prod:gate refuses a twin", () => {
    const { env } = host({ rm_prod: { db: "external" } });
    expect(() => resolveGateStack([], env, ["smoke-twin"], { serviceContainer: apiOf })).toThrow("db=external");
    const twin = host({ rm_twin: { db: "smoke-twin" } });
    expect(() => resolveGateStack([], twin.env, ["external"], { serviceContainer: apiOf })).toThrow("db=smoke-twin");
    expect(resolveGateStack([], twin.env, ["smoke-twin"], { serviceContainer: apiOf }).record.db).toBe("smoke-twin");
  });

  test("a project with no api container refuses", () => {
    const { env } = host({ rm_prod: { db: "external" } });
    expect(() => resolveGateStack([], env, ["external"], { serviceContainer: () => null })).toThrow("no api container");
  });
});

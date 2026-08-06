import { describe, expect, test } from "bun:test";
import {
  DEMO_MIGRATE_ENV,
  DEMO_MIGRATE_SCRIPT_ARGS,
  SMOKE_MEMBERS,
  SMOKE_MIGRATE_ENV,
  SMOKE_MIGRATE_SCRIPT_ARGS,
  SMOKE_SUBJECTS,
  adoptRestoredRoster,
  bootstrapStepNames,
  isSmokeMode,
  runScenarioLifecycle,
  runsNewcomerOnboarding,
  scenarioPlan,
} from "../../lib/smoke-mode.ts";

describe("smoke mode decisions", () => {
  test("argv selects smoke explicitly", () => {
    expect(isSmokeMode(["bun", "demo.ts", "--smoke"])).toBe(true);
    expect(isSmokeMode(["bun", "demo.ts"])).toBe(false);
  });

  test("smoke omits demo seed actions while normal demo requests them narrowly", () => {
    expect(SMOKE_MIGRATE_ENV).toEqual({});
    expect(SMOKE_MIGRATE_SCRIPT_ARGS).toEqual([]);
    expect(DEMO_MIGRATE_ENV).toEqual({ DEMO_SEED_PROJECTS: "1" });
    expect(DEMO_MIGRATE_SCRIPT_ARGS).toEqual(["--seed-demo-schedules"]);
  });

  test("smoke uses restored subjects/personas and no newcomer narrative", () => {
    expect(SMOKE_SUBJECTS).toHaveLength(4);
    expect(SMOKE_MEMBERS.map((m) => m.name)).toEqual(["Athena", "Robot Money", "Noop analyst"]);
    expect(bootstrapStepNames(true)).toEqual(["archive restore"]);
    expect(bootstrapStepNames(false)).toEqual(["simulation seed"]);
    expect(runsNewcomerOnboarding(true)).toBe(false);
    expect(runsNewcomerOnboarding(false)).toBe(true);
  });

  test("typed initializers separate simulation data from archive continuity", () => {
    const demo = scenarioPlan(false);
    const smoke = scenarioPlan(true);
    expect(demo.initializer).toBe("simulation");
    expect(demo.migrateEnv).toEqual({ DEMO_SEED_PROJECTS: "1" });
    expect(demo.migrateScriptArgs).toEqual(["--seed-demo-schedules"]);
    expect(demo.members.length).toBeGreaterThan(0);
    expect(smoke.initializer).toBe("archive");
    expect(smoke.migrateEnv).toEqual({});
    expect(smoke.migrateScriptArgs).toEqual([]);
    expect(smoke.members).toEqual([]);
  });

  test("demo and smoke execute the same lifecycle order with one migration; only initializer differs", async () => {
    const run = async (smoke: boolean) => {
      const events: string[] = [];
      let migrations = 0;
      await runScenarioLifecycle(scenarioPlan(smoke), {
        async up(_plan, initialize) {
          events.push("build", "start", "migrate");
          migrations++;
          await initialize();
          events.push("ready");
          return {};
        },
        async initialize(plan) { events.push(`initialize:${plan.initializer}`); },
        async ready() { events.push("ready-readback"); },
        async session() { events.push("session"); return "published"; },
        async assert() { events.push("assert"); },
        async cleanup() { events.push("cleanup"); },
      });
      return { events, migrations };
    };
    const demo = await run(false);
    const smoke = await run(true);
    expect(demo.migrations).toBe(1);
    expect(smoke.migrations).toBe(1);
    expect(demo.events.map((e) => e.startsWith("initialize:") ? "initialize" : e))
      .toEqual(smoke.events.map((e) => e.startsWith("initialize:") ? "initialize" : e));
    expect(demo.events).toContain("initialize:simulation");
    expect(smoke.events).toContain("initialize:archive");
  });

  test("restored roster adoption returns fresh seats with no cross-run leakage", () => {
    const roster = SMOKE_MEMBERS.map((member) => ({ ...member, lens: null, status: "active" }));
    const first = adoptRestoredRoster(scenarioPlan(true), roster);
    first.push({ memberId: "leak", name: "Leak", lens: "bad", bias: 0, present: true });
    const second = adoptRestoredRoster(scenarioPlan(true), roster);
    expect(second.map((member) => member.memberId).sort()).toEqual(SMOKE_MEMBERS.map((member) => member.id).sort());
  });
});

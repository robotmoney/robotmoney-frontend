// EXECUTED coverage of the populated-database guard's ONE guarantee: when the
// preflight refuses, nothing is written.
//
// "Nothing is written" is not a property of the preflight script — it is a
// property of WHERE up() calls it. migrate() is the first step that writes (it
// seeds job schedules, cold-start jobs, the wallet backfill and the allocation
// framework, not just DDL), so a guard that runs after it is decoration. These
// tests run the real up() against a fake runtime and assert on the compose
// argv it actually issued.
import { expect, test } from "bun:test";
import { createStack, type StackRuntime } from "../../stack/stack.ts";
import { API_CONTAINER_PORT, type StackConfig } from "../../stack/config.ts";
import { DB_PREFLIGHT_ARGV, DB_PREFLIGHT_STEP, dbPreflightArgv } from "../../lib/demo-external-pg.ts";

const config: StackConfig = {
  repoRoot: "/nonexistent-by-design",
  project: "stack_preflight_test",
  profile: "core",
  composeFiles: ["docker-compose.yml"],
  database: { user: "u", password: "p", name: "d" },
  credentials: { adminToken: "admin", automationToken: "automation", analyticsToken: "analytics" },
  environment: { class: "ci", hash: "0123456789" },
};

function runtimeRecording(calls: string[][]): StackRuntime {
  return {
    runSync(argv) {
      if (argv.includes("port")) {
        const port = argv.includes(String(API_CONTAINER_PORT)) ? "40001" : "40002";
        return { exitCode: 0, stdout: `0.0.0.0:${port}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async run(argv) {
      calls.push(argv);
      return 0;
    },
    async probe() {
      return { ok: true, detail: "ok" };
    },
  };
}

const ranMigrate = (calls: string[][]) => calls.some((c) => c.some((a) => a.includes("migrate")));

test("a refusing preflight aborts BEFORE migrate — the first step that writes", async () => {
  const calls: string[][] = [];
  const stack = createStack(config, { runtime: runtimeRecording(calls) });

  await expect(
    stack.up({
      preflight: async () => {
        throw new Error("[db-preflight] REFUSING to bootstrap: 55 table(s) in public");
      },
    }),
  ).rejects.toThrow(/REFUSING to bootstrap/);

  expect(ranMigrate(calls)).toBe(false);
});

test("a passing preflight lets the boot proceed to migrate", async () => {
  const calls: string[][] = [];
  const stack = createStack(config, { runtime: runtimeRecording(calls) });

  await stack.up({ preflight: async () => {} });

  expect(ranMigrate(calls)).toBe(true);
});

test("no preflight supplied — an ordinary ephemeral boot is unaffected", async () => {
  const calls: string[][] = [];
  const stack = createStack(config, { runtime: runtimeRecording(calls) });

  await stack.up({});

  expect(ranMigrate(calls)).toBe(true);
});

test("the preflight runs after build, so the image it needs exists", async () => {
  const order: string[] = [];
  const calls: string[][] = [];
  const stack = createStack(config, { runtime: runtimeRecording(calls) });

  await stack.up({
    preflight: async () => {
      order.push(`preflight-after-${calls.length}-compose-calls`);
      order.push(calls.some((c) => c.includes("build")) ? "build-ran" : "build-missing");
    },
  });

  expect(order).toContain("build-ran");
});

test("DB_PREFLIGHT_ARGV asks the question without dragging up dependencies", () => {
  expect(DB_PREFLIGHT_ARGV).toContain("--no-deps");
  expect(DB_PREFLIGHT_ARGV).toContain("--rm");
  expect(DB_PREFLIGHT_ARGV).toContain("api");
  expect(DB_PREFLIGHT_ARGV.join(" ")).toContain("scripts/db-preflight.ts");
});

test("the guard has a step name the TUI can mark failed", () => {
  expect(DB_PREFLIGHT_STEP.trim().length).toBeGreaterThan(0);
});

test("dbPreflightArgv carries the boot's initializer to the classifier", () => {
  // The initializer decides whether a populated database is adopted (archive:
  // idempotent, non-clobbering seed) or refused (simulation: demo fixtures
  // overwrite by design). db-preflight.ts treats a MISSING flag as simulation,
  // so this argv is the only thing standing between an archive boot and the
  // strict branch — it must spell the mode out explicitly.
  expect(dbPreflightArgv("archive")).toEqual([...DB_PREFLIGHT_ARGV, "--initializer=archive"]);
  expect(dbPreflightArgv("simulation")).toEqual([...DB_PREFLIGHT_ARGV, "--initializer=simulation"]);
});

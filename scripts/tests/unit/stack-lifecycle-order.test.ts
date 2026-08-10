// EXECUTED coverage of scripts/stack/stack.ts's `up()` phase ordering.
//
// This file exists because its predecessor did not execute anything. The
// ordering guarantee "scenario initialization runs only after the API answers
// /health" used to be checked by reading demo-main.ts's SOURCE and comparing
// the byte offsets of two string literals. That check was not merely weak, it
// was WRONG: initialization is passed to `up()` as a callback, so
// `initializeScenario` is written above the `await stack.up(...)` that invokes
// it, and the text scan reported a correctly ordered boot as a regression. It
// failed on the branch for exactly that reason.
//
// The real invariant is about WHEN things run, so these tests run them. A fake
// StackRuntime stands in for the three primitives that leave the process
// (docker sync, docker async, HTTP probe); everything asserted below —
// sequencing, the health gate, failure propagation — is the real `up()`.
import { expect, test } from "bun:test";
import { createStack, type StackRuntime } from "../../stack/stack.ts";
import { API_CONTAINER_PORT, POSTGRES_CONTAINER_PORT, type StackConfig } from "../../stack/config.ts";

const config: StackConfig = {
  repoRoot: "/nonexistent-by-design",
  project: "stack_lifecycle_order_test",
  // `core`, not `full`: a full stack additionally demands a readable analytics
  // credential FILE on disk, which would drag a fixture into a test about
  // ordering. Profile does not participate in the sequencing under test.
  profile: "core",
  composeFiles: ["docker-compose.yml"],
  database: { user: "u", password: "p", name: "d" },
  credentials: { adminToken: "admin", automationToken: "automation", analyticsToken: "analytics" },
  environment: { class: "ci", hash: "0123456789" },
};

interface Recorded {
  events: string[];
  probes: number;
}

// A runtime that succeeds at everything and records what it was asked to do.
// `docker compose port` is the one call whose OUTPUT is parsed, so it answers
// in the daemon's real format.
function fakeRuntime(rec: Recorded, overrides: Partial<StackRuntime> = {}): StackRuntime {
  return {
    runSync(argv) {
      if (argv.includes("port")) {
        const port = argv.includes(String(API_CONTAINER_PORT)) ? "40001" : "40002";
        return { exitCode: 0, stdout: `0.0.0.0:${port}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async run() {
      return 0;
    },
    async probe() {
      rec.probes += 1;
      return { ok: true, detail: "ok" };
    },
    ...overrides,
  };
}

function stackFor(rec: Recorded, overrides: Partial<StackRuntime> = {}) {
  return createStack(config, {
    runtime: fakeRuntime(rec, overrides),
    hooks: { onEvent: (e) => { if (e.phase !== "log") rec.events.push(`${e.phase}:${e.status}`); } },
  });
}

test("up() initializes the scenario only AFTER the API answers /health", async () => {
  const rec: Recorded = { events: [], probes: 0 };
  let probesWhenInitializeRan = -1;

  await stackFor(rec).up({
    initialize: async () => {
      // The whole point: by the time an initializer runs, the health gate has
      // already been satisfied. The archive initializer talks to the api over
      // the compose network, so a boot that inverts this races the server.
      probesWhenInitializeRan = rec.probes;
    },
  });

  expect(probesWhenInitializeRan).toBeGreaterThan(0);

  const order = rec.events.filter((e) => e.endsWith(":done")).map((e) => e.split(":")[0]);
  expect(order).toEqual([
    "docker-preflight",
    "build",
    "postgres",
    "migrate",
    "services",
    "ports",
    "health",
    "initialize",
  ]);
});

test("up() runs exactly one migration, and it precedes initialization", async () => {
  const rec: Recorded = { events: [], probes: 0 };
  const composeCalls: string[][] = [];

  await stackFor(rec, {
    async run(argv) {
      composeCalls.push(argv);
      return 0;
    },
  }).up({ initialize: async () => { composeCalls.push(["<initialize>"]); } });

  const migrateIdx = composeCalls.findIndex((a) => a.some((s) => s.includes("migrate")));
  const initIdx = composeCalls.findIndex((a) => a[0] === "<initialize>");
  expect(migrateIdx).toBeGreaterThan(-1);
  expect(initIdx).toBeGreaterThan(migrateIdx);
  expect(composeCalls.filter((a) => a.some((s) => s.includes("migrate")))).toHaveLength(1);
});

test("a never-healthy API fails the boot and the initializer never runs", async () => {
  const rec: Recorded = { events: [], probes: 0 };
  let initialized = false;

  await expect(
    stackFor(rec, { async probe() { return { ok: false, detail: "connection refused" }; } }).up({
      healthTimeoutMs: 40,
      initialize: async () => { initialized = true; },
    }),
  ).rejects.toThrow(/timed out waiting for .*health.*connection refused/s);

  // Loud-skip-never: an unreachable API is a failed boot, not a boot that
  // quietly proceeds to initialize against a server that is not answering.
  expect(initialized).toBe(false);
  expect(rec.events).not.toContain("initialize:start");
});

// REGRESSION: up() also shells out to scripts/static-assembly.sh, and that
// spawn originally bypassed the runtime seam. Nothing here caught it, because
// on a developer box `bash` resolves and the script merely fails; on the CI
// runner the spawn itself ENOENTs against the allowlisted PATH and every test
// in this file died on a code path none of them meant to exercise. Asserting
// the assembly runs THROUGH the seam is what keeps the seam total.
test("static assembly is spawned through the runtime seam, before any container work", async () => {
  const rec: Recorded = { events: [], probes: 0 };
  const spawned: string[][] = [];

  await stackFor(rec, {
    async run(argv) {
      spawned.push(argv);
      return 0;
    },
  }).up();

  const assemblyIdx = spawned.findIndex((a) => a.some((s) => s.endsWith("static-assembly.sh")));
  const firstDockerIdx = spawned.findIndex((a) => a[0] === "docker");
  expect(assemblyIdx).toBeGreaterThan(-1);
  expect(firstDockerIdx).toBeGreaterThan(-1);
  expect(assemblyIdx).toBeLessThan(firstDockerIdx);
  // No unseamed child processes: everything up() launched came through here.
  expect(spawned.every((a) => a[0] === "bash" || a[0] === "docker")).toBe(true);
});

test("a failed static assembly aborts the boot before any container starts", async () => {
  const rec: Recorded = { events: [], probes: 0 };
  let dockerRan = false;

  await expect(
    stackFor(rec, {
      async run(argv) {
        if (argv.some((s) => s.endsWith("static-assembly.sh"))) return 3;
        dockerRan = true;
        return 0;
      },
    }).up(),
  ).rejects.toThrow(/static assembly failed .*exited 3/);

  expect(dockerRan).toBe(false);
});

test("up() without an initializer still completes through the health gate", async () => {
  const rec: Recorded = { events: [], probes: 0 };
  const ports = await stackFor(rec).up();

  expect(ports.apiPort).toBe(40001);
  expect(ports.pgPort).toBe(40002);
  expect(rec.events).toContain("health:done");
  expect(rec.events).not.toContain("initialize:done");
});

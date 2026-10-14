// The two setDatabase() TEST SEAMS refuse to run unless the test seam is armed.
//
// WHY THIS IS ITS OWN TEST. db/client.ts and db/worker-client.ts each export a
// function that re-points a long-lived pool at an arbitrary URL. Both were
// documented as test-only and neither enforced it — flagged independently by
// two reviewers on PR #686 (R-003, SEC-005). The worker one is the sharper
// case: it deliberately DROPS the WORKER_DATABASE_URL fallback, so a call in a
// deployed worker moves the process off the restricted `rm_worker` role
// (migrations/0016_worker_role.sql:42) and onto the owner role in
// config.databaseUrl — silently undoing the analytics write boundary that
// tests/analytics-worker-role.test.ts exists to prove.
//
// "Nothing in production ever calls it" is a claim about today's call graph.
// This makes it a property of the function. Issue #973: the gate used to be
// `RM_ENV=ephemeral`, an environment value any process can be handed; it is
// now backend/src/test-seam.ts, armed by tests/preload.ts in THIS process and
// by nothing else. A process that never armed it (the subprocess below, which
// inherits this process's environment, RM_ENV and all) refuses before any
// mutation, whatever its environment says.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { config } from "../src/config.ts";
import * as client from "../src/db/client.ts";
import * as workerClient from "../src/db/worker-client.ts";
import { testSeamArmed } from "../src/test-seam.ts";

const BACKEND_DIR = join(import.meta.dir, "..");

/** Run `script` in a fresh bun process that inherits this one's environment but never arms the seam. */
function unarmed(script: string, env: Record<string, string> = {}): { out: string; code: number; err: string } {
  const proc = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: proc.stdout.toString().trim(), code: proc.exitCode, err: proc.stderr.toString() };
}

const SEAM_SCRIPT = (module: "client" | "worker-client") => `
const { config } = await import("./src/config.ts");
const m = await import("./src/db/${module}.ts");
const before = { databaseUrl: config.databaseUrl, env: process.env.DATABASE_URL, pool: m.sql };
let error = null;
try { await m.setDatabase("postgres://attacker@elsewhere/db"); } catch (e) { error = e.message; }
console.log(JSON.stringify({
  error,
  configUntouched: config.databaseUrl === before.databaseUrl,
  envUntouched: process.env.DATABASE_URL === before.env,
  poolUntouched: m.sql === before.pool,
}));
process.exit(0);
`;

for (const rmEnv of ["ephemeral", "smoke", "prod", undefined]) {
  const label = rmEnv === undefined ? "RM_ENV unset" : `RM_ENV=${rmEnv}`;
  const env: Record<string, string> = rmEnv === undefined ? {} : { RM_ENV: rmEnv };

  test(`db/client.setDatabase() refuses in a process that never armed the seam (${label})`, () => {
    const res = unarmed(SEAM_SCRIPT("client"), env);
    if (res.code !== 0 || !res.out) throw new Error(`subprocess failed (${res.code}): ${res.err}`);
    const parsed = JSON.parse(res.out.split("\n").at(-1)!) as Record<string, unknown>;
    expect(parsed.error).toMatch(/db\/client\.setDatabase\(\) is a test-only seam and this process is not the test harness/);
    // The refusal is BEFORE any mutation — config, process env and the pool are untouched.
    expect(parsed).toMatchObject({ configUntouched: true, envUntouched: true, poolUntouched: true });
  });

  test(`db/worker-client.setDatabase() refuses in a process that never armed the seam (${label})`, () => {
    const res = unarmed(SEAM_SCRIPT("worker-client"), env);
    if (res.code !== 0 || !res.out) throw new Error(`subprocess failed (${res.code}): ${res.err}`);
    const parsed = JSON.parse(res.out.split("\n").at(-1)!) as Record<string, unknown>;
    expect(parsed.error).toMatch(/db\/worker-client\.setDatabase\(\) is a test-only seam and this process is not the test harness/);
    expect(parsed).toMatchObject({ poolUntouched: true });
  });
}

test("both seams work in the armed harness — the suite depends on it", async () => {
  // Positive control. Without this, the tests above would also pass if
  // setDatabase() had been broken outright.
  expect(testSeamArmed()).toBe(true); // armed by tests/preload.ts
  expect(process.env.RM_ENV).toBeUndefined(); // and not by any environment value
  const url = process.env.DATABASE_URL!;
  const before = config.databaseUrl;
  await client.setDatabase(url);
  await workerClient.setDatabase(url);
  expect(config.databaseUrl).toBe(before);
  const [{ db }] = (await client.sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  expect(db).toBe(new URL(url).pathname.slice(1));
});

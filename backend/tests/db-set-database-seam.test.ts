// The two setDatabase() TEST SEAMS refuse to run outside an ephemeral env.
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
// This makes it a property of the function.
import { test, expect, afterEach } from "bun:test";
import { config } from "../src/config.ts";
import * as client from "../src/db/client.ts";
import * as workerClient from "../src/db/worker-client.ts";

const realEnv = config.env;
afterEach(() => { config.env = realEnv; });

for (const env of ["demo", "prod"] as const) {
  test(`db/client.setDatabase() refuses under RM_ENV=${env}`, async () => {
    config.env = env;
    const before = config.databaseUrl;
    await expect(client.setDatabase("postgres://attacker@elsewhere/db")).rejects.toThrow(
      /test-only seam and refuses to run under RM_ENV/,
    );
    // The refusal is BEFORE any mutation — config and process env are untouched.
    expect(config.databaseUrl).toBe(before);
    expect(process.env.DATABASE_URL).toBe(before);
  });

  test(`db/worker-client.setDatabase() refuses under RM_ENV=${env}`, async () => {
    config.env = env;
    const pool = workerClient.sql;
    await expect(workerClient.setDatabase("postgres://attacker@elsewhere/db")).rejects.toThrow(
      /test-only seam and refuses to run under RM_ENV/,
    );
    expect(workerClient.sql).toBe(pool); // the live binding never moved
  });
}

test("both seams still work under RM_ENV=ephemeral — the harness depends on it", async () => {
  // Positive control. Without this, the two tests above would also pass if
  // setDatabase() had been broken outright.
  expect(config.env).toBe("ephemeral"); // set by tests/preload.ts
  const url = process.env.DATABASE_URL!;
  await client.setDatabase(url);
  await workerClient.setDatabase(url);
  const [{ db }] = (await client.sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  expect(db).toBe(new URL(url).pathname.slice(1));
});

// Issue 1184: the buyback refresh job is disabled, its code kept for reference.
//
// buybacks.refresh held the shared analytics worker past its heartbeat budget.
// This file asserts nothing enqueues or runs it on any stack:
//   - migration 0133 disables an enabled schedule row and dead-letters every
//     pending or running job of the kind, and a second run changes nothing;
//   - the worker registers no handler for the kind;
//   - a scheduler tick over the seeded schedules, every one of them due,
//     enqueues no buybacks.refresh job.
// Runs in backend.yml against ephemeral Postgres (tests/preload.ts).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { seedJobSchedules } from "../src/db/seed.ts";
import { getHandler } from "../src/worker/handlers/index.ts";
import { tickScheduler } from "../src/worker/scheduler.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const MIGRATION = readFileSync(join(import.meta.dir, "..", "migrations", "0133_buybacks_refresh_disabled.sql"), "utf8");
const KIND = "buybacks.refresh";

beforeEach(async () => {
  await fixtureDb`DELETE FROM job_runs`;
  await fixtureDb`DELETE FROM jobs`;
  await fixtureDb`DELETE FROM job_schedules`;
});
afterAll(async () => {
  await fixtureDb`DELETE FROM job_runs`;
  await fixtureDb`DELETE FROM jobs`;
  await fixtureDb`DELETE FROM job_schedules`;
  await seedJobSchedules(fixtureDb as never);
});

type JobRow = { id: number; status: string; last_error: string | null; locked_by: string | null };
const readJobs = () =>
  sql<JobRow[]>`SELECT id::int AS id, status, last_error, locked_by FROM jobs ORDER BY id`;
const readSchedule = async (): Promise<{ kind: string; enabled: boolean }[]> =>
  (await sql<{ kind: string; enabled: boolean }[]>`SELECT kind, enabled FROM job_schedules ORDER BY kind`).map((r) => ({ ...r }));

test("the migration disables an enabled buybacks.refresh row and dead-letters its pending and running jobs; a second run changes nothing", async () => {
  // A deployed database before the migration: the row enabled, one job
  // waiting, one claimed, one already settled, and an unrelated kind.
  await fixtureDb`
    INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
    VALUES (${KIND}, '15 */6 * * *', '{}', 'UTC', true),
           ('projects.snapshot_daily', '40 0 * * *', '{}', 'UTC', true)`;
  await fixtureDb`
    INSERT INTO jobs (kind, payload, status, locked_at, locked_by)
    VALUES (${KIND}, '{}', 'pending', NULL, NULL),
           (${KIND}, '{}', 'running', now(), 'worker-analytics-1'),
           (${KIND}, '{}', 'succeeded', NULL, NULL),
           ('projects.snapshot_daily', '{}', 'pending', NULL, NULL)`;

  await fixtureDb.unsafe(MIGRATION);

  expect(await readSchedule()).toEqual([
    { kind: KIND, enabled: false },
    { kind: "projects.snapshot_daily", enabled: true },
  ]);
  const jobs = await readJobs();
  const reason = "buybacks.refresh disabled (issue 1184)";
  expect(jobs.map(({ status, last_error, locked_by }) => ({ status, last_error, locked_by }))).toEqual([
    { status: "dead", last_error: reason, locked_by: null },
    { status: "dead", last_error: reason, locked_by: null },
    { status: "succeeded", last_error: null, locked_by: null },
    { status: "pending", last_error: null, locked_by: null },
  ]);

  // Idempotent: the second run matches no row.
  const before = await sql`SELECT id, status, last_error, updated_at FROM jobs ORDER BY id`;
  await fixtureDb.unsafe(MIGRATION);
  expect(await sql`SELECT id, status, last_error, updated_at FROM jobs ORDER BY id`).toEqual(before);
  expect(await readSchedule()).toEqual([
    { kind: KIND, enabled: false },
    { kind: "projects.snapshot_daily", enabled: true },
  ]);
});

test("no handler is registered for buybacks.refresh", () => {
  expect(getHandler(KIND)).toBeUndefined();
  // Not vacuous: a kind the worker does run resolves.
  expect(getHandler("projects.snapshot_daily")).toBeDefined();
});

test("a scheduler tick over the seeded schedules, every one due, enqueues no buybacks.refresh job", async () => {
  await seedJobSchedules(fixtureDb as never);
  // Every row due: one cron slot just behind now.
  await fixtureDb`UPDATE job_schedules SET next_run_at = now() - interval '1 minute'`;

  const enqueued = await tickScheduler();

  // Not vacuous: the enabled rows did enqueue.
  expect(enqueued).toBeGreaterThan(0);
  const kinds = (await sql<{ kind: string }[]>`SELECT DISTINCT kind FROM jobs ORDER BY kind`).map((r) => r.kind);
  expect(kinds).toContain("wallet.sample_balances");
  expect(kinds).not.toContain(KIND);
});

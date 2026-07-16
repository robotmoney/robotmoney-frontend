import { test, expect, beforeAll, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { reapStuckJobs } from "../src/worker/reaper.ts";
import { tickScheduler } from "../src/worker/scheduler.ts";

beforeAll(() => {
  handlers["test.ok"] = async () => ({ ok: true });
  handlers["test.fail"] = async () => { throw new Error("boom"); };
});
// Isolate each test: clear the queue + schedules so processOneJob claims only our job.
beforeEach(async () => { await sql`TRUNCATE jobs, job_runs, job_schedules RESTART IDENTITY CASCADE`; });

test("processOneJob: success → succeeded + a job_runs row", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('test.ok','{}') RETURNING id`;
  expect(await processOneJob()).toBe(true);
  const [job] = await sql`SELECT status, attempts FROM jobs WHERE id=${id}`;
  expect(job.status).toBe("succeeded");
  expect(job.attempts).toBe(1);
  const runs = await sql`SELECT status FROM job_runs WHERE job_id=${id}`;
  expect(runs.length).toBe(1);
  expect(runs[0].status).toBe("succeeded");
});

test("processOneJob: failure with attempts left → pending with backoff", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('test.fail','{}',5) RETURNING id`;
  await processOneJob();
  const [job] = await sql`SELECT status, attempts, run_after FROM jobs WHERE id=${id}`;
  expect(job.status).toBe("pending");
  expect(job.attempts).toBe(1);
  expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now()); // exponential backoff
  const [{ c }] = await sql`SELECT count(*)::int c FROM job_runs WHERE job_id=${id} AND status='failed'`;
  expect(c).toBe(1);
});

test("processOneJob: failure on the last attempt → dead", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('test.fail','{}',1) RETURNING id`;
  await processOneJob();
  const [job] = await sql`SELECT status FROM jobs WHERE id=${id}`;
  expect(job.status).toBe("dead");
});

test("scheduler: new schedule seeds next_run_at without firing; a due one catches up; idempotent", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled) VALUES ('test.ok','*/5 * * * *', true)`;
  expect(await tickScheduler()).toBe(0); // NULL next_run_at → seed only, no stale fire
  const [seeded] = await sql`SELECT next_run_at FROM job_schedules WHERE kind='test.ok'`;
  expect(seeded.next_run_at).not.toBeNull();

  await sql`UPDATE job_schedules SET next_run_at = now() - interval '20 minutes' WHERE kind='test.ok'`;
  expect(await tickScheduler()).toBeGreaterThan(0); // catch up missed slots
  const [{ c }] = await sql`SELECT count(*)::int c FROM jobs WHERE kind='test.ok'`;
  expect(c).toBeGreaterThan(0);
  expect(await tickScheduler()).toBe(0); // next_run_at now future → nothing new
});

test("reaper: stuck running job is requeued with backoff; exhausted → dead", async () => {
  const [{ id: a }] = await sql`INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
                                VALUES ('test.ok','{}','running', now() - interval '10 minutes','dead-worker',1,5) RETURNING id`;
  const [{ id: b }] = await sql`INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
                                VALUES ('test.fail','{}','running', now() - interval '10 minutes','dead-worker',5,5) RETURNING id`;
  expect(await reapStuckJobs()).toBeGreaterThanOrEqual(2);
  const [ja] = await sql`SELECT status, run_after FROM jobs WHERE id=${a}`;
  expect(ja.status).toBe("pending");
  expect(new Date(ja.run_after).getTime()).toBeGreaterThan(Date.now());
  const [jb] = await sql`SELECT status FROM jobs WHERE id=${b}`;
  expect(jb.status).toBe("dead");
});

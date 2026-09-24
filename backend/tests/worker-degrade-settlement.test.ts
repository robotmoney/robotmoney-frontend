// R16 — a retry-exhausted degrade must settle FAILED and VISIBLE, not succeeded.
//
// Observed on staging (§E.7, job 83): the swarm judge degraded, burned all five
// attempts, and `worker/loop.ts` then settled the job row `status='succeeded'`
// carrying `last_error='judge_unavailable'`. Every surface downstream reads the
// status: the admin overview's production-kind health, the operator's queue
// counts, and the missing-receipt module's own header all had to work around a
// row that says a job which never did its work finished fine.
//
// A terminal degrade — one a retry cannot fix — must not be retried at all.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { LANES } from "../src/worker/lanes.ts";
import { getOverviewProjection, SAMPLER_KINDS } from "../src/admin/overview.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

beforeAll(() => {
  handlers["research.test_degrade"] = async () => ({ ok: false, error: "provider unreachable" });
  handlers["research.test_terminal"] = async () => ({ ok: false, terminal: true, error: "permanently unsatisfiable" });
});
afterAll(() => {
  delete handlers["research.test_degrade"];
  delete handlers["research.test_terminal"];
});
beforeEach(async () => {
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
});

const drain = async (max = 12) => {
  for (let i = 0; i < max; i++) {
    await sql`UPDATE jobs SET run_after = now() WHERE status = 'pending'`;
    if (!(await processOneJob({ lane: LANES.research }))) return;
  }
};

test("a degrade that exhausts its retries settles FAILED, not succeeded", async () => {
  const [{ id }] = await sql`
    INSERT INTO jobs (kind, payload, max_attempts) VALUES ('research.test_degrade', '{}', 3) RETURNING id`;
  await drain();

  const [job] = await sql`SELECT status, attempts, last_error FROM jobs WHERE id = ${id}`;
  expect(job.attempts).toBe(3);
  expect(job.status, "a job that never did its work must not read 'succeeded'").toBe("failed");
  expect(job.last_error).toContain("provider unreachable");

  // Every attempt is still recorded as a `degraded` run — the distinction from
  // a thrown failure is worth keeping — but the settled JOB is red.
  const runs = await sql`SELECT status FROM job_runs WHERE job_id = ${id} ORDER BY id`;
  expect(runs.map((r) => r.status)).toEqual(["degraded", "degraded", "degraded"]);
});

test("the exhausted degrade is VISIBLE on the admin overview", async () => {
  // A MONITORED kind, with its real handler swapped for a degrading one for the
  // length of the test. It used to be `swarm.judge`, which no longer exists as a
  // monitored kind (issue #1026: the judge is a participant, not a queue job);
  // a sampler kind is what the overview actually watches now. The lane is
  // `generic`, which claims every kind.
  const kind = SAMPLER_KINDS[0];
  const original = handlers[kind];
  await sql`INSERT INTO jobs (kind, payload, max_attempts) VALUES (${kind}, '{}', 2)`;
  handlers[kind] = async () => ({ ok: false, error: "provider unreachable" });
  try {
    for (let i = 0; i < 6; i++) {
      await sql`UPDATE jobs SET run_after = now() WHERE status = 'pending'`;
      if (!(await processOneJob({ lane: LANES.generic }))) break;
    }
  } finally {
    if (original) handlers[kind] = original;
    else delete handlers[kind];
  }
  const [job] = await sql`SELECT status FROM jobs WHERE kind = ${kind} ORDER BY id DESC LIMIT 1`;
  expect(job.status).toBe("failed");

  const overview = await getOverviewProjection();
  const health = overview.production.find((p) => p.kind === kind)!;
  expect(health.lastJobStatus).toBe("failed");
  expect(health.alert, "an exhausted monitored lane is not healthy").not.toBe("healthy");
  expect(overview.alerts.some((a) => a.source === kind)).toBe(true);
});

test("a TERMINAL degrade is not retried at all — one attempt, one red row", async () => {
  const [{ id }] = await sql`
    INSERT INTO jobs (kind, payload, max_attempts) VALUES ('research.test_terminal', '{}', 5) RETURNING id`;
  await drain();

  const [job] = await sql`SELECT status, attempts, last_error FROM jobs WHERE id = ${id}`;
  expect(job.attempts, "a retry cannot change the answer, so there is no retry").toBe(1);
  expect(job.status).toBe("failed");
  expect(job.last_error).toContain("permanently unsatisfiable");

  const runs = await sql`SELECT status FROM job_runs WHERE job_id = ${id} ORDER BY id`;
  expect(runs.map((r) => r.status)).toEqual(["failed"]);
});

// Issue #107 — lease renewal / cancellation semantics for long jobs. Covers:
//   - a LIVE long-running handler renews its lease across shortened visibility
//     windows, so the reaper never requeues it and no second worker can claim
//     or execute it concurrently;
//   - an ABANDONED control job (owner writes no heartbeats) is still reaped;
//   - a run whose lock is lost mid-flight is effectively canceled: its terminal
//     write is discarded (no job row stomp, no duplicate job_runs).
// Runs in the required backend-integration job against ephemeral Postgres.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { processOneJob, releaseOwnedJobs } from "../src/worker/loop.ts";
import { LANES } from "../src/worker/lanes.ts";
import { reapStuckJobs } from "../src/worker/reaper.ts";

import { useCleanDatabase } from "./support/clean-db.ts";

// Own database, cloned from the migrated template — see support/clean-db.ts.
useCleanDatabase(import.meta.file);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}
let slowGate = gate();

const savedEnv = { visibility: process.env.JOB_VISIBILITY_TIMEOUT, renew: process.env.JOB_LEASE_RENEW_MS };
beforeAll(() => {
  // Shortened lease intervals: 2s visibility window, 300ms renewal cadence.
  process.env.JOB_VISIBILITY_TIMEOUT = "2";
  process.env.JOB_LEASE_RENEW_MS = "300";
  handlers["research.test_slow"] = async () => { await slowGate.opened; return { ok: true }; };
  handlers["research.test_ctl"] = async () => ({ ok: true }); // fast control handler
});
afterAll(() => {
  if (savedEnv.visibility === undefined) delete process.env.JOB_VISIBILITY_TIMEOUT; else process.env.JOB_VISIBILITY_TIMEOUT = savedEnv.visibility;
  if (savedEnv.renew === undefined) delete process.env.JOB_LEASE_RENEW_MS; else process.env.JOB_LEASE_RENEW_MS = savedEnv.renew;
});
beforeEach(async () => {
  slowGate = gate();
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_schedules`;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(id: number, status: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    if (row?.status === status) return;
    await sleep(25);
  }
  throw new Error(`job ${id} never reached '${status}' within ${ms}ms`);
}

test("a live handler renews its lease across shortened visibility windows; only the abandoned control is reaped", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_slow', '{}') RETURNING id`;
  const running = processOneJob({ lane: LANES.research, workerId: "lease-owner" });
  await waitForStatus(id, "running", 2000);

  // Abandoned-worker control: 'running' with a stale lock and NO heartbeats.
  const [{ id: control }] = await sql`
    INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
    VALUES ('research.test_ctl', '{}', 'running', now() - interval '1 minute', 'dead-worker', 1, 5) RETURNING id`;

  // Outlive the 2s visibility window while the owner's 300ms heartbeat renews.
  await sleep(2600);
  const reaped = await reapStuckJobs();
  expect(reaped).toBe(1); // ONLY the abandoned control...
  const [ctl] = await sql`SELECT status, locked_by FROM jobs WHERE id = ${control}`;
  expect(ctl.status).toBe("pending");
  expect(ctl.locked_by).toBeNull();
  // ...the live job keeps its owner and its lock.
  const [live] = await sql`SELECT status, locked_by, locked_at FROM jobs WHERE id = ${id}`;
  expect(live.status).toBe("running");
  expect(live.locked_by).toBe("lease-owner");
  expect(Date.now() - new Date(live.locked_at).getTime()).toBeLessThan(2000); // renewed recently

  // No second worker can claim or execute it concurrently.
  await sql`UPDATE jobs SET run_after = now() WHERE id = ${control}`; // skip the requeue backoff
  expect(await processOneJob({ lane: LANES.research, workerId: "lease-thief" })).toBe(true); // claims the reaped CONTROL...
  expect(await processOneJob({ lane: LANES.research, workerId: "lease-thief" })).toBe(false); // ...but never the live job
  slowGate.open();
  expect(await running).toBe(true);
  await waitForStatus(id, "succeeded", 2000);
  const runs = await sql`SELECT status FROM job_runs WHERE job_id = ${id}`;
  expect(runs.length).toBe(1); // exactly one terminal record — never executed twice
  expect(runs[0].status).toBe("succeeded");
});

test("lost lock mid-flight cancels the run: terminal write discarded, no duplicate job_runs", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_slow', '{}') RETURNING id`;
  const running = processOneJob({ lane: LANES.research, workerId: "cancel-owner" });
  await waitForStatus(id, "running", 2000);

  // Steal the lock (what a reap + reclaim by another worker does).
  await sql`UPDATE jobs SET locked_by = 'usurper', locked_at = now() WHERE id = ${id}`;
  await sleep(700); // > one renewal tick: the owner observes the loss and stops renewing

  slowGate.open();
  expect(await running).toBe(true); // loop returns, but...
  const [job] = await sql`SELECT status, locked_by FROM jobs WHERE id = ${id}`;
  expect(job.status).toBe("running"); // ...the usurper's row was NOT stomped
  expect(job.locked_by).toBe("usurper");
  const runs = await sql`SELECT count(*)::int n FROM job_runs WHERE job_id = ${id}`;
  expect(runs[0].n).toBe(0); // canceled run recorded nothing
});

test("releaseOwnedJobs returns a worker's in-flight jobs to pending (shutdown path)", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_slow', '{}') RETURNING id`;
  const running = processOneJob({ lane: LANES.research, workerId: "release-owner" });
  await waitForStatus(id, "running", 2000);

  expect(await releaseOwnedJobs("release-owner")).toBe(1);
  const [job] = await sql`SELECT status, locked_by, last_error FROM jobs WHERE id = ${id}`;
  expect(job.status).toBe("pending");
  expect(job.locked_by).toBeNull();
  expect(job.last_error).toContain("released: worker shutdown");

  slowGate.open();
  await running; // zombie completion discarded by the ownership guard
  const [after] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
  expect(after.status).toBe("pending"); // still claimable — not stomped to 'succeeded'
  const [{ n }] = await sql`SELECT count(*)::int n FROM job_runs WHERE job_id = ${id}`;
  expect(n).toBe(0);
});

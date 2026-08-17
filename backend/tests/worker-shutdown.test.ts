// Issue #107 — graceful, lane-aware shutdown. Covers, for all lanes signaled
// together during idle AND active work:
//   - bounded exit (stop() resolves within the shutdown budget);
//   - an in-flight job is allowed to finish and writes exactly ONE terminal
//     job_runs row (no duplicates);
//   - a HUNG handler is abandoned at the deadline and its job is released back
//     to 'pending' — no orphaned 'running' row owned by a stopped worker, and
//     the zombie's eventual completion is discarded.
// Runs in the required backend-integration job against ephemeral Postgres.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { LANES } from "../src/worker/lanes.ts";
import { startWorker, type WorkerHandle } from "../src/worker/runtime.ts";

import { useCleanDatabase } from "./support/clean-db.ts";

// Own database, cloned from the migrated template — see support/clean-db.ts.
useCleanDatabase(import.meta.file);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}
let hangGate = gate();

beforeAll(() => {
  handlers["swarm.test_shutdown_fast"] = async () => ({ ok: true });
  handlers["test.shutdown_slow"] = async () => { await new Promise((r) => setTimeout(r, 800)); return { ok: true }; };
  handlers["research.test_shutdown_hang"] = async () => { await hangGate.opened; return { ok: true }; };
});
beforeEach(async () => {
  hangGate = gate();
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_schedules`;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fastOpts = { idlePollMs: 25, schedulerTickMs: 60_000, reaperTickMs: 60_000 };

async function waitForStatus(id: number, status: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    if (row?.status === status) return;
    await sleep(25);
  }
  throw new Error(`job ${id} never reached '${status}' within ${ms}ms`);
}

test("idle shutdown: all lanes signaled together exit bounded with no orphaned work", async () => {
  const workers: WorkerHandle[] = [LANES.swarm, LANES.analytics, LANES.research].map((lane) =>
    startWorker({ lane, workerId: `idle-${lane.name}`, ...fastOpts, shutdownTimeoutMs: 5000 }));
  await sleep(150); // loops spinning idle

  const t0 = Date.now();
  await Promise.all(workers.map((w) => w.stop())); // signal ALL lanes together
  expect(Date.now() - t0).toBeLessThan(3000); // bounded exit

  const orphans = await sql`SELECT id FROM jobs WHERE status = 'running'`;
  expect(orphans.length).toBe(0);
  // stop() is idempotent — a second signal resolves without re-running shutdown.
  await Promise.all(workers.map((w) => w.stop()));
});

test("active shutdown: in-flight job finishes, exactly one terminal job_runs row, no orphaned running job", async () => {
  const worker = startWorker({ lane: LANES.analytics, workerId: "active-analytics", ...fastOpts, shutdownTimeoutMs: 5000 });
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('test.shutdown_slow', '{}') RETURNING id`;
  await waitForStatus(id, "running", 3000);

  const t0 = Date.now();
  await worker.stop(); // signaled while the handler is mid-flight
  expect(Date.now() - t0).toBeLessThan(4000); // bounded

  const [job] = await sql`SELECT status, locked_by FROM jobs WHERE id = ${id}`;
  expect(job.status).toBe("succeeded"); // in-flight work completed, not lost
  expect(job.locked_by).toBeNull(); // resources released
  const runs = await sql`SELECT status FROM job_runs WHERE job_id = ${id}`;
  expect(runs.length).toBe(1); // exactly one terminal write
  expect(runs[0].status).toBe("succeeded");
  const orphans = await sql`SELECT id FROM jobs WHERE status = 'running' AND locked_by = 'active-analytics'`;
  expect(orphans.length).toBe(0);
});

test("hung handler: bounded exit at the deadline, job released to pending (never orphaned), zombie write discarded", async () => {
  const worker = startWorker({ lane: LANES.research, workerId: "hung-research", ...fastOpts, shutdownTimeoutMs: 500 });
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_shutdown_hang', '{}') RETURNING id`;
  await waitForStatus(id, "running", 3000);

  const t0 = Date.now();
  await worker.stop(); // handler never returns — stop must not wait forever
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(2500); // bounded by shutdownTimeoutMs (+ release write)

  const [job] = await sql`SELECT status, locked_by FROM jobs WHERE id = ${id}`;
  expect(job.status).toBe("pending"); // released — no orphaned 'running' row
  expect(job.locked_by).toBeNull(); // owned by nobody after the worker stopped

  // The zombie handler eventually resolves — its terminal write must be discarded.
  hangGate.open();
  await sleep(300);
  const [after] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
  expect(after.status).toBe("pending"); // not stomped to 'succeeded'
  const [{ n }] = await sql`SELECT count(*)::int n FROM job_runs WHERE job_id = ${id}`;
  expect(n).toBe(0); // no duplicate/phantom terminal record
});

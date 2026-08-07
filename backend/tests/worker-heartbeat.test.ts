// The worker lanes' Docker liveness signal, exercised through the REAL drain
// loop against ephemeral Postgres (src/worker/runtime.ts + src/ops/heartbeat.ts;
// docker-compose.yml's x-worker-healthcheck reads what these tests read).
//
// The acceptance question this file answers is the one that decides whether the
// check is worth having at all: does it separate a WEDGED lane from an IDLE one
// WITHOUT killing the process? Both cases below keep the worker alive
// throughout, and the wedged case is proved to recover — a dead process could
// not.
//
// Runs in the required backend-integration job against ephemeral Postgres.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { LANES } from "../src/worker/lanes.ts";
import { startWorker, type WorkerHandle } from "../src/worker/runtime.ts";
import { seedJobSchedules } from "../src/db/seed.ts";
import { checkHeartbeatFile, resetHeartbeatWriter } from "../src/ops/heartbeat.ts";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}
let hangGate = gate();

beforeAll(() => {
  handlers["research.test_heartbeat_hang"] = async () => { await hangGate.opened; return { ok: true }; };
  handlers["research.test_heartbeat_slow"] = async () => { await sleep(600); return { ok: true }; };
  // Claims cleanly (widening the deadline to BUSY via onClaim), then throws
  // once the gate opens — standing in for a handler that fails mid-job while
  // the database is down, so loop.ts's own failure-path UPDATE (its catch
  // block, itself unguarded by a nested try) also throws.
  handlers["research.test_heartbeat_busy_then_dbloss"] = async () => {
    await hangGate.opened;
    throw new Error("handler exploded after the database was pulled out from under it");
  };
});
// This file TRUNCATEs job_schedules for isolation; restore the production seed
// rows so later files sharing this ephemeral Postgres don't see an empty table.
afterAll(async () => { await seedJobSchedules(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fastOpts = { idlePollMs: 25, schedulerTickMs: 60_000, reaperTickMs: 60_000, shutdownTimeoutMs: 1000 };

let dir: string;
let path: string;
const started: WorkerHandle[] = [];

beforeEach(async () => {
  hangGate = gate();
  resetHeartbeatWriter();
  dir = await mkdtemp(join(tmpdir(), "rm-worker-hb-"));
  path = join(dir, "heartbeat");
  await sql`TRUNCATE jobs, job_runs, job_schedules RESTART IDENTITY CASCADE`;
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((w) => w.stop()));
  await rm(dir, { recursive: true, force: true });
});

function launch(opts: Parameters<typeof startWorker>[0]): WorkerHandle {
  const w = startWorker(opts);
  started.push(w);
  return w;
}

async function record(): Promise<{ phase: string; staleAfterMs: number; ts: number; detail?: string }> {
  return JSON.parse(await Bun.file(path).text()) as { phase: string; staleAfterMs: number; ts: number; detail?: string };
}

async function waitFor(predicate: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await sleep(20);
  }
  throw new Error(`never observed ${what} within ${ms}ms`);
}

test("an IDLE lane with nothing queued stays healthy and keeps reporting — idleness is not failure", async () => {
  launch({ lane: LANES.research, workerId: "idle-research", heartbeatFile: path, ...fastOpts });

  await waitFor(async () => (await checkHeartbeatFile(path)).healthy, 3000, "the first healthy heartbeat");
  const first = await record();
  await sleep(1200); // several idle poll cycles AND past the write-coalescing window
  const second = await record();

  // Still healthy, and demonstrably still WRITING — not one boot record frozen
  // in place that would age out later.
  expect((await checkHeartbeatFile(path)).healthy).toBe(true);
  expect(second.ts).toBeGreaterThan(first.ts);
  expect(second.phase).toBe("idle");
});

test("a lane whose loop is wedged inside a job goes UNHEALTHY while the process stays alive — and recovers when it unwedges", async () => {
  // The whole point of the check. A 400ms job budget stands in for the shipped
  // 15 minutes; nothing else about the path differs.
  launch({
    lane: LANES.research, workerId: "wedged-research", heartbeatFile: path,
    ...fastOpts, jobProgressTimeoutMs: 400, idleProgressTimeoutMs: 60_000,
  });
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_heartbeat_hang', '{}') RETURNING id`;

  // The loop claims the job and widens its deadline for the duration.
  await waitFor(async () => (await record()).phase === "busy", 3000, "the lane entering its busy phase");
  expect((await record()).detail).toContain(`job ${id}`);
  expect((await checkHeartbeatFile(path)).healthy).toBe(true); // inside the budget

  // The handler never returns. Past the budget, the lane reports unhealthy.
  await sleep(700);
  const stalled = await checkHeartbeatFile(path);
  expect(stalled.healthy).toBe(false);
  expect(stalled.reason).toContain("no progress");

  // ...and the process was ALIVE the whole time: the job is still held (its
  // lease is being renewed from this very process), and releasing the handler
  // returns the lane to healthy. A crashed worker could do neither.
  const [held] = await sql`SELECT status, locked_by FROM jobs WHERE id = ${id}`;
  expect(held.status).toBe("running");
  expect(held.locked_by).toBe("wedged-research");

  hangGate.open();
  await waitFor(async () => (await checkHeartbeatFile(path)).healthy, 3000, "recovery to healthy");
  expect((await record()).phase).toBe("idle");
});

test("a legitimately slow job does NOT go red: the busy budget covers it, and the idle budget is restored after", async () => {
  launch({
    lane: LANES.research, workerId: "slow-research", heartbeatFile: path,
    ...fastOpts, jobProgressTimeoutMs: 10_000, idleProgressTimeoutMs: 60_000,
  });
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_heartbeat_slow', '{}') RETURNING id`;

  await waitFor(async () => (await record()).phase === "busy", 3000, "the lane entering its busy phase");
  expect((await record()).staleAfterMs).toBe(10_000); // the JOB budget, not the idle one

  // 600ms of honest work with no intermediate heartbeat: healthy throughout.
  for (let i = 0; i < 6; i++) {
    expect((await checkHeartbeatFile(path)).healthy).toBe(true);
    await sleep(100);
  }

  await waitFor(async () => {
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    return row?.status === "succeeded";
  }, 3000, "the slow job completing");
  // Critically, the wide budget is NOT left behind — a finished lane that kept
  // advertising 10s would mask the next stall for that long.
  await waitFor(async () => (await record()).phase === "idle", 3000, "the return to the idle budget");
  expect((await record()).staleAfterMs).toBe(60_000);
});

test("the budget the lane reports comes from its configured knobs, so compose and code cannot drift apart", async () => {
  launch({
    lane: LANES.research, workerId: "knobs-research", heartbeatFile: path,
    ...fastOpts, idleProgressTimeoutMs: 12_345,
  });

  await waitFor(async () => (await record()).phase === "idle", 3000, "an idle heartbeat");
  expect((await record()).staleAfterMs).toBe(12_345);
});

test("a lane that has LOST ITS DATABASE goes unhealthy — 'process alive' is not 'serving'", async () => {
  // The same distinction the api's /health check makes, and the reason the drain
  // loop's catch branch deliberately does NOT record progress: a claim query
  // that throws every cycle is not a working lane, however alive the process is.
  //
  // Fault injected for real, by renaming the table out from under the claim
  // query — a stubbed-out client would not exercise the loop's actual error
  // path. Restored in `finally` because this ephemeral Postgres is shared with
  // every later test file.
  launch({
    lane: LANES.research, workerId: "dbless-research", heartbeatFile: path,
    ...fastOpts, idleProgressTimeoutMs: 300,
  });
  await waitFor(async () => (await checkHeartbeatFile(path)).healthy, 3000, "a healthy idle lane first");

  await sql`ALTER TABLE jobs RENAME TO jobs_fault_injection`;
  try {
    await sleep(700); // past the 300ms idle budget, with every cycle throwing
    const verdict = await checkHeartbeatFile(path);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain("no progress");
  } finally {
    await sql`ALTER TABLE jobs_fault_injection RENAME TO jobs`;
  }

  // Recovery proves the process never died — it was up and failing the whole
  // time, which is exactly the state a process-existence probe would call green.
  await waitFor(async () => (await checkHeartbeatFile(path)).healthy, 5000, "recovery once the database returns");
});

test("a DB outage that hits MID-JOB narrows the stale BUSY budget back down instead of leaving it in place", async () => {
  // Distinct from the idle-outage case above: here the loop is already BUSY —
  // onClaim (loop.ts) has widened the on-disk deadline to the wide job budget
  // — when the database disappears. If the drainLoop catch skipped the beat
  // (the old behavior), that wide budget would sit uncorrected and the lane
  // would keep reporting healthy for up to the full job budget even though it
  // is fully stalled. The fix must narrow it back to the idle budget instead.
  launch({
    lane: LANES.research, workerId: "midjob-dbloss-research", heartbeatFile: path,
    ...fastOpts, jobProgressTimeoutMs: 10_000, idleProgressTimeoutMs: 300,
  });
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('research.test_heartbeat_busy_then_dbloss', '{}') RETURNING id`;

  // Claimed cleanly (DB is fine at this point) — the loop is now on the WIDE
  // (10s) budget.
  await waitFor(async () => (await record()).phase === "busy", 3000, "the lane entering its busy phase");
  expect((await record()).detail).toContain(`job ${id}`);
  expect((await record()).staleAfterMs).toBe(10_000);

  // Pull the database out from under the in-flight job. The handler will
  // throw once released below; loop.ts's own failure-path UPDATE then throws
  // too (the table is gone), so processOneJob() itself rejects — the exact
  // path the drainLoop catch branch must handle.
  await sql`ALTER TABLE jobs RENAME TO jobs_fault_injection`;
  try {
    hangGate.open();

    // Give the rejected processOneJob() a moment to propagate into the catch
    // and write its beat, then wait well past the NARROW (300ms) idle budget
    // but nowhere near the WIDE (10s) one. Under the pre-fix behavior (no beat
    // on error) the on-disk record would still be the 10s-budget "busy" write
    // from above and would report healthy here — this assertion is the one
    // that closes the gap.
    await sleep(700);
    const verdict = await checkHeartbeatFile(path);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain("no progress");
    // And it was narrowed, not just eventually-stale on the old wide budget:
    // the record itself now advertises the idle-sized budget.
    const rec = await record();
    expect(rec.staleAfterMs).toBe(300);
    expect(rec.phase).toBe("faulted");
  } finally {
    await sql`ALTER TABLE jobs_fault_injection RENAME TO jobs`;
  }

  // Recovery: the process stayed alive throughout (the job row itself never
  // got its failure recorded, since that write is what threw — it is still
  // owned 'running' by this worker) and the drain loop keeps cycling once the
  // database returns, so a fresh claim query succeeds and the lane goes
  // healthy again.
  await waitFor(async () => (await checkHeartbeatFile(path)).healthy, 5000, "recovery once the database returns");
});

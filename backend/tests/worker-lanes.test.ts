// Issue #107 — lane-filtered claiming over the real Postgres queue. Covers:
//   - fail-loud lane configuration (empty/unknown WORKER_LANE);
//   - allowlist filtering: a worker NEVER claims kinds outside its lane, and
//     swarm kinds are reserved (research/analytics/generic can't claim them);
//   - reserved capacity: with every research slot blocked, a swarm job is
//     still immediately claimed by the swarm lane;
//   - starvation: an indefinitely blocked research job cannot prevent swarm
//     and regime jobs from reaching terminal state;
//   - exclusive concurrent claims: N workers, each job runs exactly once with
//     non-overlapping ownership and exactly one terminal job_runs row;
//   - priority is preserved WITHIN a lane.
// Runs in the required backend-integration job against ephemeral Postgres.
import { test, expect, afterEach, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { LANES, resolveLane, describeLane } from "../src/worker/lanes.ts";
import { startWorker, type WorkerHandle } from "../src/worker/runtime.ts";

import { useCleanDatabase } from "./support/clean-db.ts";

// Own database, cloned from the migrated template — see support/clean-db.ts.
useCleanDatabase(import.meta.file);

// Gate that lets tests block a handler "indefinitely" and release it later.
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

const executed: string[] = []; // "<kind>:<jobId>" per handler execution
let researchGate = gate();

// Every handle this file starts. The per-test `finally` blocks below already
// stop theirs; this is the structural backstop, so a loop can never outlive the
// file. `sql` is a live binding (db/client.ts) and support/clean-db.ts DROPs a
// clone once the next file takes over, so a straggler would query a database
// that no longer exists. stop() is idempotent, so the two do not conflict.
const started: WorkerHandle[] = [];
function launch(opts: Parameters<typeof startWorker>[0]): WorkerHandle {
  const w = startWorker(opts);
  started.push(w);
  return w;
}
afterEach(async () => {
  researchGate.open(); // release anything still parked in the blocking handler
  await Promise.all(started.splice(0).map((w) => w.stop()));
});

const savedRegime = () => handlers["regime.classify"];
let realRegime: (typeof handlers)[string];

beforeAll(() => {
  realRegime = savedRegime();
  handlers["swarm.test_fast"] = async (p) => { executed.push(`swarm.test_fast:${p.jobId ?? ""}`); return { ok: true }; };
  handlers["research.test_block"] = async (p) => { executed.push(`research.test_block:${p.jobId ?? ""}`); await researchGate.opened; return { ok: true }; };
  handlers["test.lane_probe"] = async (p) => { executed.push(`test.lane_probe:${p.jobId ?? ""}`); return { ok: true }; };
  // Stub the REAL regime kind so the starvation test never touches live fetchers.
  handlers["regime.classify"] = async (p) => { executed.push(`regime.classify:${p.jobId ?? ""}`); return { ok: true }; };
});
afterAll(() => { handlers["regime.classify"] = realRegime; });

beforeEach(async () => {
  executed.length = 0;
  researchGate = gate();
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_schedules`;
});

async function enqueue(kind: string, priority = 0): Promise<number> {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload, priority)
                             VALUES (${kind}, ${sql.json({})}, ${priority}) RETURNING id`;
  return id;
}
const jobStatus = async (id: number): Promise<string> =>
  (await sql`SELECT status FROM jobs WHERE id = ${id}`)[0].status as string;

async function waitFor(cond: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

test("resolveLane: empty or unknown lane configuration fails loudly", () => {
  expect(() => resolveLane(undefined)).toThrow(/WORKER_LANE is required/);
  expect(() => resolveLane("")).toThrow(/WORKER_LANE is required/);
  expect(() => resolveLane("   ")).toThrow(/WORKER_LANE is required/);
  expect(() => resolveLane("bogus")).toThrow(/invalid WORKER_LANE "bogus"/);
  expect(resolveLane("swarm").name).toBe("swarm");
  expect(resolveLane("analytics").name).toBe("analytics");
  expect(resolveLane("research").name).toBe("research");
  expect(resolveLane("generic").name).toBe("generic");
  expect(describeLane(LANES.analytics)).toContain("except");
});

test("lane filter: swarm kinds are RESERVED — research/analytics/generic never claim them", async () => {
  const id = await enqueue("swarm.test_fast");
  expect(await processOneJob({ lane: LANES.research, workerId: "r1" })).toBe(false);
  expect(await processOneJob({ lane: LANES.analytics, workerId: "a1" })).toBe(false);
  expect(await processOneJob({ lane: LANES.generic, workerId: "g1" })).toBe(false);
  expect(await jobStatus(id)).toBe("pending"); // untouched by non-swarm lanes
  expect(await processOneJob({ lane: LANES.swarm, workerId: "c1" })).toBe(true);
  expect(await jobStatus(id)).toBe("succeeded");
});

test("lane filter: research kinds only claimable by the research lane (not analytics/swarm)", async () => {
  researchGate.open(); // don't block — this test only checks claimability
  const id = await enqueue("research.test_block");
  expect(await processOneJob({ lane: LANES.analytics, workerId: "a1" })).toBe(false);
  expect(await processOneJob({ lane: LANES.swarm, workerId: "c1" })).toBe(false);
  expect(await jobStatus(id)).toBe("pending");
  expect(await processOneJob({ lane: LANES.research, workerId: "r1" })).toBe(true);
  expect(await jobStatus(id)).toBe("succeeded");
});

test("lane filter: analytics lane claims regime/pipeline kinds but neither swarm nor research", async () => {
  const regime = await enqueue("regime.classify");
  const probe = await enqueue("test.lane_probe");
  await enqueue("swarm.test_fast");
  researchGate.open();
  await enqueue("research.test_block");
  expect(await processOneJob({ lane: LANES.analytics, workerId: "a1" })).toBe(true);
  expect(await processOneJob({ lane: LANES.analytics, workerId: "a1" })).toBe(true);
  expect(await processOneJob({ lane: LANES.analytics, workerId: "a1" })).toBe(false); // nothing claimable left
  expect(await jobStatus(regime)).toBe("succeeded");
  expect(await jobStatus(probe)).toBe("succeeded");
});

test("priority is preserved within a lane", async () => {
  const low = await enqueue("swarm.test_fast", 0);
  const high = await enqueue("swarm.test_fast", 10);
  expect(await processOneJob({ lane: LANES.swarm, workerId: "c1" })).toBe(true);
  expect(await jobStatus(high)).toBe("succeeded");
  expect(await jobStatus(low)).toBe("pending"); // higher priority claimed first
});

test("starvation: a blocked research job cannot prevent swarm or regime work (full lane topology)", async () => {
  const workers: WorkerHandle[] = [];
  try {
    // The configured topology: one worker per lane, all polling fast.
    for (const lane of [LANES.swarm, LANES.analytics, LANES.research]) {
      workers.push(launch({
        lane, workerId: `starve-${lane.name}`, idlePollMs: 25,
        schedulerTickMs: 60_000, reaperTickMs: 60_000, shutdownTimeoutMs: 4000,
      }));
    }
    const research = await enqueue("research.test_block");
    await waitFor(async () => (await jobStatus(research)) === "running", 3000, "research job to block its lane");

    const swarm = await enqueue("swarm.test_fast");
    const regime = await enqueue("regime.classify");
    await waitFor(async () => (await jobStatus(swarm)) === "succeeded", 5000, "swarm job to complete");
    await waitFor(async () => (await jobStatus(regime)) === "succeeded", 5000, "regime job to complete");
    // ... while research is STILL blocked and owned by the research lane.
    const [r] = await sql`SELECT status, locked_by FROM jobs WHERE id = ${research}`;
    expect(r.status).toBe("running");
    expect(r.locked_by).toBe("starve-research");
  } finally {
    researchGate.open();
    await Promise.all(workers.map((w) => w.stop()));
  }
});

test("reserved capacity: every research slot full → a swarm job is still immediately claimed", async () => {
  const workers: WorkerHandle[] = [];
  try {
    // Fill EVERY research slot (one research worker = one slot) with blocked work.
    workers.push(launch({
      lane: LANES.research, workerId: "cap-research", idlePollMs: 25,
      schedulerTickMs: 60_000, reaperTickMs: 60_000, shutdownTimeoutMs: 4000,
    }));
    const blocked = await enqueue("research.test_block");
    await waitFor(async () => (await jobStatus(blocked)) === "running", 3000, "research slot to fill");

    const swarm = await enqueue("swarm.test_fast");
    // A research worker must NOT claim swarm-reserved capacity...
    expect(await processOneJob({ lane: LANES.research, workerId: "cap-research-extra" })).toBe(false);
    expect(await jobStatus(swarm)).toBe("pending");
    // ...and the reserved swarm lane claims it immediately.
    workers.push(launch({
      lane: LANES.swarm, workerId: "cap-swarm", idlePollMs: 25,
      schedulerTickMs: 60_000, reaperTickMs: 60_000, shutdownTimeoutMs: 4000,
    }));
    await waitFor(async () => (await jobStatus(swarm)) === "succeeded", 3000, "reserved lane to claim swarm job");
    expect(await jobStatus(blocked)).toBe("running"); // research still occupied throughout
  } finally {
    researchGate.open();
    await Promise.all(workers.map((w) => w.stop()));
  }
});

test("exclusive claims: N concurrent workers, each job executes once, ownership never overlaps, one job_runs row per job", async () => {
  const JOBS = 8;
  const ids: number[] = [];
  for (let i = 0; i < JOBS; i++) ids.push(await enqueue("swarm.test_fast"));

  // Three concurrent swarm workers racing over the same lane.
  const claims = await Promise.all(
    Array.from({ length: JOBS * 3 }, (_, i) =>
      processOneJob({ lane: LANES.swarm, workerId: `race-${i % 3}` })),
  );
  expect(claims.filter(Boolean).length).toBe(JOBS); // exactly one claim per job

  for (const id of ids) {
    const [job] = await sql`SELECT status, attempts FROM jobs WHERE id = ${id}`;
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(1); // never claimed twice
    const runs = await sql`SELECT status FROM job_runs WHERE job_id = ${id}`;
    expect(runs.length).toBe(1); // exactly one terminal record
    expect(runs[0].status).toBe("succeeded");
  }
  // Each handler body executed exactly once per job.
  expect(executed.filter((e) => e.startsWith("swarm.test_fast")).length).toBe(JOBS);
});

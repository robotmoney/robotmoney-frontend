// `bun run prune`'s jobs entries commit chunk by chunk (issue 1584).
//
// The 5,000-row chunks used to bound each DELETE statement while every target
// ran in ONE transaction, so a large first prune of `jobs` held one long
// transaction and its row locks to the end. Each chunk is now its own fenced
// transaction. Proven here on the rm_owner connection the command uses:
//   * each chunk is visible to ANOTHER session the moment runPrune reports it,
//     so it committed before the next chunk started;
//   * every chunk names the run's one cutoff;
//   * a session lock that can no longer be proven held stops the run before the
//     next chunk, and the chunks already committed stay committed.
//
// The database is this file's own (useCleanDatabase); the rows are planted by
// rm_owner, aged by updated_at.
import { beforeEach, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { TARGET_LOCK_KEY, type HeldTargetLock } from "../src/db/target-lock.ts";
import { JOBS_PRUNE_CHUNK, runPrune, type PruneCommit } from "../scripts/prune.ts";
import { roleUrl } from "./support/cluster.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const PLANTED = 2 * JOBS_PRUNE_CHUNK + 1;

/** A session lock stand-in that answers held for its first `heldFor` checks, then not. */
function lockHeldFor(heldFor: number): HeldTargetLock & { checks: () => number } {
  let checks = 0;
  return {
    key: TARGET_LOCK_KEY,
    holder: { tool: "prune", planId: null, instance: null, host: "test-host", pid: process.pid, acquiredAt: new Date().toISOString() },
    backendPid: 0,
    stillHeld: async () => ++checks <= heldFor,
    checks: () => checks,
  };
}

async function remaining(): Promise<number> {
  const [row] = (await sql`SELECT count(*)::int AS n FROM jobs WHERE payload->>'plant' = 'chunked'`) as unknown as { n: number }[];
  return row!.n;
}

async function ownerPool(): Promise<postgres.Sql<{}>> {
  const [{ database }] = (await sql`SELECT current_database() AS database`) as unknown as { database: string }[];
  return postgres(roleUrl("rm_owner", database), { max: 1, onnotice: () => {} });
}

beforeEach(async () => {
  // Each case starts from exactly PLANTED old finished jobs, each with a run.
  // Rows a previous case left are part of the count it proved, so they are
  // pruned by this file's own runs, never deleted to reset.
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    const [{ n }] = (await tx`SELECT count(*)::int AS n FROM jobs WHERE payload->>'plant' = 'chunked'`) as unknown as { n: number }[];
    await tx`
      WITH planted AS (
        INSERT INTO jobs (kind, payload, status, created_at, updated_at)
        SELECT 'prune.chunk', '{"plant": "chunked"}'::jsonb, 'succeeded', now() - interval '40 days', now() - interval '40 days'
          FROM generate_series(1, ${PLANTED - n})
        RETURNING id)
      INSERT INTO job_runs (job_id, kind, status, started_at, finished_at)
      SELECT id, 'prune.chunk', 'succeeded', now() - interval '40 days', now() - interval '40 days' FROM planted`;
  });
  expect(await remaining()).toBe(PLANTED);
}, 60_000);

test("each jobs chunk is committed, and visible to another session, before the next one starts", async () => {
  const owner = await ownerPool();
  const seen: { table: string; rows: number; jobRuns: number | null; left: number }[] = [];
  try {
    const tables = await runPrune(owner, {
      windowDays: 7,
      lock: lockHeldFor(Number.MAX_SAFE_INTEGER),
      // Read from the shared pool, not the owner's connection: only a
      // committed delete is visible here.
      onCommit: async (c: PruneCommit) => {
        if (c.table === "jobs") seen.push({ table: c.table, rows: c.rows, jobRuns: c.jobRuns ?? null, left: await remaining() });
      },
    });
    const jobs = tables.filter((t) => t.table === "jobs");
    expect(jobs.map((t) => ({ rows: t.rows, chunks: t.chunks, jobRuns: t.jobRuns }))).toEqual([
      { rows: PLANTED, chunks: [JOBS_PRUNE_CHUNK, JOBS_PRUNE_CHUNK, 1], jobRuns: PLANTED },
      { rows: 0, chunks: [], jobRuns: 0 },
    ]);
    // One cutoff per entry, the run's clock minus its window.
    expect(Date.parse(jobs[0]!.cutoff) - Date.parse(tables[0]!.cutoff)).toBe(-23 * 86_400_000);
  } finally {
    await owner.end({ timeout: 5 });
  }
  // The succeeded entry's three chunks, then the dead/failed entry's empty one.
  expect(seen).toEqual([
    { table: "jobs", rows: JOBS_PRUNE_CHUNK, jobRuns: JOBS_PRUNE_CHUNK, left: PLANTED - JOBS_PRUNE_CHUNK },
    { table: "jobs", rows: JOBS_PRUNE_CHUNK, jobRuns: JOBS_PRUNE_CHUNK, left: 1 },
    { table: "jobs", rows: 1, jobRuns: 1, left: 0 },
    { table: "jobs", rows: 0, jobRuns: 0, left: 0 },
  ]);
}, 120_000);

test("a lock that cannot be proven held stops the run before the next chunk; the chunk already committed stays", async () => {
  const owner = await ownerPool();
  // Held for the event log, the sessions and the first jobs chunk; lost after.
  const lock = lockHeldFor(3);
  const commits: PruneCommit[] = [];
  try {
    const error = await runPrune(owner, { windowDays: 7, lock, onCommit: (c) => void commits.push(c) }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain("cannot be proven held");
    expect(lock.checks()).toBe(4);
  } finally {
    await owner.end({ timeout: 5 });
  }
  expect(commits.map((c) => [c.table, c.rows])).toEqual([
    ["swarm_stream_events", 0],
    ["admin_session", 0],
    ["jobs", JOBS_PRUNE_CHUNK],
  ]);
  expect(await remaining()).toBe(PLANTED - JOBS_PRUNE_CHUNK);
  // No run of a deleted job is left behind.
  const [{ dangling }] = (await sql`
    SELECT count(*)::int AS dangling FROM job_runs r WHERE r.kind = 'prune.chunk' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = r.job_id)`) as unknown as {
    dangling: number;
  }[];
  expect(dangling).toBe(0);
}, 120_000);


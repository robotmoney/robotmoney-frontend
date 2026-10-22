// A saturated request pool answers at once (issue 1034). Before the admission
// gate, a request that found every connection busy queued inside postgres.js
// without limit until Bun's 10 s deadline killed it, and nginx answered 502.
// Now it gets `503 db_saturated` with Retry-After within the admission wait,
// while GET /health (its own probe connection) and routes that issue no query
// keep answering.
//
// The real api process, as a stack runs it, with a request pool of two. The
// fixture holds an ACCESS EXCLUSIVE lock on `comments`, so two GET
// /api/comments requests each hold a request-pool connection, blocked on the
// lock, and the pool is full.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { bootApi, type ApiProcess } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

let api: ApiProcess;

beforeAll(async () => {
  api = await bootApi({
    env: {
      PG_REQUEST_POOL_MAX: "2",
      // Long enough that the two held requests stay held while the test probes.
      PG_REQUEST_LOCK_TIMEOUT_MS: "8000",
      PG_REQUEST_STATEMENT_TIMEOUT_MS: "9000",
    },
  });
}, 90_000);

afterAll(() => api?.stop());

async function timed(path: string): Promise<{ status: number; ms: number; body: string; retryAfter: string | null }> {
  const started = performance.now();
  const res = await fetch(`${api.base}${path}`, { signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  return { status: res.status, ms: performance.now() - started, body, retryAfter: res.headers.get("retry-after") };
}

async function requestPool(): Promise<{ max: number; in_use: number; refused_total: number }> {
  const health = JSON.parse((await timed("/health")).body) as { db_pool: { request: { max: number; in_use: number; refused_total: number } } };
  return health.db_pool.request;
}

test("health reports the request pool's size and counts", async () => {
  const pool = await requestPool();
  expect(pool.max).toBe(2);
  expect(pool.in_use).toBe(0);
  expect(pool.refused_total).toBe(0);
});

test("with every request-pool connection held, the next DB-backed request answers 503 db_saturated at once", async () => {
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
  let lockHeld!: () => void;
  const lockTaken = new Promise<void>((resolve) => (lockHeld = resolve));
  const holder = fixtureDb.begin(async (tx) => {
    await tx`LOCK TABLE comments IN ACCESS EXCLUSIVE MODE`;
    lockHeld();
    await lockReleased;
  });
  await lockTaken;

  const before = await requestPool();
  const held = [timed("/api/comments?page=held-a"), timed("/api/comments?page=held-b")];
  try {
    // Both held requests are inside the database, waiting on the lock.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [{ n }] = await fixtureDb<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM comments%'`;
      if (n === 2) break;
      if (Date.now() > deadline) throw new Error(`expected 2 requests blocked on the comments lock, saw ${n}`);
      await Bun.sleep(25);
    }

    const refused = await timed("/api/comments?page=refused");
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "db_saturated" });
    expect(refused.retryAfter).toBe("1");
    expect(refused.ms).toBeLessThan(1_500);

    const health = await timed("/health");
    expect(health.status).toBe(200);
    expect(health.ms).toBeLessThan(1_000);
    const body = JSON.parse(health.body) as { db: string; db_pool: { request: { in_use: number; refused_total: number } } };
    expect(body.db).toBe("up");
    expect(body.db_pool.request.in_use).toBe(2);
    expect(body.db_pool.request.refused_total).toBeGreaterThan(before.refused_total);

    const noQuery = await timed("/api/version");
    expect(noQuery.status).toBe(200);
    expect(noQuery.ms).toBeLessThan(1_000);
  } finally {
    releaseLock();
    await holder;
  }

  // Once the lock is gone the held requests complete normally.
  for (const response of await Promise.all(held)) expect(response.status).toBe(200);
  expect((await requestPool()).in_use).toBe(0);
}, 60_000);

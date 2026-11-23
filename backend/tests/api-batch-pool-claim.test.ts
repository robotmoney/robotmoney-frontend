// A pipeline queue call never waits behind analytics writes (issue 1514, batch
// pool saturation).
//
// Production, 2026-10-28: at every 3-hourly analytics run the api's batch pool
// refused `POST /api/pipeline/queue/claim` with 503 db_saturated. The batch pool
// had 3 connections (2 on a small instance), and two callers drew on it with caps
// that add up past it: ANALYTICS_CONCURRENCY analytics requests and
// PIPELINE_TOKEN_CONCURRENCY pipeline requests.
//
// The real api process, against a clean database, for the default budget and
// for the small-instance budget. The fixture holds the advisory lock a
// source acquisition takes on its source key, so ANALYTICS_CONCURRENCY
// `POST /api/analytics/source-acquisitions` requests each hold a batch-pool
// transaction, blocked on the lock. While they hold, PIPELINE_TOKEN_CONCURRENCY
// concurrent queue claims must each answer 200 within 1 s.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { readConnectionLimits } from "../src/db/connection-check.ts";
import { ANALYTICS_CONCURRENCY } from "../src/api/routes/analytics.ts";
import { pipelineTokenConcurrency } from "../src/api/routes/pipeline.ts";
import { encodePipeline, PIPELINE_ROUTES } from "../src/lib/pipeline-wire.ts";
import { payloadChecksum } from "../src/analytics/source-ledger.ts";
import { bootApi, provisionAnalyticsToken, provisionPipelineToken } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const SOURCE_KEY = "batch-pool:claim";
const PIPELINE_SHARE = pipelineTokenConcurrency({});

let analyticsToken = "";
let pipelineToken = "";

beforeAll(async () => {
  analyticsToken = await provisionAnalyticsToken();
  pipelineToken = await provisionPipelineToken();
  await fixtureDb`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE status IN ('pending', 'running')`;
  await fixtureDb`UPDATE job_schedules SET enabled = false`;
}, 60_000);

// No afterAll "restore": the database is this file's own clone and is dropped
// with it. A blanket `UPDATE job_schedules SET enabled = true` here ran after
// useCleanDatabase had handed fixtureDb back to the SHARED database, and
// enabled regime.classify and research.refresh there, which
// tests/api/admin-surface.test.ts then saw as enabled analytics schedules.

function acquisition(): unknown {
  const bytes = new TextEncoder().encode('{"value":1}');
  return {
    acquisition: {
      id: randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: "batch-pool", requestedByRunId: null,
      events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
      fetches: [{ id: randomUUID(), sequence: 1, requestIdentity: { method: "GET", url: "https://example.invalid/series", headers: {} },
        cacheStatus: "disabled", responseStatus: 200, responseChecksum: payloadChecksum(bytes), providerReleaseId: null, errorDetail: null }],
      values: [{ sourceKey: SOURCE_KEY, marketDate: "2024-01-01", marketInstant: null, value: Math.random() }],
    },
  };
}

async function holdBatchPoolAndClaim(env: Record<string, string>): Promise<void> {
  const api = await bootApi({ env });
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
  let lockHeld!: () => void;
  const lockTaken = new Promise<void>((resolve) => (lockHeld = resolve));
  const holder = fixtureDb.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${SOURCE_KEY}, 0))`;
    lockHeld();
    await lockReleased;
  });
  let held: Promise<number>[] = [];
  try {
    await lockTaken;
    const health = (await (await fetch(`${api.base}/health`)).json()) as { db_pool: { batch: { max: number } } };
    // The batch pool's permits cover every cap that draws on it.
    expect(health.db_pool.batch.max).toBeGreaterThanOrEqual(ANALYTICS_CONCURRENCY + PIPELINE_SHARE);

    held = Array.from({ length: ANALYTICS_CONCURRENCY }, () =>
      fetch(`${api.base}${ROUTES.analytics.sourceAcquisitions}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${analyticsToken}` },
        body: JSON.stringify(acquisition()),
        signal: AbortSignal.timeout(30_000),
      }).then((r) => r.status));

    // Every analytics transaction is inside the database, waiting on the lock.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [{ n }] = await fixtureDb<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
      if (n === ANALYTICS_CONCURRENCY) break;
      if (Date.now() > deadline) throw new Error(`expected ${ANALYTICS_CONCURRENCY} acquisitions blocked on the source-key lock, saw ${n}`);
      await Bun.sleep(25);
    }

    const claims = await Promise.all(Array.from({ length: PIPELINE_SHARE }, async (_, i) => {
      const started = performance.now();
      const res = await fetch(`${api.base}${PIPELINE_ROUTES.claim}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pipelineToken}` },
        body: encodePipeline({ lane: { include: ["batch-pool.none"], exclude: [] }, workerId: `batch-pool-${i}` }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      return { status: res.status, ms: performance.now() - started, body };
    }));
    for (const c of claims) {
      expect(c.status, c.body).toBe(200);
      expect(c.ms).toBeLessThan(1_000);
    }
  } finally {
    releaseLock();
    await holder;
    const statuses = await Promise.all(held);
    api.stop();
    // Once the lock is gone the held acquisitions land.
    expect(statuses.every((s) => s === 200)).toBe(true);
  }
}

// The wallet backfill's gap read holds ONE batch connection (issue 1721).
//
// Production, v0.10.0 soak (run 20261121T220208Z): one
// `api error (503 /api/pipeline/read/gaps.reports) db_saturated gate=batch`.
// The holder was the request itself: gaps.reports ran one detectGaps per
// series through Promise.all, so the backfill's two-series read drew two batch
// connections, while the batch share counts one per pipeline request. With
// the analytics transactions holding theirs, the second pipeline request's
// fan-out found no free connection and its own read was refused.
//
// The fixture locks both gap series' tables, so every gap read that reaches
// the database stays there and is counted in pg_stat_activity. With the
// analytics cap held, PIPELINE_SHARE concurrent gaps.reports must hold exactly
// one connection each, and each must answer 200 once the lock is gone.
const GAP_TABLES = ["wallet_balance_samples", "wallet_sleeve_samples"];

async function holdBatchPoolAndReadGaps(): Promise<void> {
  const api = await bootApi({ env: {} });
  let releaseLocks!: () => void;
  const locksReleased = new Promise<void>((resolve) => (releaseLocks = resolve));
  let locksHeld!: () => void;
  const locksTaken = new Promise<void>((resolve) => (locksHeld = resolve));
  const holder = fixtureDb.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${SOURCE_KEY}, 0))`;
    for (const t of GAP_TABLES) await tx.unsafe(`LOCK TABLE ${t} IN ACCESS EXCLUSIVE MODE`);
    locksHeld();
    await locksReleased;
  });
  let held: Promise<number>[] = [];
  let reads: Promise<{ status: number; body: string }>[] = [];
  try {
    await locksTaken;
    held = Array.from({ length: ANALYTICS_CONCURRENCY }, () =>
      fetch(`${api.base}${ROUTES.analytics.sourceAcquisitions}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${analyticsToken}` },
        body: JSON.stringify(acquisition()),
        signal: AbortSignal.timeout(30_000),
      }).then((r) => r.status));
    reads = Array.from({ length: PIPELINE_SHARE }, () =>
      fetch(`${api.base}${PIPELINE_ROUTES.read("gaps.reports")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pipelineToken}` },
        body: encodePipeline({ args: [GAP_TABLES, new Date()] }),
        signal: AbortSignal.timeout(30_000),
      }).then(async (r) => ({ status: r.status, body: await r.text() })));

    // Wait until every analytics transaction and every gap read sits in the
    // database behind the fixture's locks, then name what holds the batch pool.
    const deadline = Date.now() + 10_000;
    let gapWaiters = 0;
    for (;;) {
      const [{ advisory, relation }] = await fixtureDb<{ advisory: number; relation: number }[]>`
        SELECT count(*) FILTER (WHERE wait_event = 'advisory')::int AS advisory,
               count(*) FILTER (WHERE wait_event = 'relation')::int AS relation
          FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      gapWaiters = relation;
      if (advisory === ANALYTICS_CONCURRENCY && relation >= PIPELINE_SHARE) break;
      if (Date.now() > deadline) {
        throw new Error(`expected ${ANALYTICS_CONCURRENCY} acquisitions and ${PIPELINE_SHARE} gap reads blocked, saw ${advisory} and ${relation}`);
      }
      await Bun.sleep(25);
    }
    // Past the admission wait: a fan-out that wanted more connections than
    // the batch pool had free would have been refused by now.
    await Bun.sleep(1_000);
    const health = (await (await fetch(`${api.base}/health`)).json()) as {
      db_pool: { batch: { max: number; in_use: number; refused_total: number } };
    };
    // The holders: the analytics cap, plus one connection per gaps.reports.
    expect(gapWaiters).toBe(PIPELINE_SHARE);
    expect(health.db_pool.batch.in_use).toBe(ANALYTICS_CONCURRENCY + PIPELINE_SHARE);
    expect(health.db_pool.batch.refused_total).toBe(0);
  } finally {
    releaseLocks();
    await holder;
    const statuses = await Promise.all(held);
    const answers = await Promise.all(reads);
    api.stop();
    expect(statuses.every((s) => s === 200)).toBe(true);
    for (const a of answers) expect(a.status, a.body).toBe(200);
  }
}

describe("gaps.reports while analytics transactions hold the batch pool", () => {
  test("each read holds one batch connection and none is refused", async () => {
    await holdBatchPoolAndReadGaps();
  }, 120_000);
});

describe("queue claims while analytics transactions hold the batch pool", () => {
  test("the default budget", async () => {
    await holdBatchPoolAndClaim({});
  }, 120_000);

  test("the small-instance budget", async () => {
    // A server with 12 connections for the api: the derivation's small-instance path.
    const limits = await readConnectionLimits(sql);
    const headroom = limits.maxConnections - limits.superuserReserved - limits.reserved - 12;
    await holdBatchPoolAndClaim({ PG_CONNECTION_HEADROOM: String(headroom) });
  }, 120_000);
});

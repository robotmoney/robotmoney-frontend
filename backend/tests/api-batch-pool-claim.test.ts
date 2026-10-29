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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

afterAll(async () => {
  await fixtureDb`UPDATE job_schedules SET enabled = true`;
});

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

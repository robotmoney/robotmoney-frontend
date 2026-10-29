// Request-path connections give up before the request deadline (issue 1034).
// The api's request pool carries statement, lock, idle-in-transaction and
// connect timeouts below Bun's 10 s request deadline, so a slow statement ends
// as `503 db_timeout` and frees its connection, instead of holding it until the
// client sees a 502. The batch pool keeps the long bulk timeouts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { createApiPools, type ApiPools } from "../src/db/client.ts";
import { deriveConnectionBudget } from "../src/db/connection-budget.ts";
import { dbFailureResponse } from "../src/api/db-failure.ts";
import { bootApi, type ApiProcess } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const IDLE_MS = 1_000;

describe("the request and batch pools, as the api builds them", () => {
  let pools: ApiPools;

  beforeAll(() => {
    // One connection a pool: no capped caller draws on these pools, only this test (issue 1514's batch invariant).
    const budget = deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, { request: 1, batch: 1 }, { analytics: 0, pipeline: 0 });
    pools = createApiPools(config.databaseUrl, budget, {
      request: { statementMs: 5_000, lockMs: 1_000, idleInTxnMs: IDLE_MS, connectMs: 5_000 },
    });
  });

  afterAll(async () => {
    await pools.end();
  });

  test("SHOW statement_timeout differs between request and batch connections as configured", async () => {
    const [request] = await pools.request<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    const [batch] = await pools.batch<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(request!.statement_timeout).toBe("5s");
    expect(batch!.statement_timeout).toBe("5min");
    const [lock] = await pools.request<{ lock_timeout: string }[]>`SHOW lock_timeout`;
    expect(lock!.lock_timeout).toBe("1s");
  });

  test("a request-path pg_sleep(8) answers 503 db_timeout in under 6s", async () => {
    const started = performance.now();
    let caught: unknown;
    try {
      await pools.request`SELECT pg_sleep(8)`;
    } catch (err) {
      caught = err;
    }
    const elapsed = performance.now() - started;
    expect((caught as { code?: string }).code).toBe("57014");
    expect(elapsed).toBeLessThan(6_000);
    const response = dbFailureResponse(caught)!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "db_timeout" });
    expect(response.headers.get("retry-after")).toBe("1");
    expect(pools.gates.request.stats().timeout_total).toBe(1);
    // The connection came back: the pool's one permit is free again.
    expect(pools.gates.request.stats().in_use).toBe(0);
  }, 15_000);

  test("an idle open transaction is terminated and its connection is reusable", async () => {
    let caught: unknown;
    try {
      await pools.request.begin(async (tx) => {
        await tx`SELECT 1`;
        await Bun.sleep(IDLE_MS + 750);
        await tx`SELECT 1`;
      });
    } catch (err) {
      caught = err;
    }
    // The server ended the idle session (idle_in_transaction_session_timeout),
    // so the transaction could not go on.
    expect(caught).toBeDefined();
    expect(pools.gates.request.stats().in_use).toBe(0);
    const [row] = await pools.request<{ one: number }[]>`SELECT 1 AS one`;
    expect(row!.one).toBe(1);
  }, 15_000);
});

describe("through the running api", () => {
  let api: ApiProcess;

  beforeAll(async () => {
    api = await bootApi({ env: { PG_REQUEST_LOCK_TIMEOUT_MS: "1000" } });
  }, 90_000);

  afterAll(() => api?.stop());

  test("a lock wait answers 503 db_timeout at lock_timeout, and health counts it", async () => {
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
    try {
      const started = performance.now();
      const res = await fetch(`${api.base}/api/comments?page=locked`, { signal: AbortSignal.timeout(15_000) });
      const elapsed = performance.now() - started;
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "db_timeout" });
      expect(res.headers.get("retry-after")).toBe("1");
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      releaseLock();
      await holder;
    }
    const health = (await (await fetch(`${api.base}/health`)).json()) as { db_pool: { request: { timeout_total: number; in_use: number } } };
    expect(health.db_pool.request.timeout_total).toBe(1);
    expect(health.db_pool.request.in_use).toBe(0);
    // And the connection serves the next request.
    expect((await fetch(`${api.base}/api/comments?page=locked`)).status).toBe(200);
  }, 30_000);
});

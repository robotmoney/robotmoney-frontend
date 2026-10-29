// The api's connection budget (issue 1034): its request, batch and probe
// shares are derived from the server's own max_connections, and an override
// that does not fit refuses the boot, naming the budget and each share.
//
// The batch share holds every cap that draws on it (issue 1514): the analytics
// limiter (ANALYTICS_CONCURRENCY), the pipeline token's gate
// (PIPELINE_TOKEN_CONCURRENCY) and the reserve for the uncapped lookups, on
// every server. A budget that cannot hold them refuses the boot.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { budgetOverridesFromEnv, readConnectionLimits } from "../src/db/connection-check.ts";
import {
  BATCH_UNCAPPED_RESERVE,
  ConnectionBudgetError,
  DEFAULT_HEADROOM,
  DEFAULT_REQUEST_SHARE,
  batchShareFor,
  deriveConnectionBudget,
  type BatchCaps,
} from "../src/db/connection-budget.ts";
import { ANALYTICS_CONCURRENCY } from "../src/api/routes/analytics.ts";
import { pipelineTokenConcurrency } from "../src/api/routes/pipeline.ts";
import { bootApi } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const total = (b: { request: number; batch: number; guard: number }) => b.request + b.batch + b.guard;
/** The caps the api boots with by default. */
const CAPS: BatchCaps = { analytics: ANALYTICS_CONCURRENCY, pipeline: pipelineTokenConcurrency({}) };
const fitsCaps = (b: { batch: number }, caps: BatchCaps = CAPS) => b.batch >= caps.analytics + caps.pipeline + BATCH_UNCAPPED_RESERVE;

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectionBudgetError);
    return (err as Error).message;
  }
  throw new Error("expected a ConnectionBudgetError");
}

describe("deriveConnectionBudget", () => {
  test("a roomy server gets the default request share and a batch share that holds both caps", () => {
    const b = deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, {}, CAPS);
    expect(b.available).toBe(100 - 3 - DEFAULT_HEADROOM);
    expect(b.request).toBe(DEFAULT_REQUEST_SHARE);
    expect(b.batch).toBe(batchShareFor(CAPS));
    expect(b.batch).toBe(ANALYTICS_CONCURRENCY + pipelineTokenConcurrency({}) + BATCH_UNCAPPED_RESERVE);
    expect(b.guard).toBe(1);
  });

  test("a small server shrinks the request share, never the batch share", () => {
    const b = deriveConnectionBudget({ maxConnections: 25, superuserReserved: 3, reserved: 2 }, {}, CAPS);
    expect(b.available).toBe(10);
    expect(total(b)).toBeLessThanOrEqual(b.available);
    expect(b.batch).toBe(batchShareFor(CAPS));
    expect(b.request).toBe(10 - 1 - batchShareFor(CAPS));
  });

  test("every derived budget, default and small-instance, fits both caps; a server too small for them refuses", () => {
    let derived = 0;
    let refused = 0;
    for (const pipeline of [1, 2, 3, 4]) {
      const caps = { analytics: ANALYTICS_CONCURRENCY, pipeline };
      for (let maxConnections = 10; maxConnections <= 60; maxConnections++) {
        for (const reserved of [0, 2]) {
          const limits = { maxConnections, superuserReserved: 3, reserved };
          let b;
          try {
            b = deriveConnectionBudget(limits, {}, caps);
          } catch (err) {
            expect(err).toBeInstanceOf(ConnectionBudgetError);
            refused++;
            continue;
          }
          derived++;
          expect(fitsCaps(b, caps)).toBe(true);
          expect(b.request).toBeGreaterThanOrEqual(1);
          expect(total(b)).toBeLessThanOrEqual(b.available);
        }
      }
    }
    expect(derived).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  test("a raised PIPELINE_TOKEN_CONCURRENCY raises the derived batch share with it", () => {
    const caps = { analytics: ANALYTICS_CONCURRENCY, pipeline: 4 };
    expect(deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, {}, caps).batch).toBe(ANALYTICS_CONCURRENCY + 4 + BATCH_UNCAPPED_RESERVE);
  });

  test("an unset share is derived from what an override leaves", () => {
    const b = deriveConnectionBudget({ maxConnections: 35, superuserReserved: 3, reserved: 0 }, { request: 14 }, CAPS);
    expect(b.request).toBe(14);
    expect(b.batch).toBe(batchShareFor(CAPS));
    expect(total(b)).toBeLessThanOrEqual(b.available);
  });

  test("a batch override below the caps refuses, naming the batch share and each cap", () => {
    const message = refusal(() => deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, { batch: 3 }, CAPS));
    expect(message).toContain("batch 3");
    expect(message).toContain(`analytics ${ANALYTICS_CONCURRENCY} (ANALYTICS_CONCURRENCY)`);
    expect(message).toContain(`pipeline ${pipelineTokenConcurrency({})} (PIPELINE_TOKEN_CONCURRENCY)`);
    expect(message).toContain(`reserve ${BATCH_UNCAPPED_RESERVE}`);
    expect(message).toContain("request 10");
    expect(message).toContain("guard 1");
    // A request override that leaves no room for the batch share refuses too, rather than shrinking it.
    expect(refusal(() => deriveConnectionBudget({ maxConnections: 30, superuserReserved: 3, reserved: 0 }, { request: 14 }, CAPS))).toContain(`batch ${batchShareFor(CAPS)}`);
  });

  test("an override that does not fit throws, naming the budget and every share", () => {
    const message = refusal(() => deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, { request: 80, batch: 10 }, CAPS));
    expect(message).toContain("connection budget 87");
    expect(message).toContain("max_connections 100");
    expect(message).toContain("request 80");
    expect(message).toContain("batch 10");
    expect(message).toContain("guard 1");
  });

  test("a server with no room left for the api throws even with no override", () => {
    expect(() => deriveConnectionBudget({ maxConnections: 14, superuserReserved: 3, reserved: 0 }, {}, CAPS)).toThrow(ConnectionBudgetError);
  });

  test("PG_POOL_MAX still sizes the request pool; PG_REQUEST_POOL_MAX wins over it", () => {
    expect(budgetOverridesFromEnv({ PG_POOL_MAX: "4" }).request).toBe(4);
    expect(budgetOverridesFromEnv({ PG_POOL_MAX: "4", PG_REQUEST_POOL_MAX: "6" }).request).toBe(6);
    expect(budgetOverridesFromEnv({ PG_BATCH_POOL_MAX: "2", PG_CONNECTION_HEADROOM: "5" })).toEqual({ headroom: 5, request: undefined, batch: 2 });
    expect(() => budgetOverridesFromEnv({ PG_BATCH_POOL_MAX: "two" })).toThrow("PG_BATCH_POOL_MAX");
  });
});

describe("against the real ephemeral Postgres", () => {
  test("the derived shares plus the guard fit max_connections minus the reservations and the headroom", async () => {
    const limits = await readConnectionLimits(sql);
    // The server's real values, not a default the code could have assumed.
    const [server] = await sql<{ max: number; su: number }[]>`
      SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS su`;
    expect(limits.maxConnections).toBe(server!.max);
    expect(limits.superuserReserved).toBe(server!.su);

    const budget = deriveConnectionBudget(limits, {}, CAPS);
    expect(total(budget)).toBeLessThanOrEqual(limits.maxConnections - limits.superuserReserved - DEFAULT_HEADROOM);
    expect(budget.request).toBeGreaterThanOrEqual(1);
    expect(fitsCaps(budget)).toBe(true);
  });

  test("an override exceeding the budget makes api boot exit non-zero, naming the budget and each share", async () => {
    let failure = "";
    try {
      const api = await bootApi({ env: { PG_REQUEST_POOL_MAX: "5000", PG_BATCH_POOL_MAX: "7" } });
      api.stop();
    } catch (err) {
      failure = (err as Error).message;
    }
    expect(failure).toContain("api exited with 1");
    expect(failure).toContain("connection budget");
    expect(failure).toContain("request 5000");
    expect(failure).toContain("batch 7");
    expect(failure).toContain("guard 1");
  }, 90_000);

  test("a batch pool below the caps makes api boot exit non-zero, naming the shares", async () => {
    let failure = "";
    try {
      const api = await bootApi({ env: { PG_BATCH_POOL_MAX: "3" } });
      api.stop();
    } catch (err) {
      failure = (err as Error).message;
    }
    expect(failure).toContain("api exited with 1");
    expect(failure).toContain("batch 3");
    expect(failure).toContain("ANALYTICS_CONCURRENCY");
    expect(failure).toContain("PIPELINE_TOKEN_CONCURRENCY");
  }, 90_000);

  test("a request timeout at or above the 10 s request deadline refuses the boot", async () => {
    let failure = "";
    try {
      const api = await bootApi({ env: { PG_REQUEST_STATEMENT_TIMEOUT_MS: "10000" } });
      api.stop();
    } catch (err) {
      failure = (err as Error).message;
    }
    expect(failure).toContain("api exited with 1");
    expect(failure).toContain("PG_REQUEST_STATEMENT_TIMEOUT_MS=10000");
  }, 90_000);
});

// The api's connection budget (issue 1034): its request, batch and probe
// shares are derived from the server's own max_connections, and an override
// that does not fit refuses the boot, naming the budget and each share.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { budgetOverridesFromEnv, readConnectionLimits } from "../src/db/connection-check.ts";
import {
  ConnectionBudgetError,
  DEFAULT_BATCH_SHARE,
  DEFAULT_HEADROOM,
  DEFAULT_REQUEST_SHARE,
  deriveConnectionBudget,
} from "../src/db/connection-budget.ts";
import { bootApi } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const total = (b: { request: number; batch: number; guard: number }) => b.request + b.batch + b.guard;

describe("deriveConnectionBudget", () => {
  test("a roomy server gets the default shares", () => {
    const b = deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 });
    expect(b.available).toBe(100 - 3 - DEFAULT_HEADROOM);
    expect(b.request).toBe(DEFAULT_REQUEST_SHARE);
    expect(b.batch).toBe(DEFAULT_BATCH_SHARE);
    expect(b.guard).toBe(1);
  });

  test("a small server shrinks both shares to fit, a quarter to batch", () => {
    const b = deriveConnectionBudget({ maxConnections: 25, superuserReserved: 3, reserved: 2 });
    expect(b.available).toBe(10);
    expect(total(b)).toBeLessThanOrEqual(b.available);
    expect(b.batch).toBe(2);
    expect(b.request).toBe(7);
  });

  test("an unset share is derived from what an override leaves", () => {
    const b = deriveConnectionBudget({ maxConnections: 30, superuserReserved: 3, reserved: 0 }, { request: 14 });
    expect(b.request).toBe(14);
    expect(b.batch).toBe(2);
    expect(total(b)).toBe(b.available);
  });

  test("an override that does not fit throws, naming the budget and every share", () => {
    let caught: unknown;
    try {
      deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, { request: 80, batch: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectionBudgetError);
    const message = (caught as Error).message;
    expect(message).toContain("connection budget 87");
    expect(message).toContain("max_connections 100");
    expect(message).toContain("request 80");
    expect(message).toContain("batch 10");
    expect(message).toContain("guard 1");
  });

  test("a server with no room left for the api throws even with no override", () => {
    expect(() => deriveConnectionBudget({ maxConnections: 14, superuserReserved: 3, reserved: 0 })).toThrow(ConnectionBudgetError);
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

    const budget = deriveConnectionBudget(limits);
    expect(total(budget)).toBeLessThanOrEqual(limits.maxConnections - limits.superuserReserved - DEFAULT_HEADROOM);
    expect(budget.request).toBeGreaterThanOrEqual(1);
    expect(budget.batch).toBeGreaterThanOrEqual(1);
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

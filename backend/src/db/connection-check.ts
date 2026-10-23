// The api's connection check: does the database still answer? Object-less (D55 (13)),
// so it takes the registry's `connectionCheck` shape and declares no relation.
// And the boot read of the server's connection limits the api sizes its pools
// from (`connectionBudget`, issue 1034).
//
// Its own module, and not a statement in src/api/index.ts, because the entry
// binds a port at import: CI enumerates registrations by importing modules, and
// an entry cannot be one of them.
import postgres from "postgres";
import { config } from "../config.ts";
import { configureApiPools, probeSql } from "./client.ts";
import { deriveConnectionBudget, type BudgetOverrides, type ConnectionBudget, type ServerConnectionLimits } from "./connection-budget.ts";
import { onStatement, registerStatement, type RegistryDb } from "./registry.ts";

const connectionCheck = registerStatement({
  role: "rm_app",
  shape: "connectionCheck",
  site: "src/db/connection-check:databaseAnswers",
  purpose: "Answer whether the api still reaches the database, for GET /health, on the probe's own connection.",
  callers: ["src/api/index"],
});

const connectionBudget = registerStatement({
  role: "rm_app",
  shape: "connectionBudget",
  site: "src/db/connection-check:readConnectionLimits",
  purpose: "Read max_connections and the reserved slots the api's pool budget is derived from at boot.",
  callers: ["src/api/index"],
});

/** How long GET /health waits for its probe before it reports the database down. */
export const HEALTH_PROBE_BUDGET_MS = 1_000;

// One probe at a time: concurrent health checks share the one in flight, so a
// burst of them never queues on the probe's single connection.
let probing: Promise<boolean> | null = null;

/**
 * True when `SELECT 1` answers on the probe's own connection within
 * HEALTH_PROBE_BUDGET_MS; false on any error or on the deadline. Never waits on
 * the request or batch pool, so a saturated pool cannot stall GET /health.
 */
export function databaseAnswers(): Promise<boolean> {
  probing ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        onStatement(probeSql(), connectionCheck)`SELECT 1`.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), HEALTH_PROBE_BUDGET_MS);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      probing = null;
    }
  })();
  return probing;
}

/** The server's connection limits, read on `db`. */
export async function readConnectionLimits(db: RegistryDb): Promise<ServerConnectionLimits> {
  const [row] = await onStatement(db, connectionBudget)<{ max_connections: number; superuser_reserved: number; reserved: number }>`SELECT current_setting('max_connections')::int AS max_connections, current_setting('superuser_reserved_connections')::int AS superuser_reserved, current_setting('reserved_connections')::int AS reserved`;
  return { maxConnections: row!.max_connections, superuserReserved: row!.superuser_reserved, reserved: row!.reserved };
}

const optionalInt = (env: Record<string, string | undefined>, key: string): number | undefined => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`api refused to start: ${key}=${JSON.stringify(raw)} is not a non-negative integer`);
  return n;
};

/** The operator's pool overrides. PG_POOL_MAX, the pool's old single knob, still sizes the request pool. */
export function budgetOverridesFromEnv(env: Record<string, string | undefined> = process.env): BudgetOverrides {
  return {
    headroom: optionalInt(env, "PG_CONNECTION_HEADROOM"),
    request: optionalInt(env, "PG_REQUEST_POOL_MAX") ?? optionalInt(env, "PG_POOL_MAX"),
    batch: optionalInt(env, "PG_BATCH_POOL_MAX"),
  };
}

/**
 * The api's boot step: read the server's limits on a short-lived connection,
 * derive the budget, and install the request, batch and probe pools. Throws
 * ConnectionBudgetError, naming the budget and each share, when an override
 * does not fit.
 */
export async function configureApiPoolsFromServer(env: Record<string, string | undefined> = process.env): Promise<ConnectionBudget> {
  const overrides = budgetOverridesFromEnv(env);
  const once = postgres(config.databaseUrl, { max: 1, onnotice: () => {}, connect_timeout: 5, connection: { statement_timeout: 5_000 } });
  let limits: ServerConnectionLimits;
  try {
    limits = await readConnectionLimits(once);
  } finally {
    await once.end({ timeout: 5 });
  }
  const budget = deriveConnectionBudget(limits, overrides);
  await configureApiPools(budget);
  return budget;
}

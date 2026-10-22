import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { config } from "../config.ts";
import { testSeamArmed, testSeamRefusal } from "../test-seam.ts";
import type { ConnectionBudget } from "./connection-budget.ts";
import { createPoolGate, DB_TIMEOUT_CODES, DbSaturatedError, gatedPool, type PoolGate, type PoolGateStats } from "./pool-gate.ts";

// ── Server-side timeouts ────────────────────────────────────────────────────
// Applied as startup parameters, so EVERY statement and transaction on a pool
// inherits them: the DATABASE, not the proxy's patience, is the thing that
// gives up.
//
// The general pool (every process but the api: migrate, seed, operator
// scripts) and the api's BATCH pool keep the generous bulk budget: the projects
// discovery pass writes ~2,800 rows in one transaction, and a full analytics
// backfill is a bulk write too.
//
// The api's REQUEST pool answers public, member and admin routes, which Bun
// kills at 10 s (API_IDLE_TIMEOUT_SECONDS). A request-path statement that runs
// longer is already lost, so it must not keep its connection either: each
// request timeout sits below 10 s, and api boot refuses one that does not
// (issue 1034).
export interface PoolTimeouts {
  readonly statementMs: number;
  /** null: no lock_timeout, a lock wait is bounded by the statement timeout alone. */
  readonly lockMs: number | null;
  readonly idleInTxnMs: number;
  readonly connectMs: number;
}

const envMs = (key: string, fallback: number): number => {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === "" ? fallback : Number(raw);
};

export function bulkTimeouts(): PoolTimeouts {
  return {
    statementMs: envMs("PG_STATEMENT_TIMEOUT_MS", 300_000), // 5 min
    lockMs: null,
    idleInTxnMs: envMs("PG_IDLE_IN_TXN_TIMEOUT_MS", 600_000), // 10 min
    connectMs: 30_000,
  };
}

/** The request pool's ceiling for every timeout: Bun's request deadline. */
export const REQUEST_TIMEOUT_CEILING_MS = 10_000;

export function requestTimeouts(): PoolTimeouts {
  return {
    statementMs: envMs("PG_REQUEST_STATEMENT_TIMEOUT_MS", 5_000),
    lockMs: envMs("PG_REQUEST_LOCK_TIMEOUT_MS", 3_000),
    idleInTxnMs: envMs("PG_REQUEST_IDLE_IN_TXN_TIMEOUT_MS", 5_000),
    connectMs: envMs("PG_REQUEST_CONNECT_TIMEOUT_MS", 5_000),
  };
}

/** Throw unless every request timeout is a positive number below REQUEST_TIMEOUT_CEILING_MS. */
export function assertRequestTimeouts(t: PoolTimeouts): void {
  const named: [string, number | null][] = [
    ["PG_REQUEST_STATEMENT_TIMEOUT_MS", t.statementMs],
    ["PG_REQUEST_LOCK_TIMEOUT_MS", t.lockMs],
    ["PG_REQUEST_IDLE_IN_TXN_TIMEOUT_MS", t.idleInTxnMs],
    ["PG_REQUEST_CONNECT_TIMEOUT_MS", t.connectMs],
  ];
  for (const [key, ms] of named) {
    if (ms === null || !Number.isFinite(ms) || ms <= 0 || ms >= REQUEST_TIMEOUT_CEILING_MS) {
      throw new Error(
        `api refused to start: ${key}=${ms} — every request-pool timeout must be above 0 and below ` +
          `${REQUEST_TIMEOUT_CEILING_MS}ms, the request deadline (issue 1034).`,
      );
    }
  }
}

function makePool(url: string, max: number, t: PoolTimeouts): postgresTypes.Sql<{}> {
  return postgres(url, {
    max,
    onnotice: () => {}, // silence NOTICE spam (e.g. "table already exists")
    connect_timeout: t.connectMs / 1000,
    connection: {
      statement_timeout: t.statementMs,
      idle_in_transaction_session_timeout: t.idleInTxnMs,
      ...(t.lockMs === null ? {} : { lock_timeout: t.lockMs }),
    },
  });
}

// ── The api's pools ─────────────────────────────────────────────────────────
// Every process starts on ONE general pool (PG_POOL_MAX, bulk timeouts), which
// is all a script or a test needs. The api replaces it at boot, before it binds
// a port (configureApiPools, from connection-check.ts's budget read), with:
//
//   - request: public, member and admin routes. Short timeouts, admission gate.
//   - batch:   analytics-provider bulk work (runOnBatchPool). Bulk timeouts,
//              its own admission gate, so a flood of bulk writes can exhaust
//              only this pool while the site keeps answering.
//   - probe:   one connection for GET /health, so health never waits behind a
//              saturated pool.
//
// Each gate answers a query that finds no free connection within the admission
// wait with DbSaturatedError, which api/index.ts turns into 503 db_saturated.
export interface ApiPools {
  readonly request: postgresTypes.Sql<{}>;
  readonly batch: postgresTypes.Sql<{}>;
  readonly probe: postgresTypes.Sql<{}>;
  readonly gates: { readonly request: PoolGate; readonly batch: PoolGate };
  readonly budget: ConnectionBudget;
  end(): Promise<void>;
}

export interface ApiPoolOptions {
  readonly request?: PoolTimeouts;
  readonly batch?: PoolTimeouts;
  /** How long a query may wait for a free connection before it is refused. */
  readonly admissionWaitMs?: number;
}

export const DEFAULT_ADMISSION_WAIT_MS = 500;

/** Build the api's three pools for `url`, sized by `budget`. Not installed: see configureApiPools. */
export function createApiPools(url: string, budget: ConnectionBudget, options: ApiPoolOptions = {}): ApiPools {
  const request = options.request ?? requestTimeouts();
  assertRequestTimeouts(request);
  const batch = options.batch ?? bulkTimeouts();
  const waitMs = options.admissionWaitMs ?? envMs("PG_ADMISSION_WAIT_MS", DEFAULT_ADMISSION_WAIT_MS);
  const gates = {
    request: createPoolGate("request", budget.request, waitMs),
    batch: createPoolGate("batch", budget.batch, waitMs),
  };
  const rawRequest = makePool(url, budget.request, request);
  const rawBatch = makePool(url, budget.batch, batch);
  const probe = postgres(url, {
    max: budget.guard,
    onnotice: () => {},
    connect_timeout: 1,
    connection: { statement_timeout: 1_000 },
  });
  return {
    request: gatedPool(rawRequest, gates.request),
    batch: gatedPool(rawBatch, gates.batch),
    probe,
    gates,
    budget,
    end: async () => {
      await Promise.all([rawRequest.end({ timeout: 5 }), rawBatch.end({ timeout: 5 }), probe.end({ timeout: 5 })]);
    },
  };
}

let general = makePool(config.databaseUrl, Number(process.env.PG_POOL_MAX ?? 10), bulkTimeouts());
let apiPools: ApiPools | null = null;
let apiPoolOptions: ApiPoolOptions = {};
const poolScope = new AsyncLocalStorage<"batch">();

/** Install the api's pools in place of the general one. The api's boot calls this once, before Bun.serve. */
export async function configureApiPools(budget: ConnectionBudget, options: ApiPoolOptions = {}): Promise<void> {
  const next = createApiPools(config.databaseUrl, budget, options);
  const previous = apiPools;
  apiPools = next;
  apiPoolOptions = options;
  await (previous ? previous.end() : general.end({ timeout: 5 }));
}

/** Run `fn` with every `sql` statement it issues on the batch pool (no-op before configureApiPools). */
export function runOnBatchPool<T>(fn: () => T): T {
  return poolScope.run("batch", fn);
}

function currentPool(): postgresTypes.Sql<{}> {
  if (!apiPools) return general;
  return poolScope.getStore() === "batch" ? apiPools.batch : apiPools.request;
}

/** The health probe's own connection, or the general pool before configureApiPools. */
export function probeSql(): postgresTypes.Sql<{}> {
  return apiPools?.probe ?? general;
}

export interface DbPoolTelemetry {
  readonly request: PoolGateStats;
  readonly batch: PoolGateStats;
  readonly budget: ConnectionBudget;
}

/** Per-pool counts for GET /health, or null in a process that never configured the api's pools. */
export function dbPoolTelemetry(): DbPoolTelemetry | null {
  if (!apiPools) return null;
  return { request: apiPools.gates.request.stats(), batch: apiPools.gates.batch.stats(), budget: apiPools.budget };
}

// The one handle every store imports. A facade, not a pool: each call goes to
// the pool the CALLER is running on — the batch pool inside runOnBatchPool, the
// request pool otherwise, the general pool in a process that never configured
// the api's pools. Importers keep `import { sql }` and never choose a pool
// themselves; the route that admits the request chooses it once.
export const sql: postgresTypes.Sql<{}> = new Proxy(function () {} as unknown as postgresTypes.Sql<{}>, {
  apply: (_target, thisArg, args) => Reflect.apply(currentPool() as unknown as (...a: unknown[]) => unknown, thisArg, args),
  get: (_target, prop) => {
    const pool = currentPool();
    const value = Reflect.get(pool, prop);
    return typeof value === "function" && prop !== "PostgresError" ? value.bind(pool) : value;
  },
  has: (_target, prop) => prop in currentPool(),
});

// Point the process at a different database: rebuild this pool, and move the
// URL every other pool is built from.
//
// TEST SEAM. `bun test` runs every backend test file in ONE process sharing one
// module cache, so this module's pool — created at import time from
// DATABASE_URL — is the single pool all ~129 test files use. That is what made
// the suite a dirty-database-reuse harness: the only cleanup available to a
// fixture was DELETE/TRUNCATE, which migration 0032 now refuses on the
// append-only tables. tests/support/clean-db.ts calls this in `beforeAll` to
// give a file its own database cloned from a migrated template, and again in
// `afterAll` to hand the shared database back. Production never calls it.
//
// Moving `config.databaseUrl` (and DATABASE_URL with it) is not incidental:
// db/handle-namespace.ts builds its guard client from `config.databaseUrl` at
// CALL time, so a redirect that skipped it would leave that one client talking
// to the database everyone else just left. db/worker-client.ts owns a second
// long-lived pool and exports its own setDatabase() for the same reason —
// worker/** may not import this module, so it cannot be rebuilt from here.
//
// REFUSED UNLESS THE TEST SEAM IS ARMED (backend/src/test-seam.ts). Being a
// test seam is a claim about where it may run, and an exported function that
// silently re-points a deployed process's database at an attacker-chosen or
// merely mistaken URL is not a claim worth making on a comment alone. Only
// backend/tests/preload.ts arms the seam, so a deployed process refuses
// whatever its environment says (issue #973: no RM_ENV value opens it).
export async function setDatabase(url: string, options: { purpose?: "migration" } = {}): Promise<void> {
  const migrationRedirect = options.purpose === "migration" && url === process.env.MIGRATE_DATABASE_URL;
  if (!testSeamArmed() && !migrationRedirect) {
    throw testSeamRefusal(
      "db/client.setDatabase()",
      "Point the process at a different database with DATABASE_URL and restart it.",
    );
  }
  process.env.DATABASE_URL = url;
  config.databaseUrl = url;
  if (apiPools) {
    await configureApiPools(apiPools.budget, apiPoolOptions);
    return;
  }
  const previous = general;
  general = makePool(url, Number(process.env.PG_POOL_MAX ?? 10), bulkTimeouts());
  await previous.end({ timeout: 5 });
}

// A database handle store writers accept: either the shared pool or a
// transaction handle from sql.begin (postgres.js's TransactionSql does not
// structurally extend Sql — it lacks the pool lifecycle members — so writers
// that must run inside an API-route transaction take this union; issue #106).
export type DbHandle = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

// postgres.js intentionally requires a structural JSON type with an index
// signature. Domain DTO interfaces do not carry that signature even when every
// field is serializable, so keep the assertion at this single persistence seam.
export function jsonValue(value: unknown): postgresTypes.JSONValue {
  return value as postgresTypes.JSONValue;
}

export async function closeDb(): Promise<void> {
  await (apiPools ? apiPools.end() : general.end({ timeout: 5 }));
}

// ── "the database is not reachable" vs "the query was wrong" ────────────────
// Issue #968. Every route handler's failure used to leave the api by the same
// door — `500 {"error":"internal error"}` — so a Postgres outage was
// indistinguishable from a bug in the handler, to the page (which printed the
// serialized envelope), to an operator reading a screenshot, and to any other
// client. These are the failures where the database is the thing that is
// wrong; api/index.ts answers them 503 instead.
//
// Deliberately NARROW. A misspelled column (42703) and a missing relation
// (42P01) are handler bugs and must keep reporting as 500s: widening this to
// "any error thrown by a query" would relabel every real defect as an outage
// and make the distinction worthless.
//
// Two families:
//   - transport, from Node/Bun's socket layer — nothing is listening, the name
//     does not resolve, the connection died mid-flight;
//   - postgres.js's own lifecycle codes, plus SQLSTATE class 08 (connection
//     exception) and 57P03 (the server is up but refusing connections, e.g.
//     still starting or shutting down), which is what a restarting database
//     answers with.
const DB_UNAVAILABLE_CODES = new Set([
  // socket / DNS
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  // postgres.js connection lifecycle
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  // SQLSTATE 57P03 cannot_connect_now
  "57P03",
]);

export function isDatabaseUnavailable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== "string") return false;
  // SQLSTATE class 08 — connection_exception and its refinements.
  return DB_UNAVAILABLE_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code);
}

// ── "the database is busy" (issue 1034) ─────────────────────────────────────
// Two more 503s, each with its own name, because each tells the caller
// something different to do:
//
//   - db_saturated: the api refused to queue the request, because its pool had
//     no free connection within the admission wait (pool-gate.ts). Nothing ran.
//     Retry after a moment.
//   - db_timeout: the server gave up on the statement — statement_timeout or a
//     user cancel (57014), or lock_timeout (55P03). The request pool's timeouts
//     sit below the request deadline, so this is the answer a slow request gets
//     instead of a dropped connection.
//
// Both are deliberately outside isDatabaseUnavailable: the database is
// answering, and a test there pins 57014 as "not an outage".
export type DbFailure = "database unavailable" | "db_saturated" | "db_timeout";

/** Which 503 a database error earns, or null when it is a handler bug (500). */
export function classifyDbFailure(err: unknown): DbFailure | null {
  if (err instanceof DbSaturatedError) return "db_saturated";
  if (isDatabaseUnavailable(err)) return "database unavailable";
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DB_TIMEOUT_CODES.has(code)) return "db_timeout";
  return null;
}

import postgres from "postgres";
import type postgresTypes from "postgres";
import { config } from "../config.ts";

function makePool(url: string): postgresTypes.Sql<{}> {
  return postgres(url, {
    max: Number(process.env.PG_POOL_MAX ?? 10),
    onnotice: () => {}, // silence NOTICE spam (e.g. "table already exists")
  });
}

// Single shared connection pool. postgres.js gives us tagged-template SQL with
// parameterization and easy access to raw queries (needed for FOR UPDATE
// SKIP LOCKED in the task queue).
//
// `let`, not `const`, for exactly one reason: setDatabase() below. Importers
// use `import { sql }`, an ESM live binding, so they observe the rebuilt pool
// without re-importing. Nothing in production ever reassigns it.
export let sql = makePool(config.databaseUrl);

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
export async function setDatabase(url: string): Promise<void> {
  process.env.DATABASE_URL = url;
  config.databaseUrl = url;
  const previous = sql;
  sql = makePool(url);
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
  await sql.end({ timeout: 5 });
}

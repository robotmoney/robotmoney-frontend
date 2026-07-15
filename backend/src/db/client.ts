import postgres from "postgres";
import type postgresTypes from "postgres";
import { config } from "../config.ts";

// Single shared connection pool. postgres.js gives us tagged-template SQL with
// parameterization and easy access to raw queries (needed for FOR UPDATE
// SKIP LOCKED in the task queue).
export const sql = postgres(config.databaseUrl, {
  max: Number(process.env.PG_POOL_MAX ?? 10),
  onnotice: () => {}, // silence NOTICE spam (e.g. "table already exists")
});

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

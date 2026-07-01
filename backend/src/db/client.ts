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

// postgres.js intentionally requires a structural JSON type with an index
// signature. Domain DTO interfaces do not carry that signature even when every
// field is serializable, so keep the assertion at this single persistence seam.
export function jsonValue(value: unknown): postgresTypes.JSONValue {
  return value as postgresTypes.JSONValue;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

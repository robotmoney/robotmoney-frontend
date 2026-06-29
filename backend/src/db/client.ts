import postgres from "postgres";
import { config } from "../config.ts";

// Single shared connection pool. postgres.js gives us tagged-template SQL with
// parameterization and easy access to raw queries (needed for FOR UPDATE
// SKIP LOCKED in the task queue).
export const sql = postgres(config.databaseUrl, {
  max: Number(process.env.PG_POOL_MAX ?? 10),
  onnotice: () => {}, // silence NOTICE spam (e.g. "table already exists")
});

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

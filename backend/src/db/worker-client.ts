// Worker-scoped Postgres pool (issue #106). The worker process keeps narrowly
// scoped database access for QUEUE lifecycle (jobs/job_runs/job_schedules) and
// the legacy non-analytics samplers — but its connection must not authorize
// mutations to the analytics data tables (raw_indicator_history,
// regime_snapshots, research_signals): analytics outputs are submitted through
// the authenticated /api/analytics boundary instead.
//
// WORKER_DATABASE_URL points this pool at the restricted `rm_worker` role
// provisioned by migrations/0016_worker_role.sql (grants on everything EXCEPT
// analytics-table writes). It falls back to DATABASE_URL for ephemeral/CI and
// local convenience — deployments that want DB-level enforcement either set
// WORKER_DATABASE_URL or hand the worker process a restricted DATABASE_URL.
//
// Source-level boundary: worker/** imports THIS module, never db/client.ts —
// enforced by tests/analytics-api-boundary.test.ts.
import postgres from "postgres";
import type postgresTypes from "postgres";
import { config } from "../config.ts";

export const sql = postgres(process.env.WORKER_DATABASE_URL || config.databaseUrl, {
  max: Number(process.env.PG_POOL_MAX ?? 10),
  onnotice: () => {}, // silence NOTICE spam
});

// Same single-seam JSON assertion as db/client.ts.
export function jsonValue(value: unknown): postgresTypes.JSONValue {
  return value as postgresTypes.JSONValue;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

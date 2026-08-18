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

// Server-side timeouts, applied as startup parameters so EVERY statement and
// transaction on this pool inherits them. The worker drains its lane serially
// in one process, so an unbounded statement (a hung bulk upsert, a lock wait)
// stalls every other scheduled job behind it indefinitely — and the queue's own
// reaper cannot help, because lease renewal keeps refreshing `locked_at` for a
// job that is alive but stuck. These make the database, not the queue, the
// thing that gives up. Generous by default (the projects discovery pass writes
// ~2,800 rows in one transaction) and overridable per deployment.
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 300_000); // 5 min
const IDLE_IN_TXN_TIMEOUT_MS = Number(process.env.PG_IDLE_IN_TXN_TIMEOUT_MS ?? 600_000); // 10 min

function makePool(url: string): postgresTypes.Sql<{}> {
  return postgres(url, {
    max: Number(process.env.PG_POOL_MAX ?? 10),
    onnotice: () => {}, // silence NOTICE spam
    connection: {
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TXN_TIMEOUT_MS,
    },
  });
}

// `let`, not `const`, for exactly one reason: setDatabase() below. Importers
// use `import { sql }`, an ESM live binding, so they observe the rebuilt pool.
// Nothing in production ever reassigns it.
export let sql = makePool(process.env.WORKER_DATABASE_URL || config.databaseUrl);

// Point this pool at a different database, closing the old one.
//
// TEST SEAM, the twin of db/client.ts's setDatabase(). It has to be a second
// function rather than a call from there because the source-level boundary runs
// the other way: worker/** imports this module and never db/client.ts. Without
// it, a test file that redirects the shared pool to its own clean database
// would leave every queue lifecycle call still writing to the shared one — the
// two would silently disagree about which jobs exist.
//
// The WORKER_DATABASE_URL fallback is deliberately NOT re-applied: the caller
// is naming the database this process must now use, and tests never provision
// the restricted `rm_worker` role's URL.
//
// Which is exactly why this REFUSES OUTSIDE `ephemeral`. Dropping that fallback
// is a privilege change, not just a redirect: a call in a deployed worker would
// move the process off the restricted `rm_worker` role
// (migrations/0016_worker_role.sql:42) and onto the owner role in
// `config.databaseUrl` — silently undoing the analytics write boundary that
// tests/analytics-worker-role.test.ts exists to prove. `config.env` fails
// closed to "prod" when RM_ENV is unset (config.ts).
export async function setDatabase(url: string): Promise<void> {
  if (config.env !== "ephemeral") {
    throw new Error(
      `db/worker-client.setDatabase() is a test-only seam and refuses to run under RM_ENV=${config.env}. ` +
        "Point the worker at a different database with WORKER_DATABASE_URL and restart it.",
    );
  }
  const previous = sql;
  sql = makePool(url);
  await previous.end({ timeout: 5 });
}

// Same single-seam JSON assertion as db/client.ts.
export function jsonValue(value: unknown): postgresTypes.JSONValue {
  return value as postgresTypes.JSONValue;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

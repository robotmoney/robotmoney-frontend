// Restricted worker database role (issue #106; migrations/0016_worker_role.sql)
// exercised against the REAL ephemeral Postgres the preload provisions.
//
// The worker's configured credentials (WORKER_DATABASE_URL → the rm_worker
// role) must be able to run the FULL queue lifecycle — enqueue, claim
// (FOR UPDATE SKIP LOCKED), complete, record job_runs — while INSERT/UPDATE/
// DELETE on the analytics data tables (raw_indicator_history, regime_snapshots,
// research_signals) fail with permission denied (SQLSTATE 42501). This is the
// database-permission half of the boundary; the source-import half lives in
// analytics-api-boundary.test.ts.
import { test, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";

const WORKER_PASSWORD = "rm_worker_ci_password";
let worker: postgres.Sql<{}>;

beforeAll(async () => {
  // Provision login credentials for the migration-created role (the migration
  // deliberately ships NO password — an operator sets one out-of-band; CI is
  // that operator here) and connect exactly as a deployed worker would via
  // WORKER_DATABASE_URL.
  await sql.unsafe(`ALTER ROLE rm_worker WITH LOGIN PASSWORD '${WORKER_PASSWORD}'`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = "rm_worker";
  url.password = WORKER_PASSWORD;
  process.env.WORKER_DATABASE_URL = url.toString();
  worker = postgres(url.toString(), { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  delete process.env.WORKER_DATABASE_URL;
  await worker?.end({ timeout: 5 });
});

test("queue lifecycle works under the restricted role: enqueue → claim → complete → job_runs", async () => {
  // Enqueue (the scheduler INSERTs jobs) with the restricted connection.
  const [{ id }] = await worker`
    INSERT INTO jobs (kind, payload) VALUES ('noop', '{}') RETURNING id`;

  // Claim exactly like worker/loop.ts (FOR UPDATE SKIP LOCKED + UPDATE).
  const claimed = await worker`
    WITH claimed AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now() AND id = ${id}
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs j
       SET status = 'running', attempts = attempts + 1,
           locked_at = now(), locked_by = 'role-test', updated_at = now()
      FROM claimed
     WHERE j.id = claimed.id
     RETURNING j.id`;
  expect(claimed.length).toBe(1);

  // Complete + record the run, in a transaction, still under the worker role.
  await worker.begin(async (tx) => {
    await tx`UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = now() WHERE id = ${id}`;
    await tx`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status) VALUES (${id}, 'noop', now(), now(), 'succeeded')`;
  });
  const [job] = await worker`SELECT status FROM jobs WHERE id = ${id}`;
  expect(job.status).toBe("succeeded");
  const [{ n }] = await worker`SELECT COUNT(*)::int AS n FROM job_runs WHERE job_id = ${id}`;
  expect(n).toBe(1);

  // Schedules too (the scheduler updates next_run_at/last_enqueued_at).
  await worker`INSERT INTO job_schedules (kind, cron, enabled) VALUES ('role.test', '0 0 * * *', false)`;
  await worker`UPDATE job_schedules SET next_run_at = now() WHERE kind = 'role.test'`;
  await worker`DELETE FROM job_schedules WHERE kind = 'role.test'`;
});

test("analytics data tables DENY insert/update/delete to the worker role (42501), reads still allowed", async () => {
  // Seed one row per table with the OWNER connection so UPDATE/DELETE have a target.
  await sql`INSERT INTO raw_indicator_history (date, indicator, value) VALUES ('1997-01-01', 'ROLE_TEST', 1)
            ON CONFLICT (date, indicator) DO UPDATE SET value = 1`;
  await sql`INSERT INTO regime_snapshots (date, composite, percentiles, indicators)
            VALUES ('1997-01-01', 0.5, '{}'::jsonb, '[]'::jsonb)
            ON CONFLICT (date) DO UPDATE SET composite = 0.5`;
  await sql`INSERT INTO research_signals (signal_key, date, payload) VALUES ('role-test', '1997-01-01', '{}'::jsonb)
            ON CONFLICT (signal_key, date) DO UPDATE SET payload = '{}'::jsonb`;

  const denied = async (q: Promise<unknown>) => {
    try {
      await q;
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? "unknown";
    }
  };

  // INSERT
  expect(await denied(worker`INSERT INTO raw_indicator_history (date, indicator, value) VALUES ('1997-01-02', 'ROLE_TEST', 2)`)).toBe("42501");
  expect(await denied(worker`INSERT INTO regime_snapshots (date) VALUES ('1997-01-02')`)).toBe("42501");
  expect(await denied(worker`INSERT INTO research_signals (signal_key, date, payload) VALUES ('role-test', '1997-01-02', '{}'::jsonb)`)).toBe("42501");
  // UPDATE
  expect(await denied(worker`UPDATE raw_indicator_history SET value = 9 WHERE indicator = 'ROLE_TEST'`)).toBe("42501");
  expect(await denied(worker`UPDATE regime_snapshots SET composite = 0.9 WHERE date = '1997-01-01'`)).toBe("42501");
  expect(await denied(worker`UPDATE research_signals SET payload = '{"x":1}'::jsonb WHERE signal_key = 'role-test'`)).toBe("42501");
  // DELETE
  expect(await denied(worker`DELETE FROM raw_indicator_history WHERE indicator = 'ROLE_TEST'`)).toBe("42501");
  expect(await denied(worker`DELETE FROM regime_snapshots WHERE date = '1997-01-01'`)).toBe("42501");
  expect(await denied(worker`DELETE FROM research_signals WHERE signal_key = 'role-test'`)).toBe("42501");

  // The rows are untouched, and the worker role can still READ them (committee
  // jobs read regime projections).
  const [row] = await worker`SELECT value FROM raw_indicator_history WHERE indicator = 'ROLE_TEST' AND date = '1997-01-01'`;
  expect(Number(row.value)).toBe(1);
  const [snap] = await worker`SELECT composite FROM regime_snapshots WHERE date = '1997-01-01'`;
  expect(Number(snap.composite)).toBe(0.5);

  // Cleanup with the owner connection.
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'ROLE_TEST'`;
  await sql`DELETE FROM regime_snapshots WHERE date = '1997-01-01'`;
  await sql`DELETE FROM research_signals WHERE signal_key = 'role-test'`;
});

test("non-analytics sampler tables stay writable to the worker role (legacy handlers unaffected)", async () => {
  await worker`INSERT INTO vault_share_price_history (vault_address, sample_hour, total_assets, total_supply)
               VALUES ('0xroletest', '1997-01-01T00:00:00Z', 0, 0)`;
  await worker`DELETE FROM vault_share_price_history WHERE vault_address = '0xroletest'`;
});

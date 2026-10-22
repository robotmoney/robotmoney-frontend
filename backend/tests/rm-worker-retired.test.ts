// rm_worker holds no privilege (issue 1034, decision D75, migration 0127).
//
// Rewritten from analytics-worker-role.test.ts, which proved what the
// restricted worker role could and could not do while the pipeline worker
// still connected as it. Nothing connects as rm_worker now: the worker reaches
// the database only through the api. This file logs in AS rm_worker (a real
// login, never a superuser under SET ROLE) on a database built by replaying
// every migration, and proves:
//
//   - SELECT and INSERT on `jobs` and on every pipeline data table the worker
//     used to write are refused by grant (42501), and so is the schema itself;
//   - the catalog agrees: rm_worker holds no privilege on any relation or
//     sequence in `public`, no USAGE on it, and rm_owner's default privileges
//     grant it nothing on future objects;
//   - re-applying migration 0127 is a no-op.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { adminExec, restoreRoleBaseline } from "./support/cluster.ts";

// The migration-built template: the state 0127 itself leaves, with no grant
// reconciliation run after it.
useCleanDatabase(import.meta.file, { migrationBuilt: true });

const MIGRATION = join(import.meta.dir, "..", "migrations", "0127_rm_worker_retired.sql");
const PASSWORD = "rm_worker_retired_ci_password";

// Every table the pipeline worker wrote as rm_worker (backend/schema/grants.sql's
// worker lists before issue 1034), plus the queue.
const PIPELINE_TABLES = [
  "jobs", "job_runs", "job_schedules",
  "agent_revenue_daily", "agent_vaults", "chain_address_floors", "chain_day_blocks", "daily_agent_snapshots",
  "daily_coin_snapshots", "daily_tvl_snapshots", "daily_wallet_snapshots", "lobster_coins", "openclaw_agents",
  "projects", "tracked_wallets", "vault_adapter_samples", "vault_share_price_history", "wallet_backfill_state",
  "wallet_balance_samples", "wallet_sleeve_samples", "asset_price_floors", "asset_prices", "buyback_scan_state",
  "token_market_samples", "wallet_balance_sample_evidence", "wallet_sleeve_sample_evidence", "buyback_swaps",
] as const;

let worker: postgres.Sql<{}>;

beforeAll(async () => {
  // cluster admin: ALTER ROLE is superuser-only. The role is LOGIN (dropping it
  // or setting it NOLOGIN is a later operator step), so it can still connect;
  // what this file proves is that a connection holds nothing.
  await adminExec(`ALTER ROLE rm_worker WITH LOGIN PASSWORD '${PASSWORD}'`);
  const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  const url = new URL(process.env.RM_TEST_ADMIN_URL!);
  url.username = "rm_worker";
  url.password = PASSWORD;
  url.pathname = `/${db}`;
  worker = postgres(url.toString(), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await worker?.end({ timeout: 5 });
  await restoreRoleBaseline();
});

async function refusal(statement: string): Promise<string | undefined> {
  try {
    await worker.unsafe(statement);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Every privilege rm_worker holds in `public`, as the catalog reports it. */
async function workerPrivileges(): Promise<string[]> {
  const rows = await sql<{ grant: string }[]>`
    SELECT format('%s %s', c.relname, p.privilege_type) AS grant
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS p
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'S')
       AND p.grantee = 'rm_worker'::regrole
     ORDER BY 1`;
  return rows.map((r) => r.grant);
}

describe("rm_worker after migration 0127", () => {
  test("the login really is rm_worker", async () => {
    const [who] = await worker<{ u: string }[]>`SELECT current_user AS u`;
    expect(who!.u).toBe("rm_worker");
  });

  test("SELECT and INSERT on jobs and on every pipeline data table are refused by grant", async () => {
    const outcomes: Record<string, { select: string | undefined; insert: string | undefined }> = {};
    for (const table of PIPELINE_TABLES) {
      outcomes[table] = {
        select: await refusal(`SELECT 1 FROM public.${table} LIMIT 1`),
        insert: await refusal(`INSERT INTO public.${table} DEFAULT VALUES`),
      };
    }
    expect(outcomes).toEqual(Object.fromEntries(PIPELINE_TABLES.map((t) => [t, { select: "42501", insert: "42501" }])));
  });

  test("the catalog agrees: no privilege on any relation or sequence, no USAGE on the schema, no default grant", async () => {
    expect(await workerPrivileges()).toEqual([]);
    const [schema] = await sql<{ usage: boolean }[]>`SELECT has_schema_privilege('rm_worker', 'public', 'USAGE') AS usage`;
    expect(schema!.usage).toBe(false);
    const defaults = await sql<{ acl: string }[]>`
      SELECT d.defaclacl::text AS acl FROM pg_default_acl d
       WHERE d.defaclrole = 'rm_owner'::regrole AND d.defaclacl::text LIKE '%rm_worker=%'`;
    expect([...defaults]).toEqual([]);
  });

  test("re-applying migration 0127 is a no-op", async () => {
    const before = await workerPrivileges();
    const statement = readFileSync(MIGRATION, "utf8");
    await fixtureDb.unsafe(statement);
    await fixtureDb.unsafe(statement);
    expect(await workerPrivileges()).toEqual(before);
    expect(await refusal("SELECT 1 FROM public.jobs LIMIT 1")).toBe("42501");
  });

  test("RED CONTROL: a grant handed back to rm_worker is seen, and the migration takes it away again", async () => {
    await fixtureDb.unsafe("GRANT USAGE ON SCHEMA public TO rm_worker; GRANT SELECT ON jobs TO rm_worker");
    expect(await workerPrivileges()).toContain("jobs SELECT");
    expect(await refusal("SELECT 1 FROM public.jobs LIMIT 1")).toBeUndefined();
    await fixtureDb.unsafe(readFileSync(MIGRATION, "utf8"));
    expect(await workerPrivileges()).toEqual([]);
    expect(await refusal("SELECT 1 FROM public.jobs LIMIT 1")).toBe("42501");
  });
});

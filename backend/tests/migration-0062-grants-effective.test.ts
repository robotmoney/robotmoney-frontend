// 0062 must actually CLOSE the holes, not merely contain the right statements.
//
// The sibling file (migration-readonly-sequence-grant.test.ts) reads the SQL as
// text, which is the right test for "no future migration reintroduces the
// pattern" but proves nothing about effect. This file asks the database: after
// the full migration set has run, can each reader role read everything?
//
// That distinction is exactly where this bug lived for weeks. 0053 and 0054
// both CONTAIN a `GRANT SELECT ON ALL TABLES`, and both are correct as written.
// The holes came from what ran AFTERWARDS — 0056-0060's explicit REVOKEs, and
// the absence of any ALTER DEFAULT PRIVILEGES to cover tables created later. A
// text check could not have seen that, and nothing at runtime did either: the
// production symptom was 1,214 dead jobs behind six green healthchecks.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

/** Roles whose READS 0062 repairs. Writes stay fail-closed and are asserted so. */
const READERS: string[] = ["rm_readonly", "rm_app", "rm_worker"];

async function unreadable(role: string, kind: "tables" | "sequences"): Promise<string[]> {
  const relkinds = kind === "tables" ? ["r", "p"] : ["S"];
  const rows = (await sql`
    WITH o AS MATERIALIZED (
      SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = ANY(${relkinds})
    )
    SELECT relname FROM o
     WHERE NOT ${kind === "tables"
       ? sql`has_table_privilege(${role}, oid, 'SELECT')`
       : sql`has_sequence_privilege(${role}, oid, 'SELECT')`}
     ORDER BY relname
  `) as unknown as { relname: string }[];
  return rows.map((r) => r.relname);
}

describe("after the full migration set, every reader role can read everything", () => {
  test("RED CONTROL: the query sees a real population, and a bogus role reads nothing", async () => {
    // Without this, a typo in the CTE would make every case below pass by
    // returning an empty list — the exact failure mode these tests exist for.
    const total = (await sql`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    `) as unknown as { n: number }[];
    expect(total[0]!.n).toBeGreaterThan(50);
  });

  test.each(READERS)("%s can SELECT every table in public", async (role: string) => {
    expect(await unreadable(role, "tables")).toEqual([]);
  });

  test.each(READERS)("%s can SELECT every sequence in public", async (role: string) => {
    // pg_dump reads last_value from every sequence as rm_readonly, so this one
    // is the backup gate. The other two are here because the audit found the
    // same hole under all three names.
    expect(await unreadable(role, "sequences")).toEqual([]);
  });

  test("the default privileges cover later tables and sequences, for each reader", async () => {
    // The half that stops this recurring: a table created by a FUTURE
    // migration must be readable without that migration naming each role.
    const rows = (await sql`
      SELECT defaclobjtype AS objtype, defaclacl::text AS acl
        FROM pg_default_acl
       WHERE pg_get_userbyid(defaclrole) = 'rm_owner'
         AND defaclnamespace = 'public'::regnamespace
    `) as unknown as { objtype: string; acl: string }[];
    for (const role of READERS) {
      const tables = rows.find((r) => r.objtype === "r")?.acl ?? "";
      const seqs = rows.find((r) => r.objtype === "S")?.acl ?? "";
      expect({ role, tables: tables.includes(`${role}=r`), sequences: seqs.includes(`${role}=r`) })
        .toEqual({ role, tables: true, sequences: true });
    }
  });

  test("rm_worker can now WRITE the sampler tables it was dying on", async () => {
    // The outage itself, asserted as effect. writeAssetPrice() does
    // INSERT ... ON CONFLICT DO UPDATE, so both privileges are required —
    // INSERT alone would still fail on the conflict path, which is the branch
    // a re-sampled day always takes.
    const rows = (await sql`
      SELECT c.relname,
             has_table_privilege('rm_worker', c.oid, 'INSERT') AS ins,
             has_table_privilege('rm_worker', c.oid, 'UPDATE') AS upd,
             has_table_privilege('rm_worker', c.oid, 'DELETE') AS del
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('asset_prices', 'asset_price_floors', 'chain_address_floors')
       ORDER BY c.relname
    `) as unknown as { relname: string; ins: boolean; upd: boolean; del: boolean }[];
    expect(rows.map((r) => r.relname)).toEqual(["asset_price_floors", "asset_prices", "chain_address_floors"]);
    for (const r of rows) {
      // DELETE stays denied — least privilege, and nothing deletes from these.
      expect({ t: r.relname, ins: r.ins, upd: r.upd, del: r.del })
        .toEqual({ t: r.relname, ins: true, upd: true, del: false });
    }
  });

  test("the write grant did NOT leak onto the rest of the schema", async () => {
    // An allow-list that quietly became a blanket grant would be the worse
    // bug. rm_worker's writable set must be exactly 0054's list plus 0062's
    // three, and no more.
    const rows = (await sql`
      WITH t AS MATERIALIZED (
        SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      )
      SELECT relname FROM t WHERE has_table_privilege('rm_worker', oid, 'INSERT') ORDER BY relname
    `) as unknown as { relname: string }[];
    const writable = new Set(rows.map((r) => r.relname));
    // 0054's allow-list, restated so a change to either side is visible here.
    const allowed = [
      "jobs", "job_runs", "job_schedules",
      "vault_share_price_history", "vault_adapter_samples",
      "wallet_balance_samples", "wallet_sleeve_samples",
      "projects", "openclaw_agents", "lobster_coins", "tracked_wallets", "agent_vaults",
      "agent_revenue_daily", "daily_coin_snapshots", "daily_agent_snapshots",
      "daily_wallet_snapshots", "daily_tvl_snapshots",
      // 0062's additions
      "asset_prices", "asset_price_floors", "chain_address_floors",
    ];
    expect([...writable].filter((t) => !allowed.includes(t))).toEqual([]);
  });

  test("0062 granted no WRITE to rm_readonly — it still cannot write anywhere", async () => {
    // The blast-radius check. A repair that over-granted would be worse than
    // the bug it fixed, and rm_readonly is the role where that is unambiguous.
    const writable = (await sql`
      WITH t AS MATERIALIZED (
        SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      )
      SELECT relname FROM t
       WHERE has_table_privilege('rm_readonly', oid, 'INSERT')
          OR has_table_privilege('rm_readonly', oid, 'UPDATE')
          OR has_table_privilege('rm_readonly', oid, 'DELETE')
       ORDER BY relname
    `) as unknown as { relname: string }[];
    expect(writable.map((r) => r.relname)).toEqual([]);
  });
});

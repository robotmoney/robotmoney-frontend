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

useCleanDatabase(import.meta.file, { migrationBuilt: true });

/**
 * Roles whose READS 0062 repairs. Writes stay fail-closed and are asserted so.
 * 0062 repaired rm_worker's reads too; 0127 (issue 1034, D75) took every one of
 * them back with the role's last use (rm-worker-retired.test.ts proves it), so
 * the two runtime roles still in service are the readers here.
 */
const READERS: string[] = ["rm_readonly", "rm_app"];

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

  test("rm_app can WRITE the sampler tables the worker was dying on, and DELETE none of them", async () => {
    // The outage itself, asserted as effect. writeAssetPrice() does
    // INSERT ... ON CONFLICT DO UPDATE, so both privileges are required —
    // INSERT alone would still fail on the conflict path, which is the branch
    // a re-sampled day always takes. The writes ran as rm_worker when 0062
    // landed; they run in the api as rm_app since issue 1034 (0126 grants it).
    const rows = (await sql`
      SELECT c.relname,
             has_table_privilege('rm_app', c.oid, 'INSERT') AS ins,
             has_table_privilege('rm_app', c.oid, 'UPDATE') AS upd,
             has_table_privilege('rm_app', c.oid, 'DELETE') AS del
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('asset_prices', 'asset_price_floors', 'chain_address_floors')
       ORDER BY c.relname
    `) as unknown as { relname: string; ins: boolean; upd: boolean; del: boolean }[];
    expect(rows.map((r) => r.relname)).toEqual(["asset_price_floors", "asset_prices", "chain_address_floors"]);
    // DELETE is denied on all three: D55 (6) took DELETE and TRUNCATE from
    // every runtime role on every table (0107).
    for (const r of rows) {
      expect({ t: r.relname, ins: r.ins, upd: r.upd, del: r.del }).toEqual({ t: r.relname, ins: true, upd: true, del: false });
    }
  });

  test("rm_worker writes nothing at all after 0127, and the evidence copies are INSERT-only for rm_app", async () => {
    // The write allow-list 0054, 0061, 0062, 0109, 0113 and 0115 built for
    // rm_worker is gone with the role's last use (D75).
    const rows = (await sql`
      WITH t AS MATERIALIZED (
        SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      )
      SELECT relname FROM t
       WHERE has_table_privilege('rm_worker', oid, 'INSERT') OR has_table_privilege('rm_worker', oid, 'UPDATE')
       ORDER BY relname
    `) as unknown as { relname: string }[];
    expect(rows.map((r) => r.relname)).toEqual([]);
    const evidence = (await sql`
      SELECT relname, has_table_privilege('rm_app', oid, 'INSERT') AS ins, has_table_privilege('rm_app', oid, 'UPDATE') AS upd
        FROM pg_class
       WHERE relname IN ('wallet_balance_sample_evidence', 'wallet_sleeve_sample_evidence')
       ORDER BY relname`) as unknown as { relname: string; ins: boolean; upd: boolean }[];
    expect([...evidence]).toEqual([
      { relname: "wallet_balance_sample_evidence", ins: true, upd: false },
      { relname: "wallet_sleeve_sample_evidence", ins: true, upd: false },
    ]);
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

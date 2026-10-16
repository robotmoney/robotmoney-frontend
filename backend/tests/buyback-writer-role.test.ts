// B11 (issue #1150): the buyback indexer runs in the pipeline worker as
// rm_worker. Its four sites declare rm_worker, and the snapshot's grants give
// that role exactly the writes they need — INSERT and UPDATE on the cursor
// table, INSERT on the swaps table — and no DELETE anywhere. On the
// 2026-10-01 twin every sweep had been refused (42501) and swallowed because
// the sites declared rm_app and the worker holds no rm_app credential.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { registeredSites } from "../src/db/registry.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import "../src/chain/buyback-logs.ts";

// The SNAPSHOT template: grants are reconciled from backend/schema/grants.sql
// inside the migrate step and the snapshot bootstrap, never by a migration, so
// a migration-built template does not carry them (the production path is the
// migrate step, which runs grants.sql on every run).
useCleanDatabase(import.meta.file);

async function privilege(role: string, table: string, priv: string): Promise<boolean> {
  const [row] = (await sql`SELECT has_table_privilege(${role}, ${`public.${table}`}, ${priv}) AS ok`) as unknown as { ok: boolean }[];
  return row?.ok === true;
}

describe("the buyback indexer writes as rm_worker (B11)", () => {
  test("the indexer's sites declare rm_worker; the dashboard read stays rm_app", () => {
    const sites = registeredSites().filter((d) => d.site.startsWith("src/chain/buyback-logs:"));
    const byRole = Object.fromEntries(sites.map((d) => [d.site, d.role]));
    expect(byRole).toEqual({
      "src/chain/buyback-logs:readRows": "rm_app",
      "src/chain/buyback-logs:indexBuybacks.cursor": "rm_worker",
      "src/chain/buyback-logs:indexBuybacks.maxBlock": "rm_worker",
      "src/chain/buyback-logs:indexBuybacks.insert": "rm_worker",
      "src/chain/buyback-logs:indexBuybacks.advance": "rm_worker",
    });
  });

  test("rm_worker may INSERT and UPDATE buyback_scan_state and INSERT buyback_swaps, and DELETE neither", async () => {
    expect(await privilege("rm_worker", "buyback_scan_state", "INSERT")).toBe(true);
    expect(await privilege("rm_worker", "buyback_scan_state", "UPDATE")).toBe(true);
    expect(await privilege("rm_worker", "buyback_swaps", "INSERT")).toBe(true);
    expect(await privilege("rm_worker", "buyback_swaps", "UPDATE")).toBe(false);
    expect(await privilege("rm_worker", "buyback_scan_state", "DELETE")).toBe(false);
    expect(await privilege("rm_worker", "buyback_swaps", "DELETE")).toBe(false);
  });
});

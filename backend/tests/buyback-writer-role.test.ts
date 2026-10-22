// The buyback indexer's writes run in the api as rm_app (issue 1034, D75).
//
// B11 (issue #1150) gave rm_worker the indexer's writes when the indexer ran on
// the worker's own pool. The worker holds no database credential now: the
// indexer (chain/buyback-indexer.ts) scans the chain in the pipeline worker and
// its cursor and swap writes run in the api (pipeline/stores/buybacks.ts),
// reached over /api/pipeline/**. So the four sites declare rm_app, and the
// snapshot's grants give rm_app exactly the writes they need — INSERT and
// UPDATE on the cursor table, INSERT on the swaps table — and no DELETE.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { registeredSites } from "../src/db/registry.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import "../src/chain/buyback-logs.ts";
import "../src/pipeline/stores/buybacks.ts";

// The SNAPSHOT template: grants are reconciled from backend/schema/grants.sql
// inside the migrate step and the snapshot bootstrap.
useCleanDatabase(import.meta.file);

async function privilege(role: string, table: string, priv: string): Promise<boolean> {
  const [row] = (await sql`SELECT has_table_privilege(${role}, ${`public.${table}`}, ${priv}) AS ok`) as unknown as { ok: boolean }[];
  return row?.ok === true;
}

describe("the buyback indexer writes as rm_app, in the api (issue 1034)", () => {
  test("the indexer's sites declare rm_app, reached through the pipeline route; the dashboard read stays rm_app", () => {
    const sites = registeredSites().filter(
      (d) => d.site.startsWith("src/chain/buyback-logs:") || d.site.startsWith("src/pipeline/stores/buybacks:"),
    );
    const byRole = Object.fromEntries(sites.map((d) => [d.site, { role: d.role, callers: [...d.callers] }]));
    expect(byRole).toEqual({
      "src/chain/buyback-logs:readRows": { role: "rm_app", callers: ["src/api/routes/dashboards"] },
      "src/pipeline/stores/buybacks:buybackScanState.cursor": { role: "rm_app", callers: ["src/api/routes/pipeline"] },
      "src/pipeline/stores/buybacks:buybackScanState.maxBlock": { role: "rm_app", callers: ["src/api/routes/pipeline"] },
      "src/pipeline/stores/buybacks:recordBuybackWindow.insert": { role: "rm_app", callers: ["src/api/routes/pipeline"] },
      "src/pipeline/stores/buybacks:recordBuybackWindow.advance": { role: "rm_app", callers: ["src/api/routes/pipeline"] },
    });
  });

  test("rm_app may INSERT and UPDATE buyback_scan_state and INSERT buyback_swaps, and DELETE neither; rm_worker may do none of it", async () => {
    expect(await privilege("rm_app", "buyback_scan_state", "INSERT")).toBe(true);
    expect(await privilege("rm_app", "buyback_scan_state", "UPDATE")).toBe(true);
    expect(await privilege("rm_app", "buyback_swaps", "INSERT")).toBe(true);
    expect(await privilege("rm_app", "buyback_scan_state", "DELETE")).toBe(false);
    expect(await privilege("rm_app", "buyback_swaps", "DELETE")).toBe(false);
    for (const [table, priv] of [["buyback_scan_state", "INSERT"], ["buyback_scan_state", "UPDATE"], ["buyback_swaps", "INSERT"]] as const) {
      expect({ table, priv, held: await privilege("rm_worker", table, priv) }).toEqual({ table, priv, held: false });
    }
  });
});

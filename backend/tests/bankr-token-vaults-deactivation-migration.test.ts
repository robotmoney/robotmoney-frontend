// Migration 0124 (issue 1382): the two Bankr "lp-fees" agent_vaults rows are
// tokens, not vaults, so the migration sets is_active = false on exactly those
// two rows. Owner decision 2026-10-16: deactivate, no LP valuation. Applied the
// way the migrate step applies a file: one transaction, as rm_owner.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const M0124 = readFileSync(join(import.meta.dir, "..", "migrations", "0124_deactivate_bankr_token_vaults.sql"), "utf8");

// Mixed case, as the v0 roster seed and production carry them.
const BANKR_AGENT_TOKEN = "0x7689006F6C3A3473449E42b628544E60D0bCCb07";
const BNKR_TOKEN = "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b";

/** Applies 0124 in one transaction as rm_owner and returns the rows it updated. */
async function apply(): Promise<number> {
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      const res = await tx.unsafe(M0124);
      return res.count;
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

type VaultRow = { name: string; is_active: boolean; tvl: number | null; status: string | null; refreshed_at: Date | null };
async function vaults(projectId: string): Promise<Record<string, VaultRow>> {
  const rows = await fixtureDb<VaultRow[]>`
    SELECT name, is_active, tvl_usd::float8 AS tvl, last_refresh_status AS status, refreshed_at
      FROM agent_vaults WHERE project_id = ${projectId}`;
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

describe("0124: the two Bankr lp-fees token rows are deactivated", () => {
  test("blank database: no agent_vaults row, so the migration updates nothing", async () => {
    await fixtureDb`DELETE FROM daily_tvl_snapshots`;
    await fixtureDb`DELETE FROM agent_vaults`;
    expect(await apply()).toBe(0);
  });

  test("upgraded database: exactly the two rows go inactive, their TVL, status and history stay, a control vault stays active, and a rerun updates nothing", async () => {
    const refreshed = "2026-10-14T06:00:00.000Z";
    const [{ id: projectId }] = await fixtureDb<{ id: string }[]>`
      INSERT INTO projects (slug, display_name, status) VALUES ('bankr-0124', 'Bankr', 'active') RETURNING id`;
    const planted: Record<string, string> = {};
    for (const [name, address, strategy, tvl, status] of [
      ["Bankr Agent Token LP", BANKR_AGENT_TOKEN, "lp-fees", 999, "failed"],
      ["Bankr BNKR LP Pool", BNKR_TOKEN, "lp-fees", 555, "failed"],
      ["Robot Money USDC", "0x" + "4f".repeat(20), "erc4626", 1234.5, "ok"],
    ] as const) {
      const [{ id }] = await fixtureDb<{ id: string }[]>`
        INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, protocol, data_source, is_active, tvl_usd, last_refresh_status, refreshed_at)
        VALUES (${projectId}, ${name}, ${address}, 'base', ${strategy}, 'bankr', 'live', true, ${tvl}, ${status}, ${refreshed}::timestamptz)
        RETURNING id`;
      planted[name] = id;
      await fixtureDb`INSERT INTO daily_tvl_snapshots (vault_id, snapshot_date, tvl_usd) VALUES (${id}, '2026-10-14', ${tvl})`;
    }

    expect(await apply()).toBe(2);
    const after = await vaults(projectId);
    expect(after["Bankr Agent Token LP"]).toEqual({ name: "Bankr Agent Token LP", is_active: false, tvl: 999, status: "failed", refreshed_at: new Date(refreshed) });
    expect(after["Bankr BNKR LP Pool"]).toEqual({ name: "Bankr BNKR LP Pool", is_active: false, tvl: 555, status: "failed", refreshed_at: new Date(refreshed) });
    expect(after["Robot Money USDC"]).toEqual({ name: "Robot Money USDC", is_active: true, tvl: 1234.5, status: "ok", refreshed_at: new Date(refreshed) });
    const [{ n }] = await fixtureDb<{ n: number }[]>`
      SELECT count(*)::int AS n FROM daily_tvl_snapshots WHERE vault_id IN ${fixtureDb(Object.values(planted))}`;
    expect(n).toBe(3);

    expect(await apply()).toBe(0);
    expect(await vaults(projectId)).toEqual(after);
  });
});

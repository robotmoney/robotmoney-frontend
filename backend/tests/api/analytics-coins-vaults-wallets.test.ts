// Analytics-dashboard directory list feeds (issue #386, docs/bot-analytics-
// ui-port-plan.md §5.9/§5.11/§5.13). Runs against the ephemeral Postgres the
// preload provisions + migrates (tests/preload.ts) — a real DB, never a mock.
// Seeds the EXISTING #70/#87 facet tables directly and asserts the
// coins-vaults-wallets-projections.ts projections + their thin route adapters
// (routes/dashboards.ts) produce the documented DTO shape: provenance
// (refreshedAt/stale), default sort, the vault→project→agent best-effort
// join, and the tracked/agent wallet dedup-by-address merge.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchCoinsList, fetchVaultsList, fetchWalletsList } from "../../src/projects/coins-vaults-wallets-projections.ts";
import { getCoinsList, getVaultsList, getWalletsList } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

test("fetchCoinsList returns active coins sorted by market cap desc, with provenance", async () => {
  const tag = rid("coin");
  const [a] = await sql`INSERT INTO lobster_coins ${sql({
    name: `${tag}-Alpha`, ticker: "ALP", market_cap: 5_000_000, price_usd: 1.23,
    volume_24h: 200_000, percent_change_24h: 3.5, chain: "base",
  })} RETURNING id`;
  const [b] = await sql`INSERT INTO lobster_coins ${sql({
    name: `${tag}-Beta`, ticker: "BET", market_cap: 9_000_000, price_usd: 0.5,
    volume_24h: 50_000, percent_change_24h: -1.2, chain: "base", refreshed_at: new Date(),
  })} RETURNING id`;
  await sql`INSERT INTO lobster_coins ${sql({ name: `${tag}-Inactive`, is_active: false })}`;

  const { coins } = await fetchCoinsList();
  const mine = coins.filter((c) => c.name.startsWith(tag));
  expect(mine.map((c) => c.name)).toEqual([`${tag}-Beta`, `${tag}-Alpha`]); // mcap desc

  const alpha = mine.find((c) => c.id === a.id)!;
  expect(alpha.ticker).toBe("ALP");
  expect(alpha.priceUsd).toBe(1.23);
  expect(alpha.chain).toBe("base");
  // Never refreshed — honestly stale, not fabricated as fresh.
  expect(alpha.refreshedAt).toBeNull();
  expect(alpha.stale).toBe(true);

  const beta = mine.find((c) => c.id === b.id)!;
  expect(beta.refreshedAt).not.toBeNull();
  expect(beta.stale).toBe(false);

  // GET /api/dashboards/coins is a thin adapter over the same projection.
  const viaRoute = await getCoinsList();
  expect(viaRoute.coins.some((c) => c.id === a.id)).toBe(true);
});

test("fetchVaultsList sorts by TVL desc and best-effort joins the managing agent by project", async () => {
  const tag = rid("vault");
  const [project] = await sql`INSERT INTO projects ${sql({ slug: rid("proj"), display_name: "Vault Co" })} RETURNING id`;
  await sql`INSERT INTO openclaw_agents ${sql({ project_id: project.id, name: `${tag}-Agent`, created_at: new Date(Date.now() - 1000) })}`;

  const [big] = await sql`INSERT INTO agent_vaults ${sql({
    project_id: project.id, name: `${tag}-Big`, strategy_type: "erc4626", protocol: "aave",
    chain: "base", data_source: "live", tvl_usd: 900_000, yield_apy: 5.2,
  })} RETURNING id`;
  const [small] = await sql`INSERT INTO agent_vaults ${sql({
    name: `${tag}-Small`, data_source: "upcoming", tvl_usd: null, yield_apy: null,
  })} RETURNING id`;
  await sql`INSERT INTO agent_vaults ${sql({ name: `${tag}-Inactive`, is_active: false })}`;

  const { vaults } = await fetchVaultsList();
  const mine = vaults.filter((v) => v.name.startsWith(tag));
  expect(mine.map((v) => v.name)).toEqual([`${tag}-Big`, `${tag}-Small`]); // tvl desc, nulls last

  const bigRow = mine.find((v) => v.id === big.id)!;
  expect(bigRow.managingAgentName).toBe(`${tag}-Agent`);
  expect(bigRow.protocol).toBe("aave");
  expect(bigRow.stale).toBe(true); // never refreshed

  const smallRow = mine.find((v) => v.id === small.id)!;
  expect(smallRow.managingAgentName).toBeNull(); // no project → no join target
  expect(smallRow.tvlUsd).toBeNull();
  expect(smallRow.dataSource).toBe("upcoming");

  const viaRoute = await getVaultsList();
  expect(viaRoute.vaults.some((v) => v.id === big.id)).toBe(true);
});

test("fetchWalletsList merges tracked + agent-derived wallets, deduping by address, sorted by balance desc", async () => {
  const tag = rid("wallet");
  const [tracked] = await sql`INSERT INTO tracked_wallets ${sql({
    label: `${tag}-Treasury`, chain: "base", balance_usd: 5000, address: "0xAAA111",
  })} RETURNING id`;
  // An agent whose wallet_address collides (case-insensitively) with the tracked
  // row above must NOT appear as a second row — the tracked row wins the dedup.
  await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-DupAgent`, wallet_address: "0xaaa111", protocol_standard: "x402" })}`;
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-SoloAgent`, wallet_address: "0xBBB222", protocol_standard: "x402",
  })} RETURNING id`;
  await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-NoWallet` })}`; // no wallet_address → excluded entirely

  const { wallets } = await fetchWalletsList();
  const mine = wallets.filter((w) => w.label.startsWith(tag));
  expect(mine.length).toBe(2); // dup collapsed, no-wallet agent excluded

  const treasuryRow = mine.find((w) => w.id === tracked.id)!;
  expect(treasuryRow.source).toBe("tracked");
  expect(treasuryRow.balanceUsd).toBe(5000);

  const soloRow = mine.find((w) => w.id === agent.id)!;
  expect(soloRow.source).toBe("agent");
  expect(soloRow.agentId).toBe(agent.id);
  expect(soloRow.protocol).toBe("x402");
  expect(soloRow.balanceUsd).toBeNull(); // no balance source exists for agent-derived rows — honest null

  // Balance desc, nulls last.
  expect(mine[0].id).toBe(tracked.id);
  expect(mine[1].id).toBe(agent.id);

  const viaRoute = await getWalletsList();
  expect(viaRoute.wallets.some((w) => w.id === tracked.id)).toBe(true);
});

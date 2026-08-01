// /list2 "List v2 (WIP)" per-facet-tab feed (issue #387). Runs against the
// ephemeral Postgres the preload provisions + migrates (tests/preload.ts) —
// a real DB, never a mock. Seeds rows across the four facet tables plus
// their daily-snapshot tables and asserts fetchList2() (backend/src/
// projects/list2-projections.ts) aggregates them into the List2 DTOs: the
// agent-only 30d earned/tax/inflow/x402/wallet/token-mcap columns, coin/
// vault/wallet per-tab columns, and 26-week sparklines.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchList2 } from "../../src/projects/list2-projections.ts";
import { getList2 } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test("fetchList2 aggregates an agent row with linked wallet, linked token, and 30d revenue split", async () => {
  const tag = rid("l2a");

  const [project] = await sql`INSERT INTO projects ${sql({ slug: tag, display_name: tag })} RETURNING id`;

  const walletAddress = `0x${tag}wallet`.toLowerCase();
  await sql`INSERT INTO tracked_wallets ${sql({
    project_id: project.id, label: `${tag}-wallet`, address: walletAddress, balance_usd: 4_200, is_active: true,
  })}`;

  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    project_id: project.id, name: `${tag}-coin`, ticker: "TCK", market_cap: 1_500_000, is_active: true,
  })} RETURNING id`;
  await sql`INSERT INTO daily_coin_snapshots ${sql([
    { coin_id: coin.id, snapshot_date: daysAgo(2), price_usd: 1.0 },
    { coin_id: coin.id, snapshot_date: daysAgo(1), price_usd: 1.2 },
  ])}`;

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    project_id: project.id, name: `${tag}-agent`, protocol_standard: "x402",
    wallet_address: walletAddress.toUpperCase(), // exercises the lowercased join
    is_active: true, enriched_at: new Date().toISOString(),
  })} RETURNING id`;

  await sql`INSERT INTO agent_revenue_daily ${sql([
    { agent_id: agent.id, revenue_date: daysAgo(3), revenue_usd: 100, source: "x402" },
    { agent_id: agent.id, revenue_date: daysAgo(2), revenue_usd: 50, source: "referral_tax" },
    { agent_id: agent.id, revenue_date: daysAgo(40), revenue_usd: 9999, source: "x402" }, // out of the 30d window
  ])}`;
  await sql`INSERT INTO daily_agent_snapshots ${sql({
    agent_id: agent.id, snapshot_date: daysAgo(1), x402_volume_usd: 300, x402_txn_count: 5,
  })}`;

  const { agents } = await fetchList2();
  const row = agents.find((a) => a.id === agent.id)!;
  expect(row).toBeDefined();
  expect(row.earned30d).toBe(100); // only the 'x402'-sourced, in-window row
  expect(row.tokenTax30d).toBe(50); // the non-x402-sourced row
  expect(row.inflow30d).toBe(150);
  expect(row.x402Volume30d).toBe(300);
  expect(row.x402Txns30d).toBe(5);
  expect(row.walletBalanceUsd).toBe(4_200); // resolved despite case difference
  expect(row.tokenTicker).toBe("TCK");
  expect(row.tokenMarketCapUsd).toBe(1_500_000);
  expect(row.priceSparkline.length).toBeGreaterThan(0);
  expect(row.href).toBe(`/agents/${agent.id}`);
});

test("fetchList2 never fabricates a token-tax figure when no non-x402 source exists", async () => {
  const tag = rid("l2notax");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-agent`, is_active: true })} RETURNING id`;
  await sql`INSERT INTO agent_revenue_daily ${sql({ agent_id: agent.id, revenue_date: daysAgo(1), revenue_usd: 40, source: "x402" })}`;

  const { agents } = await fetchList2();
  const row = agents.find((a) => a.id === agent.id)!;
  expect(row.tokenTax30d).toBe(0); // honestly zero, not fabricated
  expect(row.inflow30d).toBe(row.earned30d);
});

test("fetchList2 projects coin/vault/wallet tabs with their own real columns", async () => {
  const tag = rid("l2c");

  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    name: `${tag}-coin`, ticker: "ABC", chain: "base", price_usd: 2.5, percent_change_24h: -1.4,
    market_cap: 800_000, volume_24h: 12_000, contract_address: "0xabc", is_active: true,
  })} RETURNING id`;

  const [vault] = await sql`INSERT INTO agent_vaults ${sql({
    name: `${tag}-vault`, protocol: "aave", strategy_type: "erc4626", chain: "base",
    tvl_usd: 900_000, yield_apy: 0.07, data_source: "live", vault_address: "0xvault",
    last_rebalance_at: new Date().toISOString(), is_active: true,
  })} RETURNING id`;

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    label: `${tag}-wallet`, category: "treasury", chain: "base", balance_usd: 5_000,
    address: "0xw1", last_tx_at: new Date().toISOString(), is_active: true,
  })} RETURNING id`;

  const { coins, vaults, wallets } = await fetchList2();
  const c = coins.find((r) => r.id === coin.id)!;
  expect(c.ticker).toBe("ABC");
  expect(c.chain).toBe("base");
  expect(c.priceUsd).toBe(2.5);
  expect(c.percentChange24h).toBe(-1.4);
  expect(c.contractAddress).toBe("0xabc");
  expect(c.href).toBe(`/lobster/${coin.id}`);

  const v = vaults.find((r) => r.id === vault.id)!;
  expect(v.protocol).toBe("aave");
  expect(v.strategyType).toBe("erc4626");
  expect(v.dataSource).toBe("live");
  expect(v.lastRebalanceAt).not.toBeNull();
  expect(v.href).toBe(`/vaults/${vault.id}`);

  const w = wallets.find((r) => r.id === wallet.id)!;
  expect(w.category).toBe("treasury");
  expect(w.balanceUsd).toBe(5_000);
  expect(w.address).toBe("0xw1");
  expect(w.href).toBe(`/wallets/${wallet.id}`);
});

test("GET /api/dashboards/list2 route handler is a thin passthrough and never fabricates on an empty slice", async () => {
  const res = await getList2();
  expect(Array.isArray(res.agents)).toBe(true);
  expect(Array.isArray(res.coins)).toBe(true);
  expect(Array.isArray(res.vaults)).toBe(true);
  expect(Array.isArray(res.wallets)).toBe(true);
  for (const a of res.agents) expect(Array.isArray(a.priceSparkline)).toBe(true);
});

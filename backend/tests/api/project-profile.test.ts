// ProjectProfile "dossier" projection (issue #389, docs/bot-analytics-ui-
// port-plan.md §5.5, P3.1). Runs against the ephemeral Postgres the preload
// provisions + migrates (tests/preload.ts) — a real DB, never a mock. Seeds
// one project with a full facet set (agent, coin, wallet, vault) plus 90d
// snapshot/revenue history and asserts fetchProjectDetail() computes the KPI
// strip, ratio tiles, 90d history series, and facet table rows correctly.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchProjectDetail } from "../../src/projects/profile-projections.ts";
import { getProjectDetail } from "../../src/api/routes/projects.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function insertProject(over: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const row = {
    slug: rid("slug"),
    display_name: "Test Project",
    status: "active",
    data_coverage_score: 80,
    is_sticky: false,
    ...over,
  };
  const [r] = await sql`INSERT INTO projects ${sql(row)} RETURNING id, slug`;
  return { id: r.id as string, slug: r.slug as string };
}

test("fetchProjectDetail returns null for an unknown slug", async () => {
  const result = await fetchProjectDetail(`nonexistent-${crypto.randomUUID()}`);
  expect(result).toBeNull();
});

test("fetchProjectDetail returns null for an inactive project (same as unknown, no leak)", async () => {
  const { slug } = await insertProject({ status: "inactive" });
  const result = await fetchProjectDetail(slug);
  expect(result).toBeNull();
});

test("fetchProjectDetail assembles hero fields, KPIs, ratios, facet tables and 90d history", async () => {
  const { id: pid, slug } = await insertProject({
    display_name: "Dossier Co",
    website_url: "https://dossier.example/",
    twitter_handle: "@dossierco",
    overview_short: "short blurb",
    overview_long: "long form overview",
    breadth_score: 20,
    identity_score: 25,
    onchain_score: 15,
    activity_score: 10,
  });

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    project_id: pid,
    name: "Dossier Agent",
    protocol_standard: "x402",
    x402_score: 70,
    x402_txn_count: 40,
    x402_volume_usd: 900,
    productivity_score: 55,
    is_active: true,
  })} RETURNING id`;

  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    project_id: pid,
    name: "Dossier Coin",
    ticker: "DSR",
    market_cap: 5_000_000,
    fdv: 8_000_000,
    price_usd: 1.25,
    volume_24h: 12_000,
    chain: "base",
  })} RETURNING id`;

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    project_id: pid,
    label: "Dossier Treasury",
    chain: "base",
    balance_usd: 10_000,
    address: "0x1111111111111111111111111111111111aaaa",
  })} RETURNING id`;

  const [vault] = await sql`INSERT INTO agent_vaults ${sql({
    project_id: pid,
    name: "Dossier Vault",
    protocol: "morpho",
    chain: "base",
    strategy_type: "erc4626",
    tvl_usd: 40_000,
    yield_apy: 8.5,
  })} RETURNING id`;

  // Revenue: 200 inside the trailing-15d window, 100 in the prior-15d window
  // (days 20-30), 50 outside the 30d window entirely (never counted).
  await sql`INSERT INTO agent_revenue_daily ${sql([
    { agent_id: agent.id, revenue_date: dayAgo(3), revenue_usd: 200, source: "x402" },
    { agent_id: agent.id, revenue_date: dayAgo(20), revenue_usd: 100, source: "x402" },
    { agent_id: agent.id, revenue_date: dayAgo(40), revenue_usd: 50, source: "x402" },
  ])}`;

  await sql`INSERT INTO daily_coin_snapshots ${sql([
    { coin_id: coin.id, snapshot_date: dayAgo(3), price_usd: 1.25, market_cap: 5_000_000 },
    { coin_id: coin.id, snapshot_date: dayAgo(2), price_usd: 1.3, market_cap: 5_200_000 },
  ])}`;
  await sql`INSERT INTO daily_agent_snapshots ${sql([
    { agent_id: agent.id, snapshot_date: dayAgo(3), productivity_score: 50 },
    { agent_id: agent.id, snapshot_date: dayAgo(2), productivity_score: 60 },
  ])}`;
  await sql`INSERT INTO daily_wallet_snapshots ${sql([
    { wallet_id: wallet.id, snapshot_date: dayAgo(3), total_balance_usd: 9_500 },
  ])}`;
  await sql`INSERT INTO daily_tvl_snapshots ${sql([
    { vault_id: vault.id, snapshot_date: dayAgo(3), tvl_usd: 38_000 },
  ])}`;

  const detail = await fetchProjectDetail(slug);
  expect(detail).not.toBeNull();
  const d = detail!;

  // Hero
  expect(d.displayName).toBe("Dossier Co");
  expect(d.websiteUrl).toBe("https://dossier.example/");
  expect(d.overviewShort).toBe("short blurb");
  expect(d.overviewLong).toBe("long form overview");
  expect(d.breadthScore).toBe(20);
  expect(d.primaryChain).toBe("base");
  expect(d.facets).toEqual({ agent: true, x402: true, coin: true, wallet: true, vault: true });

  // KPIs
  expect(d.kpis.marketCapUsd).toBe(5_000_000);
  expect(d.kpis.fdvUsd).toBe(8_000_000);
  expect(d.kpis.revenue30dUsd).toBe(300); // 200 + 100, the day-40 row excluded
  expect(d.kpis.walletBalanceUsd).toBe(10_000);
  expect(d.kpis.walletCount).toBe(1);
  expect(d.kpis.vaultTvlUsd).toBe(40_000);
  expect(d.kpis.vaultWeightedApy).toBeCloseTo(8.5, 5);
  expect(d.kpis.x402VolumeUsd).toBe(900);
  expect(d.kpis.x402TxnCount).toBe(40);
  // P/S annualized = marketCap / (revenue30d * 365/30)
  expect(d.kpis.psRatioAnnualized).toBeCloseTo(5_000_000 / ((300 * 365) / 30), 5);

  // Ratios
  expect(d.ratios.fdvToMarketCap).toBeCloseTo(8_000_000 / 5_000_000, 5);
  expect(d.ratios.tvlToMarketCap).toBeCloseTo(40_000 / 5_000_000, 5);
  // Growth: last15d=200 vs prior15d=100 -> +100%
  expect(d.ratios.revenueGrowthPct).toBeCloseTo(100, 5);
  expect(d.ratios.capitalEfficiency).toBeCloseTo(300 / (10_000 + 40_000), 5);

  // Facet tables
  expect(d.agents).toHaveLength(1);
  expect(d.agents[0].revenue30dUsd).toBe(300);
  expect(d.agents[0].href).toBe(`/agents/${agent.id}`);
  expect(d.coins).toHaveLength(1);
  expect(d.coins[0].sparkline90d.length).toBeGreaterThan(0);
  expect(d.wallets).toHaveLength(1);
  expect(d.wallets[0].address).toBe("0x1111111111111111111111111111111111aaaa");
  expect(d.vaults).toHaveLength(1);
  expect(d.vaults[0].tvlUsd).toBe(40_000);

  // 90d raw-daily history (not weekly-bucketed) — the two snapshot dates,
  // each metric drawn from its own source table.
  const byDate = new Map(d.history.map((h) => [h.date, h]));
  const d3 = byDate.get(dayAgo(3))!;
  expect(d3).toBeDefined();
  expect(d3.tokenPriceUsd).toBe(1.25);
  expect(d3.marketCapUsd).toBe(5_000_000);
  expect(d3.dailyRevenueUsd).toBe(200);
  expect(d3.treasuryUsd).toBe(9_500 + 38_000);
  expect(d3.avgProductivity).toBe(50);
  const d2 = byDate.get(dayAgo(2))!;
  expect(d2.tokenPriceUsd).toBe(1.3);
  // No wallet/vault snapshot on day -2 -> honestly null, never fabricated/carried forward.
  expect(d2.treasuryUsd).toBeNull();

  // Activity feed: no agent_activity_log writer in this test, so honestly empty.
  expect(d.activity).toEqual([]);

  // Route handler is a thin passthrough.
  const viaRoute = await getProjectDetail(slug);
  expect(viaRoute?.slug).toBe(slug);
});

test("fetchProjectDetail on a project with no facets returns honestly empty/zeroed shapes, never fabricated", async () => {
  const { slug } = await insertProject({ display_name: "Empty Co" });
  const d = await fetchProjectDetail(slug);
  expect(d).not.toBeNull();
  expect(d!.facets).toEqual({ agent: false, x402: false, coin: false, wallet: false, vault: false });
  expect(d!.kpis.marketCapUsd).toBeNull();
  expect(d!.kpis.revenue30dUsd).toBe(0);
  expect(d!.kpis.psRatioAnnualized).toBeNull();
  expect(d!.ratios.capitalEfficiency).toBeNull();
  expect(d!.agents).toEqual([]);
  expect(d!.coins).toEqual([]);
  expect(d!.wallets).toEqual([]);
  expect(d!.vaults).toEqual([]);
  expect(d!.history).toEqual([]);
  expect(d!.activity).toEqual([]);
  expect(d!.sparkline).toEqual([]);
  expect(d!.primaryChain).toBeNull();
});

test("fetchProjectDetail's tokenless fallback sparkline uses trailing agent productivity, matching the directory row's #338 rule", async () => {
  const { id: pid, slug } = await insertProject({ display_name: "Tokenless Co" });
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    project_id: pid, name: "Tokenless Agent", is_active: true,
  })} RETURNING id`;
  await sql`INSERT INTO daily_agent_snapshots ${sql([
    { agent_id: agent.id, snapshot_date: dayAgo(5), productivity_score: 10 },
    { agent_id: agent.id, snapshot_date: dayAgo(1), productivity_score: 20 },
  ])}`;

  const d = await fetchProjectDetail(slug);
  expect(d!.sparkline).toEqual([10, 20]);
});

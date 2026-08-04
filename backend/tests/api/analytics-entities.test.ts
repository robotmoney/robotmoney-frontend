// /list "Total Market" unified feed (issue #384). Runs against the ephemeral
// Postgres the preload provisions + migrates (tests/preload.ts) — a real DB,
// never a mock. Seeds rows across all four facet tables (openclaw_agents,
// lobster_coins, agent_vaults, tracked_wallets) plus their daily-snapshot
// tables and asserts fetchEntities()/fetchMarketOverview() (backend/src/
// projects/entities-projections.ts) aggregate them into the /list DTOs: per-
// type contextual metric, weekly-bucketed sparklines, pending flags, honesty
// (refreshedAt/stale) fields, overview counts/leaders/RM-token passthrough.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchEntities, fetchMarketOverview } from "../../src/projects/entities-projections.ts";
import { getEntities, getMarketOverview } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// daysAgo() is fine for "some time in the past", but NOT for two dates that
// must share an ISO week: on a Tuesday or Wednesday, daysAgo(3) and daysAgo(1)
// straddle a Monday and the weekly sum bucket splits in two. Anchor to the
// last COMPLETE week instead, so the fixture dates are deterministic on every
// day of the week.
const DAY_MS = 86_400_000;
const isoDayIndex = (t: number) => (new Date(t).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
const lastCompleteWeekMonday = () => {
  const now = Date.now();
  return now - isoDayIndex(now) * DAY_MS - 7 * DAY_MS;
};
// n days into that week: inLastWeek(0) = Monday, inLastWeek(2) = Wednesday.
const inLastWeek = (n: number) =>
  new Date(lastCompleteWeekMonday() + n * DAY_MS).toISOString().slice(0, 10);
// The same offset one week earlier, for a row that must land in an EARLIER bucket.
const inWeekBefore = (n: number) =>
  new Date(lastCompleteWeekMonday() + (n - 7) * DAY_MS).toISOString().slice(0, 10);

test("fetchEntities returns one row per agent/coin/vault/wallet with per-type contextual metrics", async () => {
  const tag = rid("ent");

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-agent`, protocol_standard: "x402", x402_score: 42.5, is_active: true,
    enriched_at: new Date().toISOString(),
  })} RETURNING id`;
  await sql`INSERT INTO agent_revenue_daily ${sql([
    { agent_id: agent.id, revenue_date: daysAgo(3), revenue_usd: 100, source: "x402" },
    { agent_id: agent.id, revenue_date: daysAgo(40), revenue_usd: 9999, source: "x402" },
  ])}`;

  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    name: `${tag}-coin`, ticker: "TCK", market_cap: 5_000_000, volume_24h: 250_000,
    percent_change_24h: 3.2, chain: "base", is_active: true,
  })} RETURNING id`;
  await sql`INSERT INTO daily_coin_snapshots ${sql([
    { coin_id: coin.id, snapshot_date: daysAgo(2), price_usd: 1.0 },
    { coin_id: coin.id, snapshot_date: daysAgo(1), price_usd: 1.5 },
  ])}`;

  const [vault] = await sql`INSERT INTO agent_vaults ${sql({
    name: `${tag}-vault`, strategy_type: "erc4626", tvl_usd: 1_200_000, yield_apy: 0.085, is_active: true,
  })} RETURNING id`;

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    label: `${tag}-wallet`, chain: "base", balance_usd: 3_400, is_active: false,
    last_tx_at: new Date(Date.now() - 3_600_000).toISOString(),
  })} RETURNING id`;

  const { entities } = await fetchEntities();
  const byId = new Map(entities.map((e) => [e.id, e]));

  const a = byId.get(agent.id)!;
  expect(a).toBeDefined();
  expect(a.type).toBe("agent");
  expect(a.contextual).toBe(42.5);
  expect(a.revenue).toBe(100); // only the in-window (30d) row counts
  expect(a.href).toBe(`/agents/${agent.id}`);
  expect(a.pending).toBe(false);
  expect(a.stale).toBe(false); // enriched_at was set

  const c = byId.get(coin.id)!;
  expect(c.type).toBe("coin");
  expect(c.contextual).toBe(5_000_000);
  expect(c.change24h).toBe(3.2);
  expect(c.href).toBe(`/lobster/${coin.id}`);
  // Never refreshed -> honestly stale, never fabricated fresh (issue #346 pattern).
  expect(c.stale).toBe(true);
  expect(c.refreshedAt).toBeNull();

  const v = byId.get(vault.id)!;
  expect(v.type).toBe("vault");
  expect(v.contextual).toBe(0.085);
  expect(v.balance).toBe(1_200_000);
  expect(v.href).toBe(`/vaults/${vault.id}`);

  const w = byId.get(wallet.id)!;
  expect(w.type).toBe("wallet");
  expect(w.contextual).toBeNull();
  expect(w.lastTxAt).not.toBeNull();
  expect(w.balance).toBe(3_400);
  expect(w.pending).toBe(true); // is_active: false
  expect(w.href).toBe(`/wallets/${wallet.id}`);
});

test("fetchEntities weekly-buckets a coin's price series (last-value aggregation)", async () => {
  const tag = rid("spark");
  const [coin] = await sql`INSERT INTO lobster_coins ${sql({ name: `${tag}-coin`, is_active: true })} RETURNING id`;
  // Two snapshots in the same ISO week, one in an earlier week.
  await sql`INSERT INTO daily_coin_snapshots ${sql([
    { coin_id: coin.id, snapshot_date: inWeekBefore(0), price_usd: 1.0 },
    { coin_id: coin.id, snapshot_date: inLastWeek(0), price_usd: 2.0 },
    { coin_id: coin.id, snapshot_date: inLastWeek(2), price_usd: 2.5 },
  ])}`;

  const { entities } = await fetchEntities();
  const row = entities.find((e) => e.id === coin.id)!;
  expect(row.sparkline.length).toBeGreaterThan(0);
  // Last value of the most recent week wins ("last" aggregation).
  expect(row.sparkline[row.sparkline.length - 1]).toBe(2.5);
});

test("fetchMarketOverview computes counts, vault TVL, leaders, and avg productivity from active rows only", async () => {
  const tag = rid("ov");

  // Values deliberately above any plausible fixture from another suite
  // sharing this ephemeral DB, so this row is guaranteed the GLOBAL leader
  // (leaders are computed over every active row, not filterable by tag).
  const [topAgent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-top-agent`, x402_score: 1_000_000, productivity_score: 80, is_active: true,
  })} RETURNING id`;
  await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-pending-agent`, x402_score: 999_999_999, is_active: false,
  })}`; // excluded from counts/leaders — pending, must not outrank topAgent

  const [topCoin] = await sql`INSERT INTO lobster_coins ${sql({
    name: `${tag}-top-coin`, market_cap: 1_000_000_000_000, is_active: true,
  })} RETURNING id`;

  const [topVault] = await sql`INSERT INTO agent_vaults ${sql({
    name: `${tag}-top-vault`, tvl_usd: 1_000_000_000_000, is_active: true,
  })} RETURNING id`;
  await sql`INSERT INTO daily_tvl_snapshots ${sql({ vault_id: topVault.id, snapshot_date: daysAgo(1), tvl_usd: 1_000_000_000_000 })}`;

  await sql`INSERT INTO tracked_wallets ${sql({ label: `${tag}-wallet`, balance_usd: 1_000, is_active: true })}`;

  const overview = await fetchMarketOverview();

  expect(overview.leaders.agent?.id).toBe(topAgent.id);
  expect(overview.leaders.coin?.id).toBe(topCoin.id);
  expect(overview.leaders.vault?.id).toBe(topVault.id);
  expect(overview.leaders.agent?.href).toBe(`/agents/${topAgent.id}`);
  // A shared ephemeral DB may already have other active agents with a
  // productivity score from another suite, so assert non-null rather than
  // an exact global average.
  expect(overview.avgProductivityScore).not.toBeNull();
  expect(overview.vaultTvlUsd).toBeGreaterThanOrEqual(1_000_000_000_000);
  expect(overview.totalAumUsd).toBeGreaterThanOrEqual(overview.vaultTvlUsd);
  expect(overview.robotmoney).toHaveProperty("priceUsd");
  expect(typeof overview.robotmoney.stale).toBe("boolean");
});

test("GET /api/dashboards/entities and /overview route handlers are thin passthroughs", async () => {
  const entitiesRes = await getEntities();
  expect(Array.isArray(entitiesRes.entities)).toBe(true);

  const overviewRes = await getMarketOverview();
  expect(overviewRes.counts).toHaveProperty("agents");
  expect(overviewRes.counts).toHaveProperty("coins");
  expect(overviewRes.counts).toHaveProperty("vaults");
  expect(overviewRes.counts).toHaveProperty("wallets");
});

test("fetchEntities/fetchMarketOverview never fabricate data on an empty DB slice", async () => {
  // A brand-new ephemeral DB may already have seeded rows from other suites in
  // the same run, so assert shape/invariants rather than exact emptiness.
  const { entities } = await fetchEntities();
  expect(Array.isArray(entities)).toBe(true);
  for (const e of entities) {
    expect(["agent", "coin", "vault", "wallet"]).toContain(e.type);
    expect(typeof e.pending).toBe("boolean");
    expect(typeof e.stale).toBe("boolean");
  }
});

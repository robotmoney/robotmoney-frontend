// Unified /list "Total Market" projection (issue #384,
// docs/bot-analytics-ui-port-plan.md §5.1, P2.1). Ports
// robotmoney-bot-analytics's List.tsx + TotalMarketOverview.tsx aggregation
// (9 parallel Supabase selects + client-side merge) onto this repo's Postgres
// backend: ONE flat row per tracked agent/coin/vault/wallet (not grouped by
// project — /list's own subtitle is "Aggregate view across every tracked
// agent, coin, vault, and wallet", a broader surface than the /projects
// directory's MIN_SCORE-gated view over the same four facet tables,
// projects/projections.ts). `backend/src/api/routes/dashboards.ts` is the
// thin adapter that exposes these as GET /api/dashboards/entities and
// /api/dashboards/overview.
//
// Reuses the SAME num()/isStale()/*_REFRESH_FRESHNESS_BUDGET_MS helpers
// projects/projections.ts already exports rather than re-deriving the
// honesty-contract staleness rule (issue #346's D24 pattern: never fabricate
// a fresher-than-real refreshedAt).
//
// Sparkline note (§4.3): the canonical `toWeeklyBuckets` helper is P0.5's
// job (issue #381, not yet landed as of this issue) — weekly bucketing here
// is a page-local stand-in (`toWeeklyBuckets` below) that this projection
// should switch to once #381 ships the shared version in
// backend/src/analytics or a frontend/shared equivalent. Semantics match the
// plan: 26 Monday-anchored weeks, `last` aggregation (carrying the prior
// week's value forward when a week has no rows) for price/TVL/balance
// series, `sum` for revenue/volume series.
import { sql } from "../db/client.ts";
import {
  num,
  isStale,
  COIN_REFRESH_FRESHNESS_BUDGET_MS,
  WALLET_REFRESH_FRESHNESS_BUDGET_MS,
  VAULT_REFRESH_FRESHNESS_BUDGET_MS,
} from "./projections.ts";
import { getTokenMetrics } from "../chain/token-metrics.ts";
import type {
  EntityType,
  EntityRow,
  EntitiesResponse,
  MarketLeader,
  MarketOverview,
} from "@robotmoney/contract";

export type { EntityType, EntityRow, EntitiesResponse, MarketLeader, MarketOverview };

function since182(): string {
  return new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
}

function since7(): string {
  return new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
}

// Monday of the UTC week containing `dateStr` (YYYY-MM-DD), as YYYY-MM-DD.
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - deltaToMonday);
  return d.toISOString().slice(0, 10);
}

// Page-local stand-in for the plan's shared `toWeeklyBuckets` (see file
// header). `agg: "last"` forward-fills the previous week's value into any
// week with no rows; `agg: "sum"` leaves gaps as 0. Returns up to `weeks`
// buckets, oldest first — fewer when the entity has less history (never
// fabricated padding).
function toWeeklyBuckets(
  rows: { date: string; value: number }[],
  weeks: number,
  agg: "last" | "sum",
): number[] {
  if (rows.length === 0) return [];
  const byWeek = new Map<string, number[]>();
  for (const r of rows) {
    const wk = mondayOf(r.date);
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(r.value);
  }
  const weekKeys = [...byWeek.keys()].sort();
  const firstWeek = weekKeys[0];
  const lastWeek = weekKeys[weekKeys.length - 1];
  // Walk every Monday from firstWeek..lastWeek so a forward-fill "last" series
  // has no silent hole for an entity that missed a week's sampler run.
  const allWeeks: string[] = [];
  let cursor = firstWeek;
  while (cursor <= lastWeek) {
    allWeeks.push(cursor);
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    cursor = d.toISOString().slice(0, 10);
  }
  const trimmed = allWeeks.slice(-weeks);
  let carry = 0;
  const out: number[] = [];
  for (const wk of trimmed) {
    const vals = byWeek.get(wk);
    if (agg === "sum") {
      out.push(vals ? vals.reduce((s, v) => s + v, 0) : 0);
    } else {
      if (vals && vals.length) carry = vals[vals.length - 1];
      out.push(carry);
    }
  }
  return out;
}

// The full unified /list table feed: one row per tracked agent/coin/vault/
// wallet, spanning every project (not MIN_SCORE-gated — /list is the
// "every tracked X" surface, /projects is the coverage-gated directory).
export async function fetchEntities(): Promise<EntitiesResponse> {
  const [agents, coins, vaults, wallets] = await Promise.all([
    sql`SELECT id, name, protocol_standard, x402_score, is_active, enriched_at
        FROM openclaw_agents`,
    sql`SELECT id, name, ticker, market_cap, volume_24h, percent_change_24h, chain, is_active, refreshed_at
        FROM lobster_coins`,
    sql`SELECT id, name, protocol, strategy_type, tvl_usd, yield_apy, is_active, refreshed_at
        FROM agent_vaults`,
    sql`SELECT id, label, chain, balance_usd, address, last_tx_at, is_active, refreshed_at
        FROM tracked_wallets`,
  ]);

  const agentIds = agents.map((a) => a.id as string);
  const coinIds = coins.map((c) => c.id as string);
  const vaultIds = vaults.map((v) => v.id as string);
  const walletIds = wallets.map((w) => w.id as string);
  const cutoff182 = since182();
  const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const [revenue, coinSnaps, vaultSnaps, walletSnaps] = await Promise.all([
    agentIds.length
      ? sql`SELECT agent_id, revenue_date::text AS revenue_date, revenue_usd FROM agent_revenue_daily
            WHERE agent_id IN ${sql(agentIds)} AND revenue_date >= ${cutoff182}`
      : Promise.resolve([] as Record<string, unknown>[]),
    coinIds.length
      ? sql`SELECT coin_id, snapshot_date::text AS snapshot_date, price_usd FROM daily_coin_snapshots
            WHERE coin_id IN ${sql(coinIds)} AND snapshot_date >= ${cutoff182}`
      : Promise.resolve([] as Record<string, unknown>[]),
    vaultIds.length
      ? sql`SELECT vault_id, snapshot_date::text AS snapshot_date, tvl_usd FROM daily_tvl_snapshots
            WHERE vault_id IN ${sql(vaultIds)} AND snapshot_date >= ${cutoff182}`
      : Promise.resolve([] as Record<string, unknown>[]),
    walletIds.length
      ? sql`SELECT wallet_id, snapshot_date::text AS snapshot_date, total_balance_usd FROM daily_wallet_snapshots
            WHERE wallet_id IN ${sql(walletIds)} AND snapshot_date >= ${cutoff182}`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const revByAgent = new Map<string, { date: string; value: number }[]>();
  const rev30ByAgent = new Map<string, number>();
  for (const r of revenue) {
    const id = r.agent_id as string;
    const date = r.revenue_date as string;
    const val = num(r.revenue_usd) ?? 0;
    (revByAgent.get(id) ?? revByAgent.set(id, []).get(id)!).push({ date, value: val });
    if (date >= cutoff30) rev30ByAgent.set(id, (rev30ByAgent.get(id) ?? 0) + val);
  }
  const priceByCoin = new Map<string, { date: string; value: number }[]>();
  for (const s of coinSnaps) {
    const id = s.coin_id as string;
    (priceByCoin.get(id) ?? priceByCoin.set(id, []).get(id)!).push({
      date: s.snapshot_date as string,
      value: num(s.price_usd) ?? 0,
    });
  }
  const tvlByVault = new Map<string, { date: string; value: number }[]>();
  for (const s of vaultSnaps) {
    const id = s.vault_id as string;
    (tvlByVault.get(id) ?? tvlByVault.set(id, []).get(id)!).push({
      date: s.snapshot_date as string,
      value: num(s.tvl_usd) ?? 0,
    });
  }
  const balByWallet = new Map<string, { date: string; value: number }[]>();
  for (const s of walletSnaps) {
    const id = s.wallet_id as string;
    (balByWallet.get(id) ?? balByWallet.set(id, []).get(id)!).push({
      date: s.snapshot_date as string,
      value: num(s.total_balance_usd) ?? 0,
    });
  }

  const rows: EntityRow[] = [];

  for (const a of agents) {
    const id = a.id as string;
    const enrichedAt = a.enriched_at ? new Date(a.enriched_at as string | Date) : null;
    rows.push({
      id,
      type: "agent",
      name: (a.name as string) ?? "",
      ticker: null,
      category: (a.protocol_standard as string | null) ?? null,
      href: `/agents/${id}`,
      contextual: num(a.x402_score),
      lastTxAt: null,
      revenue: rev30ByAgent.get(id) ?? 0,
      balance: null,
      change24h: null,
      sparkline: toWeeklyBuckets(revByAgent.get(id) ?? [], 26, "sum"),
      pending: !a.is_active,
      refreshedAt: enrichedAt ? enrichedAt.toISOString() : null,
      // Agents have no dedicated refresh-cadence job the way coins/wallets/
      // vaults do (worker/handlers/projects.ts) — honestly stale unless
      // enrichment has ever run.
      stale: !enrichedAt,
    });
  }

  for (const c of coins) {
    const id = c.id as string;
    const refreshedAt = c.refreshed_at ? new Date(c.refreshed_at as string | Date) : null;
    rows.push({
      id,
      type: "coin",
      name: (c.name as string) ?? "",
      ticker: (c.ticker as string | null) ?? null,
      category: (c.chain as string | null) ?? null,
      href: `/lobster/${id}`,
      contextual: num(c.market_cap),
      lastTxAt: null,
      revenue: num(c.volume_24h),
      balance: null,
      change24h: num(c.percent_change_24h),
      sparkline: toWeeklyBuckets(priceByCoin.get(id) ?? [], 26, "last"),
      pending: !c.is_active,
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      stale: isStale(refreshedAt, COIN_REFRESH_FRESHNESS_BUDGET_MS),
    });
  }

  for (const v of vaults) {
    const id = v.id as string;
    const refreshedAt = v.refreshed_at ? new Date(v.refreshed_at as string | Date) : null;
    rows.push({
      id,
      type: "vault",
      name: (v.name as string) ?? "",
      ticker: null,
      category: (v.strategy_type as string | null) ?? (v.protocol as string | null) ?? null,
      href: `/vaults/${id}`,
      contextual: num(v.yield_apy),
      lastTxAt: null,
      revenue: null,
      balance: num(v.tvl_usd),
      change24h: null,
      sparkline: toWeeklyBuckets(tvlByVault.get(id) ?? [], 26, "last"),
      pending: !v.is_active,
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      stale: isStale(refreshedAt, VAULT_REFRESH_FRESHNESS_BUDGET_MS),
    });
  }

  for (const w of wallets) {
    const id = w.id as string;
    const refreshedAt = w.refreshed_at ? new Date(w.refreshed_at as string | Date) : null;
    const lastTxAt = w.last_tx_at ? new Date(w.last_tx_at as string | Date) : null;
    rows.push({
      id,
      type: "wallet",
      name: (w.label as string) ?? "",
      ticker: null,
      category: (w.chain as string | null) ?? null,
      href: `/wallets/${id}`,
      contextual: null,
      lastTxAt: lastTxAt ? lastTxAt.toISOString() : null,
      revenue: null,
      balance: num(w.balance_usd),
      change24h: null,
      sparkline: toWeeklyBuckets(balByWallet.get(id) ?? [], 26, "last"),
      pending: !w.is_active,
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      stale: isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS),
    });
  }

  return { entities: rows };
}

// TotalMarketOverview's counts/leaders/RM-token summary (§5.1). Counts and
// leaders consider only non-pending (is_active) rows — pending rows are the
// "Show unverified" set the table hides by default, and the same convention
// applies to the summary cards above it.
export async function fetchMarketOverview(): Promise<MarketOverview> {
  const [agents, coins, vaults, wallets] = await Promise.all([
    sql`SELECT id, name, x402_score, productivity_score, is_active FROM openclaw_agents`,
    sql`SELECT id, name, market_cap, is_active FROM lobster_coins`,
    sql`SELECT id, name, tvl_usd, is_active FROM agent_vaults`,
    sql`SELECT id, label, balance_usd, is_active FROM tracked_wallets`,
  ]);

  const activeAgents = agents.filter((a) => a.is_active);
  const activeCoins = coins.filter((c) => c.is_active);
  const activeVaults = vaults.filter((v) => v.is_active);
  const activeWallets = wallets.filter((w) => w.is_active);

  const vaultIds = activeVaults.map((v) => v.id as string);
  const vaultTvlUsd = activeVaults.reduce((s, v) => s + (num(v.tvl_usd) ?? 0), 0);
  const walletBalUsd = activeWallets.reduce((s, w) => s + (num(w.balance_usd) ?? 0), 0);

  const vaultSnaps = vaultIds.length
    ? await sql`SELECT snapshot_date::text AS snapshot_date, tvl_usd FROM daily_tvl_snapshots
        WHERE vault_id IN ${sql(vaultIds)} AND snapshot_date >= ${since7()}`
    : [];
  const tvlByDate = new Map<string, number>();
  for (const s of vaultSnaps) {
    const d = s.snapshot_date as string;
    tvlByDate.set(d, (tvlByDate.get(d) ?? 0) + (num(s.tvl_usd) ?? 0));
  }
  const vaultTvlSparkline7d = [...tvlByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);

  function topOf<T extends { id: string; is_active: boolean }>(
    list: T[],
    metric: (r: T) => number | null,
    name: (r: T) => string,
    type: EntityType,
    hrefPrefix: string,
  ): MarketLeader | null {
    let best: { row: T; value: number } | null = null;
    for (const r of list) {
      const v = metric(r);
      if (v == null) continue;
      if (!best || v > best.value) best = { row: r, value: v };
    }
    if (!best) return null;
    return { type, id: best.row.id, name: name(best.row), href: `${hrefPrefix}/${best.row.id}`, value: best.value };
  }

  const leaders = {
    agent: topOf(activeAgents, (a) => num(a.x402_score), (a) => (a.name as string) ?? "", "agent", "/agents"),
    coin: topOf(activeCoins, (c) => num(c.market_cap), (c) => (c.name as string) ?? "", "coin", "/lobster"),
    vault: topOf(activeVaults, (v) => num(v.tvl_usd), (v) => (v.name as string) ?? "", "vault", "/vaults"),
  };

  const prodScores = activeAgents.map((a) => num(a.productivity_score)).filter((v): v is number => v != null);
  const avgProductivityScore = prodScores.length ? prodScores.reduce((s, v) => s + v, 0) / prodScores.length : null;

  const tokenMetrics = await getTokenMetrics();

  return {
    counts: {
      agents: activeAgents.length,
      coins: activeCoins.length,
      vaults: activeVaults.length,
      wallets: activeWallets.length,
    },
    pendingAgents: agents.length - activeAgents.length,
    vaultTvlUsd,
    vaultTvlSparkline7d,
    totalAumUsd: vaultTvlUsd + walletBalUsd,
    leaders,
    avgProductivityScore,
    robotmoney: {
      priceUsd: tokenMetrics.robotmoney.priceUsd,
      marketCapUsd: tokenMetrics.robotmoney.marketCapUsd,
      totalSupply: tokenMetrics.robotmoney.totalSupply,
      stale: tokenMetrics.stale,
      source: tokenMetrics.source,
    },
    asOf: new Date().toISOString(),
  };
}

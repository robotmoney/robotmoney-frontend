// "List v2 (WIP)" projection (issue #387, docs/bot-analytics-ui-port-plan.md
// §5.2, P2.6). Ports robotmoney-bot-analytics's List2.tsx: one wide,
// per-facet-type table per tab (Agents/Coins/Vaults/Wallets) rather than the
// unified /list `EntityRow` (issue #384) — list2's columns differ per facet
// (agents carry 30d earned/token-tax/inflow/x402/wallet/token-mcap columns
// none of the other facets have), so this is its own projection rather than a
// reshape of entities-projections.ts.
//
// `backend/src/api/routes/dashboards.ts` is the thin adapter exposing this as
// GET /api/dashboards/list2.
//
// Sparkline note (§4.3): the canonical `toWeeklyBuckets` helper is P0.5's job
// (issue #381, not landed as of this issue) — weekly bucketing here is a
// page-local stand-in identical in semantics to the one entities-
// projections.ts uses for the same reason (issue #384, also not yet merged
// as of this issue): 26 Monday-anchored weeks, `last` aggregation
// (forward-fill) for price/TVL/balance series. Switch both call sites to the
// shared helper once #381 lands.
//
// Revenue-source split (§5.2 data caveat, "30D TOKEN TAX / 30D INFLOW require
// revenue-source splits"): `agent_revenue_daily.source` is written today ONLY
// as 'x402' (worker/handlers/projects.ts syncRevenue) — there is no real
// token-tax writer. Rather than fabricate a tax figure, `earned30d` sums the
// x402/olas operating-revenue rows, `tokenTax30d` sums any row whose source
// is NOT 'x402' (honestly 0 today, real once a tax writer exists), and
// `inflow30d` is their sum (the full 30d agent_revenue_daily total for the
// agent) — every figure is a real aggregate over real rows, never invented.
import { sql } from "../db/client.ts";
import type { List2AgentRow, List2CoinRow, List2VaultRow, List2WalletRow, List2Response } from "@robotmoney/contract";

export type { List2AgentRow, List2CoinRow, List2VaultRow, List2WalletRow, List2Response };

// postgres.js returns numeric/decimal columns as strings; coerce to a finite
// number or null so DTO consumers never see a stringified figure (mirrors
// projects/projections.ts's num()).
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
// header). Returns up to `weeks` buckets, oldest first — fewer when the
// entity has less history (never fabricated padding). `agg: "last"`
// forward-fills the previous week's value into any week with no rows.
function toWeeklyBuckets(rows: { date: string; value: number }[], weeks: number): number[] {
  if (rows.length === 0) return [];
  const byWeek = new Map<string, number[]>();
  for (const r of rows) {
    const wk = mondayOf(r.date);
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(r.value);
  }
  const weekKeys = [...byWeek.keys()].sort();
  const firstWeek = weekKeys[0];
  const lastWeek = weekKeys[weekKeys.length - 1];
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
    if (vals && vals.length) carry = vals[vals.length - 1];
    out.push(carry);
  }
  return out;
}

export async function fetchList2(): Promise<List2Response> {
  const [agents, coins, vaults, wallets] = await Promise.all([
    sql`SELECT id, project_id, name, protocol_standard, wallet_address, enriched_at
        FROM openclaw_agents WHERE is_active = true`,
    sql`SELECT id, project_id, name, ticker, chain, price_usd, percent_change_24h, market_cap, volume_24h, contract_address
        FROM lobster_coins WHERE is_active = true`,
    sql`SELECT id, name, protocol, strategy_type, chain, tvl_usd, yield_apy, data_source, vault_address, last_rebalance_at, refreshed_at
        FROM agent_vaults WHERE is_active = true`,
    sql`SELECT id, label, category, chain, balance_usd, address, last_tx_at, refreshed_at
        FROM tracked_wallets WHERE is_active = true`,
  ]);

  const cutoff30 = since(30);
  const cutoff182 = since(182);

  const agentIds = agents.map((a) => a.id as string);
  const coinIds = coins.map((c) => c.id as string);
  const vaultIds = vaults.map((v) => v.id as string);
  const walletIds = wallets.map((w) => w.id as string);
  const projectIds = [...new Set(agents.map((a) => a.project_id as string | null).filter((p): p is string => !!p))];

  const [revenue30, revenueAll, agentSnaps182, coinSnaps, vaultSnaps, walletSnaps, projectCoins] = await Promise.all([
    agentIds.length
      ? sql`SELECT agent_id, source, revenue_usd FROM agent_revenue_daily
            WHERE agent_id IN ${sql(agentIds)} AND revenue_date >= ${cutoff30}`
      : Promise.resolve([] as Record<string, unknown>[]),
    // Last-activity fallback: most recent revenue_date per agent (used only
    // when enriched_at/snapshot data is absent).
    agentIds.length
      ? sql`SELECT agent_id, MAX(revenue_date)::text AS last_date FROM agent_revenue_daily
            WHERE agent_id IN ${sql(agentIds)} GROUP BY agent_id`
      : Promise.resolve([] as Record<string, unknown>[]),
    agentIds.length
      ? sql`SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd, x402_txn_count FROM daily_agent_snapshots
            WHERE agent_id IN ${sql(agentIds)} AND snapshot_date >= ${cutoff182}`
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
    // Best (max market cap) coin per project — feeds an agent's linked-token
    // ticker/mcap/spark, matching the /projects directory's own "max across
    // a project's coins" rule (projects/projections.ts).
    projectIds.length
      ? sql`SELECT id, project_id, ticker, market_cap FROM lobster_coins
            WHERE project_id IN ${sql(projectIds)} AND is_active = true`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  // Best-effort agent <-> tracked_wallet join by lowercased address (same
  // pattern the plan documents for /agents, §5.7: "joins wallet balances by
  // linked_agent_id + lowercased address").
  const walletByAddress = new Map<string, { balance_usd: unknown }>();
  for (const w of wallets) {
    const addr = (w.address as string | null)?.toLowerCase();
    if (addr) walletByAddress.set(addr, w as { balance_usd: unknown });
  }

  const bestCoinByProject = new Map<string, { id: string; ticker: string | null; market_cap: unknown }>();
  for (const c of projectCoins) {
    const pid = c.project_id as string;
    const prev = bestCoinByProject.get(pid);
    if (!prev || (num(c.market_cap) ?? -Infinity) > (num(prev.market_cap) ?? -Infinity)) {
      bestCoinByProject.set(pid, c as { id: string; ticker: string | null; market_cap: unknown });
    }
  }
  const coinPriceById = new Map<string, { date: string; value: number }[]>();
  for (const s of coinSnaps) {
    const id = s.coin_id as string;
    (coinPriceById.get(id) ?? coinPriceById.set(id, []).get(id)!).push({ date: s.snapshot_date as string, value: num(s.price_usd) ?? 0 });
  }

  const earned30ByAgent = new Map<string, number>();
  const tax30ByAgent = new Map<string, number>();
  for (const r of revenue30) {
    const id = r.agent_id as string;
    const v = num(r.revenue_usd) ?? 0;
    if ((r.source as string | null) === "x402" || r.source == null) {
      earned30ByAgent.set(id, (earned30ByAgent.get(id) ?? 0) + v);
    } else {
      tax30ByAgent.set(id, (tax30ByAgent.get(id) ?? 0) + v);
    }
  }
  const lastRevenueDateByAgent = new Map<string, string>();
  for (const r of revenueAll) {
    if (r.last_date) lastRevenueDateByAgent.set(r.agent_id as string, r.last_date as string);
  }
  const x402ByAgent = new Map<string, { volume: number; txns: number }>();
  for (const s of agentSnaps182) {
    const id = s.agent_id as string;
    const cur = x402ByAgent.get(id) ?? { volume: 0, txns: 0 };
    if ((s.snapshot_date as string) >= cutoff30) {
      cur.volume += num(s.x402_volume_usd) ?? 0;
      cur.txns += num(s.x402_txn_count) ?? 0;
    }
    x402ByAgent.set(id, cur);
  }

  const vaultTvlById = new Map<string, { date: string; value: number }[]>();
  for (const s of vaultSnaps) {
    const id = s.vault_id as string;
    (vaultTvlById.get(id) ?? vaultTvlById.set(id, []).get(id)!).push({ date: s.snapshot_date as string, value: num(s.tvl_usd) ?? 0 });
  }
  const walletBalById = new Map<string, { date: string; value: number }[]>();
  for (const s of walletSnaps) {
    const id = s.wallet_id as string;
    (walletBalById.get(id) ?? walletBalById.set(id, []).get(id)!).push({ date: s.snapshot_date as string, value: num(s.total_balance_usd) ?? 0 });
  }

  const agentRows: List2AgentRow[] = agents.map((a) => {
    const id = a.id as string;
    const pid = a.project_id as string | null;
    const linkedCoin = pid ? bestCoinByProject.get(pid) : null;
    const walletAddress = (a.wallet_address as string | null) ?? null;
    const linkedWallet = walletAddress ? walletByAddress.get(walletAddress.toLowerCase()) : null;
    const x402 = x402ByAgent.get(id) ?? { volume: 0, txns: 0 };
    const earned = earned30ByAgent.get(id) ?? 0;
    const tax = tax30ByAgent.get(id) ?? 0;
    const enrichedAt = toIso(a.enriched_at);
    const lastActiveAt = enrichedAt ?? (lastRevenueDateByAgent.get(id) ? `${lastRevenueDateByAgent.get(id)}T00:00:00.000Z` : null);
    return {
      id,
      name: (a.name as string) ?? "",
      href: `/agents/${id}`,
      protocol: (a.protocol_standard as string | null) ?? null,
      earned30d: earned,
      tokenTax30d: tax,
      inflow30d: earned + tax,
      x402Volume30d: x402.volume,
      x402Txns30d: x402.txns,
      walletAddress,
      walletBalanceUsd: linkedWallet ? num(linkedWallet.balance_usd) : null,
      tokenTicker: linkedCoin?.ticker ?? null,
      tokenMarketCapUsd: linkedCoin ? num(linkedCoin.market_cap) : null,
      lastActiveAt,
      priceSparkline: linkedCoin ? toWeeklyBuckets(coinPriceById.get(linkedCoin.id) ?? [], 26) : [],
    };
  });

  const coinRows: List2CoinRow[] = coins.map((c) => {
    const id = c.id as string;
    return {
      id,
      name: (c.name as string) ?? "",
      href: `/lobster/${id}`,
      ticker: (c.ticker as string | null) ?? null,
      chain: (c.chain as string | null) ?? null,
      priceUsd: num(c.price_usd),
      percentChange24h: num(c.percent_change_24h),
      marketCapUsd: num(c.market_cap),
      volume24hUsd: num(c.volume_24h),
      contractAddress: (c.contract_address as string | null) ?? null,
      priceSparkline: toWeeklyBuckets(coinPriceById.get(id) ?? [], 26),
    };
  });

  const vaultRows: List2VaultRow[] = vaults.map((v) => {
    const id = v.id as string;
    return {
      id,
      name: (v.name as string) ?? "",
      href: `/vaults/${id}`,
      protocol: (v.protocol as string | null) ?? null,
      strategyType: (v.strategy_type as string | null) ?? null,
      chain: (v.chain as string | null) ?? null,
      tvlUsd: num(v.tvl_usd),
      apy: num(v.yield_apy),
      dataSource: (v.data_source as string | null) ?? null,
      contractAddress: (v.vault_address as string | null) ?? null,
      lastRebalanceAt: toIso(v.last_rebalance_at),
      tvlSparkline: toWeeklyBuckets(vaultTvlById.get(id) ?? [], 26),
    };
  });

  const walletRows: List2WalletRow[] = wallets.map((w) => {
    const id = w.id as string;
    return {
      id,
      label: (w.label as string) ?? "",
      href: `/wallets/${id}`,
      category: (w.category as string | null) ?? null,
      chain: (w.chain as string | null) ?? null,
      balanceUsd: num(w.balance_usd),
      address: (w.address as string | null) ?? null,
      lastTxAt: toIso(w.last_tx_at),
      refreshedAt: toIso(w.refreshed_at),
      balanceSparkline: toWeeklyBuckets(walletBalById.get(id) ?? [], 26),
    };
  });

  return { agents: agentRows, coins: coinRows, vaults: vaultRows, wallets: walletRows };
}

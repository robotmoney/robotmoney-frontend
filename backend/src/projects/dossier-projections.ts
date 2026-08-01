// Coin/Vault/Wallet detail dossier projections (issue #391,
// docs/bot-analytics-ui-port-plan.md §5.10/§5.12/§5.14, P3.3/P3.4/P3.5).
// Reads the SAME facet + snapshot tables list2-projections.ts (#387) and
// entities-projections.ts (#384) already read (lobster_coins/agent_vaults/
// tracked_wallets + their daily_*_snapshots, migrations 0013/0014) — no new
// tables, no new writers.
//
// Two upstream dependencies have not landed as of this issue, so the fields
// they would have fed are simply absent from the DTOs (see the header
// comment on each interface in contract/src/dashboards.d.ts) rather than
// fabricated:
//   - P1.7 (CoinGecko/DexScreener/Blockscout proxy endpoints)
//   - P1.6 (wallet_holdings table — the plan's OWN documented data caveat,
//     §5.14)
//
// `backend/src/api/routes/dashboards.ts` is the thin adapter exposing these
// as GET /api/dashboards/{coins,vaults,wallets}/:id.
import { sql } from "../db/client.ts";
import {
  num,
  isStale,
  COIN_REFRESH_FRESHNESS_BUDGET_MS,
  VAULT_REFRESH_FRESHNESS_BUDGET_MS,
  WALLET_REFRESH_FRESHNESS_BUDGET_MS,
} from "./projections.ts";
import type {
  CoinProfile,
  CoinProfileLinkedAgent,
  CoinProfilePricePoint,
  VaultProfile,
  VaultProfileLinkedAgent,
  VaultProfileWallet,
  VaultProfileTvlPoint,
  WalletProfile,
  WalletProfileLinkedAgent,
  WalletProfileBalancePoint,
} from "@robotmoney/contract";

export type { CoinProfile, VaultProfile, WalletProfile };

// Every id in these three facet tables is a `uuid PRIMARY KEY` (migrations
// 0013/0014) — pre-validating the shape means an arbitrary/malformed :id
// segment (e.g. a stray slug typed by hand) resolves to a clean 404 instead
// of a Postgres "invalid input syntax for type uuid" 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(v as string | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(v: unknown): string | null {
  const d = toDate(v);
  return d ? d.toISOString() : null;
}

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function fetchCoinProfile(id: string): Promise<CoinProfile | null> {
  if (!UUID_RE.test(id)) return null;

  const rows = await sql`
    SELECT id, project_id, name, ticker, chain, logo_url, contract_address,
           price_usd, percent_change_24h, market_cap, fdv, volume_24h, refreshed_at
    FROM lobster_coins WHERE id = ${id} AND is_active = true`;
  const c = rows[0];
  if (!c) return null;

  const projectId = c.project_id as string | null;
  const [snaps, agentRows] = await Promise.all([
    sql`SELECT snapshot_date::text AS snapshot_date, price_usd, market_cap, volume_24h
        FROM daily_coin_snapshots WHERE coin_id = ${id} AND snapshot_date >= ${since(365)}
        ORDER BY snapshot_date ASC`,
    projectId
      ? sql`SELECT id, name FROM openclaw_agents WHERE project_id = ${projectId} AND is_active = true ORDER BY name ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const priceHistory: CoinProfilePricePoint[] = snaps.map((s) => ({
    date: s.snapshot_date as string,
    priceUsd: num(s.price_usd),
    marketCapUsd: num(s.market_cap),
    volume24hUsd: num(s.volume_24h),
  }));

  const linkedAgents: CoinProfileLinkedAgent[] = agentRows.map((a) => ({
    id: a.id as string,
    name: (a.name as string) ?? "",
    href: `/agents/${a.id}`,
  }));

  const refreshedAt = toDate(c.refreshed_at);
  return {
    id: c.id as string,
    name: (c.name as string) ?? "",
    ticker: (c.ticker as string | null) ?? null,
    chain: (c.chain as string | null) ?? null,
    logoUrl: (c.logo_url as string | null) ?? null,
    contractAddress: (c.contract_address as string | null) ?? null,
    priceUsd: num(c.price_usd),
    percentChange24h: num(c.percent_change_24h),
    marketCapUsd: num(c.market_cap),
    fdvUsd: num(c.fdv),
    volume24hUsd: num(c.volume_24h),
    stale: isStale(refreshedAt, COIN_REFRESH_FRESHNESS_BUDGET_MS),
    refreshedAt: toIso(c.refreshed_at),
    priceHistory,
    linkedAgents,
  };
}

export async function fetchVaultProfile(id: string): Promise<VaultProfile | null> {
  if (!UUID_RE.test(id)) return null;

  const rows = await sql`
    SELECT id, project_id, name, protocol, strategy_type, chain, tvl_usd, yield_apy,
           data_source, vault_address, last_rebalance_at, refreshed_at, created_at
    FROM agent_vaults WHERE id = ${id} AND is_active = true`;
  const v = rows[0];
  if (!v) return null;

  const projectId = v.project_id as string | null;
  const [snaps, agentRows, walletRows] = await Promise.all([
    sql`SELECT snapshot_date::text AS snapshot_date, tvl_usd
        FROM daily_tvl_snapshots WHERE vault_id = ${id} AND snapshot_date >= ${since(365)}
        ORDER BY snapshot_date ASC`,
    // Best-effort "managing agent" (§5.12): agent_vaults carries no direct
    // agent FK, only project_id — same limitation list2-projections.ts
    // documents for its own best-effort agent<->wallet joins.
    projectId
      ? sql`SELECT id, name FROM openclaw_agents WHERE project_id = ${projectId} AND is_active = true ORDER BY name ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
    projectId
      ? sql`SELECT id, label, address, chain, balance_usd FROM tracked_wallets WHERE project_id = ${projectId} AND is_active = true ORDER BY label ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const tvlHistory: VaultProfileTvlPoint[] = snaps.map((s) => ({
    date: s.snapshot_date as string,
    tvlUsd: num(s.tvl_usd),
  }));

  const linkedAgents: VaultProfileLinkedAgent[] = agentRows.map((a) => ({
    id: a.id as string,
    name: (a.name as string) ?? "",
    href: `/agents/${a.id}`,
  }));

  const linkedWallets: VaultProfileWallet[] = walletRows.map((w) => ({
    id: w.id as string,
    label: (w.label as string) ?? "",
    address: (w.address as string | null) ?? null,
    chain: (w.chain as string | null) ?? null,
    balanceUsd: num(w.balance_usd),
    href: `/wallets/${w.id}`,
  }));

  const refreshedAt = toDate(v.refreshed_at);
  return {
    id: v.id as string,
    name: (v.name as string) ?? "",
    protocol: (v.protocol as string | null) ?? null,
    strategyType: (v.strategy_type as string | null) ?? null,
    chain: (v.chain as string | null) ?? null,
    vaultAddress: (v.vault_address as string | null) ?? null,
    dataSource: (v.data_source as string | null) ?? null,
    tvlUsd: num(v.tvl_usd),
    apy: num(v.yield_apy),
    lastRebalanceAt: toIso(v.last_rebalance_at),
    createdAt: toIso(v.created_at),
    stale: isStale(refreshedAt, VAULT_REFRESH_FRESHNESS_BUDGET_MS),
    refreshedAt: toIso(v.refreshed_at),
    tvlHistory,
    // Always [] (D11): no per-vault APY history table/writer exists here —
    // never fabricate the original's seeded random-walk yield chart.
    yieldHistory: [],
    linkedAgents,
    linkedWallets,
  };
}

export async function fetchWalletProfile(id: string): Promise<WalletProfile | null> {
  if (!UUID_RE.test(id)) return null;

  const rows = await sql`
    SELECT id, project_id, label, category, chain, balance_usd, address, last_tx_at, refreshed_at
    FROM tracked_wallets WHERE id = ${id} AND is_active = true`;
  const w = rows[0];
  if (!w) return null;

  const address = (w.address as string | null) ?? null;
  const projectId = w.project_id as string | null;

  const [snaps, snap30, addressAgentRows, projectAgentRows] = await Promise.all([
    sql`SELECT snapshot_date::text AS snapshot_date, total_balance_usd
        FROM daily_wallet_snapshots WHERE wallet_id = ${id} AND snapshot_date >= ${since(365)}
        ORDER BY snapshot_date ASC`,
    sql`SELECT total_balance_usd FROM daily_wallet_snapshots
        WHERE wallet_id = ${id} AND snapshot_date <= ${since(30)}
        ORDER BY snapshot_date DESC LIMIT 1`,
    // Linked agent, §5.14: match by wallet_address first (same lowercased-
    // address join list2-projections.ts uses), else fall back to project_id.
    address
      ? sql`SELECT id, name FROM openclaw_agents
            WHERE wallet_address IS NOT NULL AND lower(wallet_address) = lower(${address}) AND is_active = true
            ORDER BY name ASC LIMIT 1`
      : Promise.resolve([] as Record<string, unknown>[]),
    projectId
      ? sql`SELECT id, name FROM openclaw_agents WHERE project_id = ${projectId} AND is_active = true ORDER BY name ASC LIMIT 1`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const balanceHistory: WalletProfileBalancePoint[] = snaps.map((s) => ({
    date: s.snapshot_date as string,
    balanceUsd: num(s.total_balance_usd),
  }));

  const linkedAgentRow = addressAgentRows[0] ?? projectAgentRows[0] ?? null;
  const linkedAgent: WalletProfileLinkedAgent | null = linkedAgentRow
    ? { id: linkedAgentRow.id as string, name: (linkedAgentRow.name as string) ?? "", href: `/agents/${linkedAgentRow.id}` }
    : null;

  const refreshedAt = toDate(w.refreshed_at);
  return {
    id: w.id as string,
    label: (w.label as string) ?? "",
    category: (w.category as string | null) ?? null,
    chain: (w.chain as string | null) ?? null,
    address,
    balanceUsd: num(w.balance_usd),
    balance30dAgoUsd: snap30[0] ? num(snap30[0].total_balance_usd) : null,
    lastTxAt: toIso(w.last_tx_at),
    refreshedAt: toIso(w.refreshed_at),
    // D14: wallet refresh is unimplemented (the handler throws) — a tracked
    // wallet's balance_usd is set on discovery, not sampled on a schedule, so
    // this reads honestly stale unless a batch job starts touching
    // refreshed_at (see the same caveat in projections.ts's own wallet-facet
    // comment).
    stale: isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS),
    balanceHistory,
    linkedAgent,
  };
}

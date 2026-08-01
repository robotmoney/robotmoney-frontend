// Analytics-dashboard directory list feeds (issue #386, docs/bot-analytics-ui-
// port-plan.md §5.9 `/lobster`, §5.11 `/vaults`, §5.13 `/wallets`). Read-only
// projections over the EXISTING #70/#87 facet tables (lobster_coins,
// agent_vaults, tracked_wallets, openclaw_agents) — no new tables, no
// fabricated columns. This is the single read/projection layer; the HTTP
// routes (api/routes/dashboards.ts) are thin adapters over it, matching the
// projects/projections.ts convention. Sibling to entities-projections.ts
// (#384) / agents-projections.ts (#385) — same directory, same "thin route
// over a projection module" split, one file per phase-2 feed.
import { sql } from "../db/client.ts";
import type {
  CoinsListResponse,
  VaultsListResponse,
  WalletsListResponse,
} from "@robotmoney/contract";

// Freshness budgets mirror projects/projections.ts's #346 pattern, keyed off
// the SAME pipeline schedules (db/seed.ts): projects.refresh_coins runs
// hourly, projects.refresh_wallets and projects.fetch_vaults both run every
// 6h. A generous ~3x multiple absorbs one missed/late tick without ever
// letting a request-time read look fresher than it is.
const COIN_REFRESH_FRESHNESS_BUDGET_MS = 3 * 60 * 60_000; // 3h (~3x hourly)
const VAULT_REFRESH_FRESHNESS_BUDGET_MS = 18 * 60 * 60_000; // 18h (~3x 6h)
const WALLET_REFRESH_FRESHNESS_BUDGET_MS = 18 * 60 * 60_000; // 18h (~3x 6h)

function isStale(refreshedAt: Date | null, budgetMs: number): boolean {
  if (!refreshedAt) return true; // never refreshed — honestly stale, not fabricated as fresh
  return Date.now() - refreshedAt.getTime() > budgetMs;
}

// postgres.js returns numeric/decimal columns as strings; coerce to a finite
// number or null so DTO consumers never see a stringified figure.
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// GET /api/dashboards/coins → /lobster directory (§5.9). Default sort (mcap desc) is
// applied server-side so a client with JS disabled still sees a sane order;
// the Alpine view re-sorts interactively over this same array.
export async function fetchCoinsList(): Promise<CoinsListResponse> {
  const rows = await sql`
    SELECT id, name, ticker, market_cap, price_usd, volume_24h, percent_change_24h, chain, refreshed_at
    FROM lobster_coins
    WHERE is_active = true
    ORDER BY market_cap DESC NULLS LAST
  `;
  return {
    coins: rows.map((r) => {
      const refreshedAt = r.refreshed_at ? new Date(r.refreshed_at as string | Date) : null;
      return {
        id: r.id as string,
        name: (r.name as string) ?? "",
        ticker: (r.ticker as string | null) ?? null,
        priceUsd: num(r.price_usd),
        marketCap: num(r.market_cap),
        volume24h: num(r.volume_24h),
        percentChange24h: num(r.percent_change_24h),
        chain: (r.chain as string | null) ?? null,
        refreshedAt: iso(refreshedAt),
        stale: isStale(refreshedAt, COIN_REFRESH_FRESHNESS_BUDGET_MS),
      };
    }),
  };
}

// GET /api/dashboards/vaults → /vaults directory (§5.11). agent_vaults has no direct
// agent_id FK (only project_id, #70's schema) — the managing-agent name is a
// best-effort join to that project's oldest active agent, a documented
// approximation, never a fabricated name.
export async function fetchVaultsList(): Promise<VaultsListResponse> {
  const rows = await sql`
    SELECT v.id, v.name, v.strategy_type, v.protocol, v.chain, v.data_source, v.tvl_usd, v.yield_apy, v.refreshed_at,
           (
             SELECT a.name FROM openclaw_agents a
             WHERE a.project_id = v.project_id AND a.is_active = true
             ORDER BY a.created_at ASC LIMIT 1
           ) AS managing_agent_name
    FROM agent_vaults v
    WHERE v.is_active = true
    ORDER BY v.tvl_usd DESC NULLS LAST
  `;
  return {
    vaults: rows.map((r) => {
      const refreshedAt = r.refreshed_at ? new Date(r.refreshed_at as string | Date) : null;
      return {
        id: r.id as string,
        name: (r.name as string) ?? "",
        strategyType: (r.strategy_type as string | null) ?? null,
        protocol: (r.protocol as string | null) ?? null,
        chain: (r.chain as string | null) ?? null,
        dataSource: (r.data_source as string | null) ?? null,
        tvlUsd: num(r.tvl_usd),
        yieldApy: num(r.yield_apy),
        managingAgentName: (r.managing_agent_name as string | null) ?? null,
        refreshedAt: iso(refreshedAt),
        stale: isStale(refreshedAt, VAULT_REFRESH_FRESHNESS_BUDGET_MS),
      };
    }),
  };
}

// GET /api/dashboards/wallets → /wallets directory (§5.13). Unifies tracked_wallets
// with agent-derived wallets (openclaw_agents rows carrying a wallet_address),
// deduped by lowercased address — a tracked_wallets row wins the dedup (it is
// the more specific, purpose-tracked record) when both name the same address.
export async function fetchWalletsList(): Promise<WalletsListResponse> {
  const [tracked, agentWallets] = await Promise.all([
    sql`SELECT id, label, chain, balance_usd, address, last_tx_at, refreshed_at
        FROM tracked_wallets WHERE is_active = true`,
    sql`SELECT id, name, wallet_address, protocol_standard, enriched_at
        FROM openclaw_agents WHERE is_active = true AND wallet_address IS NOT NULL`,
  ]);

  const seenAddresses = new Set<string>();
  const items: {
    id: string; label: string; chain: string | null; balanceUsd: number | null;
    address: string | null; lastTxAt: string | null; source: "tracked" | "agent";
    protocol: string | null; agentId: string | null; refreshedAt: string | null; stale: boolean;
  }[] = [];

  for (const w of tracked) {
    const addr = (w.address as string | null) ?? null;
    if (addr) seenAddresses.add(addr.toLowerCase());
    const refreshedAt = w.refreshed_at ? new Date(w.refreshed_at as string | Date) : null;
    items.push({
      id: w.id as string,
      label: (w.label as string) ?? "",
      chain: (w.chain as string | null) ?? null,
      balanceUsd: num(w.balance_usd),
      address: addr,
      lastTxAt: iso(w.last_tx_at as string | Date | null),
      source: "tracked",
      protocol: null,
      agentId: null,
      refreshedAt: iso(refreshedAt),
      stale: isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS),
    });
  }

  for (const a of agentWallets) {
    const addr = a.wallet_address as string;
    if (seenAddresses.has(addr.toLowerCase())) continue; // already represented by a tracked row
    const refreshedAt = a.enriched_at ? new Date(a.enriched_at as string | Date) : null;
    items.push({
      id: a.id as string,
      label: (a.name as string) ?? "",
      chain: null, // openclaw_agents carries no chain column
      balanceUsd: null, // no balance source exists yet for agent-derived rows (honest null, not $0)
      address: addr,
      lastTxAt: null,
      source: "agent",
      protocol: (a.protocol_standard as string | null) ?? null,
      agentId: a.id as string,
      refreshedAt: iso(refreshedAt),
      stale: isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS),
    });
  }

  // Default sort: balance desc, nulls last — matches §5.13's default.
  items.sort((x, y) => {
    if (x.balanceUsd == null && y.balanceUsd == null) return 0;
    if (x.balanceUsd == null) return 1;
    if (y.balanceUsd == null) return -1;
    return y.balanceUsd - x.balanceUsd;
  });

  return { wallets: items };
}

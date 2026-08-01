// Analytics-dashboard directory list feeds (issue #386, docs/bot-analytics-ui-
// port-plan.md §5.9 `/lobster`, §5.11 `/vaults`, §5.13 `/wallets` — Phase 2
// list pages P2.3/P2.4/P2.5). Read-only DTOs over the existing #70/#87 facet
// tables (lobster_coins, agent_vaults, tracked_wallets, openclaw_agents) — no
// new tables, no fabricated columns: every field here traces to a real column
// already populated (or honestly null/never-refreshed) by the projects
// pipelines (issue #87). Provenance (`refreshedAt`/`stale`) mirrors the #346
// pattern used by contract/src/projects.d.ts.

export interface CoinListItem {
  id: string;
  name: string;
  ticker: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  percentChange24h: number | null;
  chain: string | null;
  refreshedAt: string | null;
  stale: boolean;
}

export interface CoinsListResponse {
  coins: CoinListItem[];
}

export interface VaultListItem {
  id: string;
  name: string;
  strategyType: string | null;
  protocol: string | null;
  chain: string | null;
  // 'live' | 'static' | null — mirrors agent_vaults.data_source. Rendered as
  // "—" for tvl/apy when the row is not yet live (§5.11's "upcoming" dash).
  dataSource: string | null;
  tvlUsd: number | null;
  yieldApy: number | null;
  // Best-effort join on the vault's own project (agent_vaults has no direct
  // agent_id FK — only project_id); the oldest active agent on that project,
  // or null if the project has none / the vault has no project. Documented
  // approximation, not a fabricated name.
  managingAgentName: string | null;
  refreshedAt: string | null;
  stale: boolean;
}

export interface VaultsListResponse {
  vaults: VaultListItem[];
}

export interface WalletListItem {
  id: string;
  label: string;
  chain: string | null;
  balanceUsd: number | null;
  address: string | null;
  lastTxAt: string | null;
  // 'tracked' (a tracked_wallets row) | 'agent' (derived from an
  // openclaw_agents.wallet_address, deduped against tracked_wallets by
  // address) — the real source of the row, not a fabricated category the
  // schema has no column for.
  source: "tracked" | "agent";
  // openclaw_agents.protocol_standard for agent-sourced rows; null for
  // tracked rows (tracked_wallets carries no protocol column).
  protocol: string | null;
  // Present only for agent-sourced rows — the row-click target the doc's
  // §5.13 "dual row-click targets" (agent rows → /agents/:id) needs.
  agentId: string | null;
  refreshedAt: string | null;
  stale: boolean;
}

export interface WalletsListResponse {
  wallets: WalletListItem[];
}

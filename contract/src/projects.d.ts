// Projects directory API DTOs (issue #70). The /api/projects endpoint returns the
// aggregated "Agentic Economy Ecosystem" directory: one row per project with its
// facet coverage, coin/wallet detail, trailing revenue, and a 30d price sparkline.
import type { ActivityLogStatus } from "./dashboards";

export interface ProjectCoin {
  id: string;
  ticker: string | null;
  name: string;
  marketCap: number | null;
  fdv: number | null;
  percentChange24h: number | null;
  // Additive superset (issue #87): refreshed spot price + 24h volume from the
  // market-refresh pipeline (CoinGecko / DexScreener). Null until first refresh.
  priceUsd: number | null;
  volume24h: number | null;
  // Issue #346 (the D24 pattern applied to the coin facet): the real timestamp
  // of the last successful projects.refresh_coins sample for this row, and
  // whether it is older than the freshness budget (or has never been
  // refreshed). Never a boolean alone — a consumer can always see how old a
  // served value is.
  refreshedAt: string | null;
  stale: boolean;
}

export interface ProjectWallet {
  id: string;
  label: string;
  chain: string | null;
  balanceUsd: number | null;
  // Issue #346: the real timestamp of the last successful
  // projects.refresh_wallets sample for this wallet, and whether it is older
  // than the freshness budget (or has never been refreshed).
  refreshedAt: string | null;
  stale: boolean;
}

// Live-recomputed facet presence (agent / x402 / coin / wallet / vault), ignoring
// the stale has_* columns on the project row per the source Projects.tsx.
export interface ProjectFacets {
  agent: boolean;
  x402: boolean;
  coin: boolean;
  wallet: boolean;
  vault: boolean;
}

export interface Project {
  id: string;
  slug: string;
  displayName: string;
  logoUrl: string | null;
  description: string | null; // overview_short → description → overview_long
  websiteUrl: string | null;
  twitterHandle: string | null;
  dataCoverageScore: number | null;
  isSticky: boolean;
  facets: ProjectFacets;
  coins: ProjectCoin[];
  wallets: ProjectWallet[];
  walletTotalUsd: number;
  // revenue30d intentionally removed (issue #346): no persisted, non-fabricated
  // revenue source exists for the directory as a whole (only a subset of
  // Virtuals-protocol agents have one) — the honest move is to drop the column
  // rather than serve a partly-real, partly-empty figure as if it were uniform.
  maxMarketCap: number;
  maxFdv: number;
  sparkline: number[]; // 30d primary-coin price series (chronological)
  // Additive superset (issue #87): new aggregates the ported pipelines produce.
  volume24h: number; // max 24h trading volume across the project's coins
  tvlUsd: number; // summed live TVL across the project's vaults (fetch-vault-data)
}

export interface ProjectsResponse {
  projects: Project[];
}

// Admin-managed overview write (issue #93): POST /api/projects/admin/:slug.
// Admin-authored free text ONLY — no AI/LLM enrichment. At least one field must
// be present; omitted fields are left untouched.
export interface ProjectOverviewUpdateRequest {
  overview_short?: string;
  overview_long?: string;
  description?: string;
}

export interface ProjectOverviewUpdateResponse {
  project: {
    slug: string;
    overview_short: string | null;
    overview_long: string | null;
    description: string | null;
  };
}

// GET /api/projects/:slug (issue #389, docs/bot-analytics-ui-port-plan.md
// §5.5, P3.1) — ProjectProfile "dossier" for one project: hero fields, KPI
// strip, all four facet tables in full (not just presence/summary like the
// directory row above), a 90d raw-daily history series (P1.2's "raw daily
// mode for profile charts" — NOT the 26-week bucketing /list and /agents
// use), a small set of derived ratio tiles, and an activity feed scoped to
// this project's agents.
//
// Two sections the plan (§5.5, §6) describes are deliberately absent from
// this DTO rather than shipped empty:
//   - Holdings (per-asset breakdown across the project's wallets): no
//     `wallet_holdings`-equivalent table exists for `tracked_wallets` (only
//     an aggregate `balance_usd`); the ported prop-wallet holdings machinery
//     (`chain/wallet-valuation.ts`) is a different, unrelated data path.
//     Per §6's own provenance table, this is a documented gap ("+
//     wallet_holdings ... sections hidden until then"), not a bug.
//   - Buyers/Holders (per-agent, and the "Buyers/Txn" ratio tile): no column
//     anywhere in this schema counts distinct buyers or token holders.
// Both follow the issue #346 precedent (dropping `revenue30d` from the
// directory DTO rather than serving a partly-real figure as if uniform):
// omit the field entirely instead of a fabricated/always-null stub.
export interface ProjectDetailAgent {
  id: string;
  name: string;
  href: string; // /agents/:id
  protocolStandard: string | null;
  isActive: boolean;
  x402Score: number | null;
  x402TxnCount: number | null;
  x402VolumeUsd: number | null;
  revenue30dUsd: number; // sum of agent_revenue_daily for this agent, trailing 30d (0, not fabricated, if unsynced)
  productivityScore: number | null;
}

export interface ProjectDetailCoin extends ProjectCoin {
  chain: string | null;
  sparkline90d: number[]; // this coin's own 90d price series (chronological), not just the project's primary-coin sparkline
}

export interface ProjectDetailWallet extends ProjectWallet {
  address: string | null;
  lastTxAt: string | null;
}

export interface ProjectDetailVault {
  id: string;
  name: string;
  protocol: string | null;
  chain: string | null;
  strategyType: string | null; // 'erc4626' | 'lp' | null
  tvlUsd: number | null;
  yieldApy: number | null;
  vaultAddress: string | null;
  refreshedAt: string | null;
  stale: boolean;
}

// One day of the 90d raw (unbucketed) history series. A metric is `null` for
// a date none of its backing snapshot tables covered — never interpolated or
// fabricated. `date` covers the UNION of dates any metric has data for, so a
// sparse history still renders the days it does have.
export interface ProjectHistoryPoint {
  date: string; // YYYY-MM-DD
  tokenPriceUsd: number | null; // primary coin (highest-market-cap), daily_coin_snapshots.price_usd
  marketCapUsd: number | null; // primary coin, daily_coin_snapshots.market_cap
  dailyRevenueUsd: number | null; // sum of agent_revenue_daily across this project's agents, that date
  treasuryUsd: number | null; // sum(daily_wallet_snapshots.total_balance_usd) + sum(daily_tvl_snapshots.tvl_usd), that date
  avgProductivity: number | null; // avg(daily_agent_snapshots.productivity_score) across this project's agents, that date
}

export interface ProjectKpis {
  marketCapUsd: number | null; // max across the project's coins
  fdvUsd: number | null; // max across the project's coins
  revenue30dUsd: number; // sum of agent_revenue_daily across this project's agents, trailing 30d
  psRatioAnnualized: number | null; // marketCapUsd / (revenue30dUsd annualized ×365/30); null if either side is missing/zero
  walletBalanceUsd: number;
  walletCount: number;
  vaultTvlUsd: number;
  vaultWeightedApy: number | null; // TVL-weighted average yieldApy; null when total TVL is 0
  x402VolumeUsd: number;
  x402TxnCount: number;
}

export interface ProjectRatios {
  psRatioAnnualized: number | null; // same value as ProjectKpis.psRatioAnnualized, surfaced again as its own tile per §5.5
  fdvToMarketCap: number | null;
  tvlToMarketCap: number | null;
  // % change of the trailing 15d agent_revenue_daily sum vs the preceding 15d
  // sum; null when the prior window summed to 0 (a % change against zero is
  // undefined, not "infinite growth").
  revenueGrowthPct: number | null;
  // revenue30dUsd / (walletBalanceUsd + vaultTvlUsd) — revenue generated per
  // treasury dollar; null when the treasury is 0.
  capitalEfficiency: number | null;
}

export interface ProjectActivityEntry {
  id: string;
  occurredAt: string;
  agentId: string | null;
  agentName: string;
  agentHref: string | null;
  actionType: string;
  status: ActivityLogStatus;
  commitSummary: string | null;
}

export interface ProjectDetail {
  id: string;
  slug: string;
  displayName: string;
  logoUrl: string | null;
  overviewShort: string | null;
  overviewLong: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  primaryChain: string | null; // first non-null chain found across this project's coins/wallets/vaults — derived, not stored
  dataCoverageScore: number | null;
  breadthScore: number | null;
  identityScore: number | null;
  onchainScore: number | null;
  activityScore: number | null;
  coverageCalculatedAt: string | null;
  isSticky: boolean;
  facets: ProjectFacets;
  sparkline: number[]; // 30d primary-coin price series — same fallback rule as the directory row (Project.sparkline)
  kpis: ProjectKpis;
  ratios: ProjectRatios;
  agents: ProjectDetailAgent[];
  coins: ProjectDetailCoin[];
  wallets: ProjectDetailWallet[];
  vaults: ProjectDetailVault[];
  history: ProjectHistoryPoint[];
  activity: ProjectActivityEntry[]; // scoped to this project's agent ids; [] until agent_activity_log has a writer (P1.6) — see ActivityLogResponse
}

export interface ProjectDetailResponse {
  project: ProjectDetail;
}

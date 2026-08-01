// Dashboard (time-series) API DTOs. The API returns already-parsed JSON;
// the frontend never parses CSV.

export interface VaultTvlPoint {
  ts: string; // ISO 8601
  vaultAddress: string;
  assetSymbol: string;
  assetName: string;
  balance: number;
  priceUsd: number;
  valueUsd: number;
  totalVaultValue: number;
  totalShares: number;
  sharePrice: number;
}

export interface WalletBalancePoint {
  ts: string;
  walletAddress: string;
  chain: string;
  assetSymbol: string;
  assetName: string;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}

export interface VaultApy {
  date: string; // YYYY-MM-DD
  apy7d: number | null;
  apy30d: number | null;
  sharePrice: number | null;
  computedAt: string;
}

export interface AllocationBucket {
  key: string;
  label: string;
  weight: number; // 0..1
  [extra: string]: unknown;
}

export interface AllocationFramework {
  asof: string;
  vaultContract: string;
  buckets: AllocationBucket[];
}

// GET /api/dashboards/vault-economics (issue #40) — live Base RPC read of the
// vault (TVL, share price, total shares), its idle USDC balance, and exactly
// three configured adapter holdings, plus a persisted-history-derived 7-day
// APY. `stale: true` means the live RPC read failed and every value below is
// either the last persisted sample or null — never a fabricated number.
export interface VaultEconomicsAdapter {
  name: string;
  address: string;
  configured?: boolean;
  balanceUsd: number | null;
  balanceObservedAt?: string | null;
  provenance?: WalletHoldingProvenance;
}

export interface VaultEconomics {
  asOf: string; // ISO 8601
  stale: boolean;
  source: "live" | "stub";
  tvlUsd: number | null;
  sharePrice: number | null;
  totalShares: number | null;
  idleUsdc: number | null;
  apy7d: number | null;
  adapters: VaultEconomicsAdapter[]; // exactly 3
}

// GET /api/dashboards/wallet-balances (issue #84) — live Base RPC + keyless
// price valuation of the agent's PROP WALLETS. Replaces the baked
// WALLET_SNAPSHOT_TOTAL_USD scalar (/allocation hero) and the 99-day
// walletPerfView series (/performance). Per-holding `provenance` is one of
// 'live' | 'stub' | 'stale' | 'seed'.
export type WalletHoldingProvenance = "live" | "stub" | "stale" | "seed";

export interface SleeveHolding {
  symbol: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  provenance: WalletHoldingProvenance;
  observedAt?: string | null;
}

export interface WalletSleeve {
  name: string;
  address: string;
  type: string;
  totalUsd: number;
  stale: boolean;
  holdings: SleeveHolding[];
  observedAt?: string | null;
}

export interface WalletSleeves {
  wallets: WalletSleeve[];
  asOf: string;
  source: "live" | "stub";
  stale: boolean;
}

export interface WalletHolding {
  symbol: string;
  chain: "base";
  group: string; // Stable | Protocol | Agent | Stocks
  color: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  priceSource: string; // 'pinned' | 'geckoterminal' | 'yahoo'
  provenance: WalletHoldingProvenance;
}

// One day of continuous history. byAsset is sparse (only symbols held that day);
// totalUsd is the sum of the held legs.
export interface WalletHistoryPoint {
  date: string; // ISO calendar day
  byAsset: Record<string, number>;
  totalUsd: number;
}

export interface WalletBalances {
  asOf: string; // ISO 8601
  totalUsd: number;
  source: "live" | "stub";
  priceSource: "live" | "stub";
  holdings: WalletHolding[]; // the eight fixed labelled series, in group/colour order
  history: WalletHistoryPoint[];
}

// One enriched per-indicator object inside a RegimeSnapshot (asof row). Ported
// from the original's regime-snapshot.json indicator shape. Historical rows carry
// an empty `indicators` array + the `percentiles` map only.
export interface RegimeIndicator {
  id: string;
  name: string;
  panel: "macro" | "onchain" | "factor";
  source?: string;
  sign?: number;
  transform?: string;
  unit?: string | null;
  raw_value: number | null;
  raw_date: string | null;
  transformed_value: number | null;
  percentile: number | null;
  signed_percentile: number | null;
  panel_weight: number | null;
  sparkline: (number | null)[];
}

// One dated equity point on a backtest strategy's month-end curve.
export interface BacktestEquityPoint {
  date: string;
  value: number;
}

// Per-strategy backtest metrics (ported from the original simulate() return).
export interface BacktestStrategyMetrics {
  final_value: number | null;
  cagr: number | null;
  cagr_in_sample: number | null;
  cagr_out_sample: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  transitions: number;
  n_days: number;
  start_date: string;
  end_date: string;
  equity_curve: BacktestEquityPoint[];
}

// portfolio (eth | sp500 | mixed) → strategy (composite | macro | onchain |
// macro_inverted | conservative | aggressive | <asset>_hodl | stables_only) → metrics.
export type BacktestPayload = Record<string, Record<string, BacktestStrategyMetrics>>;

// One rank-correlation cell: Spearman ρ (null if <10 pairs) + sample size n.
export interface CorrelationCell {
  rho: number | null;
  n: number;
}

// Predictive-power correlations. forward[index][`${asset}_${h}d`] = rank-corr of
// the index level vs the asset's forward log-return over h∈{30,90,180} days;
// concurrent[index][asset] = rank-corr vs the concurrent log-price. index ∈
// {composite, macro, onchain}; asset ∈ {spx, eth}.
export interface CorrelationsPayload {
  forward: Record<string, Record<string, CorrelationCell>>;
  concurrent: Record<string, Record<string, CorrelationCell>>;
}

export interface RegimeSnapshot {
  date: string;
  composite: number | null;
  compositePercentile: number | null;
  regime: string | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  // v2 panel indices/percentiles + the point-in-time inverse-correlation panel
  // weights + the methodology version. Nullable for a panel a row didn't produce.
  macroIndex?: number | null;
  onchainIndex?: number | null;
  factorIndex?: number | null;
  macroPercentile?: number | null;
  onchainPercentile?: number | null;
  factorPercentile?: number | null;
  panelWeights?: Record<string, Record<string, number>> | null;
  version?: string | null;
  percentiles: Record<string, number>;
  // Rich per-indicator objects on the asof row; [] on historical rows. Kept
  // permissive (legacy rows may carry a differently-shaped object).
  indicators: RegimeIndicator[] | Record<string, unknown>;
  // Asof-only dashboard blobs — populated ONLY on the latest snapshot; null on
  // historical rows. Pass-through blobs preserving snake_case INSIDE (matching the
  // existing indicators[].panel_weight convention), so the frontend receives the
  // original snapshot shapes verbatim. Additive/superset — existing fields unchanged.
  backtest?: BacktestPayload | null;
  correlations?: CorrelationsPayload | null;
  panels?: string[] | null;
  bucketThresholds?: { risk_off: number; risk_on: number } | null;
  extras?: Record<string, BacktestEquityPoint[]> | null;
}

// One dated point in a research-signal series (value nullable for pre-history/gaps).
export interface ResearchPoint {
  date: string;
  value: number | null;
}

export interface ResearchGauge {
  id: string;
  name: string;
  value: number;
  percentile: number; // 0..1
  read: string;
}

// The research-signal payload (channel-divergence / late-cycle-signals). Extends
// the base gauge+series shape with the original's full indicator series map,
// summary, and price overlays (all optional — the hermetic seeded tools emit the
// base fields only).
export interface ResearchSignalPayload {
  asof: string;
  title: string;
  question: string;
  spec: Record<string, unknown>;
  gauges: ResearchGauge[];
  series: { label: string; points: { date: string; value: number }[] };
  indicators?: Record<string, ResearchPoint[]>;
  summary?: Record<string, unknown>;
  btc_price?: ResearchPoint[];
  qqq_price?: ResearchPoint[];
  spy_price?: ResearchPoint[];
}

export interface ResearchSignal {
  signalKey: string;
  date: string;
  payload: ResearchSignalPayload | unknown;
}

// GET /api/dashboards/entities (issue #384, /list "Total Market" P2.1) — one
// row per tracked agent/coin/vault/wallet. `stale`/`refreshedAt` follow the
// same D24 honesty pattern as ProjectCoin/ProjectWallet (issue #346):
// never a fabricated fresher-than-real timestamp.
export type EntityType = "agent" | "coin" | "vault" | "wallet";

export interface EntityRow {
  id: string;
  type: EntityType;
  name: string;
  ticker: string | null;
  category: string | null;
  href: string;
  contextual: number | null; // agent: x402 score; coin: market cap; vault: APY
  lastTxAt: string | null; // wallets only
  revenue: number | null; // agent: trailing-30d revenue; coin: 24h volume
  balance: number | null; // vault: TVL; wallet: balance
  change24h: number | null; // coins only
  sparkline: number[]; // up to 26 weekly buckets, chronological
  pending: boolean;
  refreshedAt: string | null;
  stale: boolean;
}

export interface EntitiesResponse {
  entities: EntityRow[];
}

export interface MarketLeader {
  type: EntityType;
  id: string;
  name: string;
  href: string;
  value: number;
}

// GET /api/dashboards/overview (issue #384) — TotalMarketOverview summary:
// counts, vault TVL + 7d sparkline, total AUM, per-type leaders, avg agent
// productivity, and the ROBOTMONEY ticker (same getTokenMetrics() feed
// /allocation already uses — no new price source).
export interface MarketOverview {
  counts: { agents: number; coins: number; vaults: number; wallets: number };
  pendingAgents: number;
  vaultTvlUsd: number;
  vaultTvlSparkline7d: number[];
  totalAumUsd: number;
  leaders: { agent: MarketLeader | null; coin: MarketLeader | null; vault: MarketLeader | null };
  avgProductivityScore: number | null;
  robotmoney: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    totalSupply: number | null;
    stale: boolean;
    source: string;
  };
  asOf: string;
}

// GET /api/dashboards/list2 (issue #387, docs/bot-analytics-ui-port-plan.md
// §5.2, P2.6) — "List v2 (WIP)": one wide, per-type projection per tab (not
// the unified /list `EntityRow` shape — list2's columns are per-facet-
// specific, e.g. agents carry 30d earned/x402/wallet/token-mcap columns no
// other facet has). Every numeric/timestamp field is `null` rather than a
// fabricated value when the backing pipeline hasn't written it yet (issue
// #98/#346 honesty contract) — the UI renders "—" for a null.
export interface List2AgentRow {
  id: string;
  name: string;
  href: string;
  protocol: string | null;
  // Trailing-30d agent_revenue_daily sum, split by source (issue #387: only
  // `source = 'x402'` has a real writer today, worker/handlers/projects.ts
  // syncRevenue — see backend/src/projects/list2-projections.ts header for
  // the documented derivation). `earned30d` is the x402/olas operating
  // revenue slice; `tokenTax30d` is any non-x402 slice (0 honestly, not
  // fabricated, until a token-tax writer exists); `inflow30d` is the sum of
  // both (the whole 30d agent_revenue_daily total).
  earned30d: number | null;
  tokenTax30d: number | null;
  inflow30d: number | null;
  x402Volume30d: number | null;
  x402Txns30d: number | null;
  walletAddress: string | null;
  walletBalanceUsd: number | null;
  tokenTicker: string | null;
  tokenMarketCapUsd: number | null;
  lastActiveAt: string | null;
  priceSparkline: number[]; // up to 26 weekly buckets of the linked coin's price
}

export interface List2CoinRow {
  id: string;
  name: string;
  href: string;
  ticker: string | null;
  chain: string | null;
  priceUsd: number | null;
  percentChange24h: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  contractAddress: string | null;
  priceSparkline: number[];
}

export interface List2VaultRow {
  id: string;
  name: string;
  href: string;
  protocol: string | null;
  strategyType: string | null;
  chain: string | null;
  tvlUsd: number | null;
  apy: number | null;
  dataSource: string | null; // 'live' | 'static' | null
  contractAddress: string | null;
  lastRebalanceAt: string | null;
  tvlSparkline: number[];
}

export interface List2WalletRow {
  id: string;
  label: string;
  href: string;
  category: string | null;
  chain: string | null;
  balanceUsd: number | null;
  address: string | null;
  lastTxAt: string | null;
  refreshedAt: string | null;
  balanceSparkline: number[];
}

export interface List2Response {
  agents: List2AgentRow[];
  coins: List2CoinRow[];
  vaults: List2VaultRow[];
  wallets: List2WalletRow[];
}

// GET /api/dashboards/leaderboard (issue #387, docs/bot-analytics-ui-port-
// plan.md §5.3, P2.7) — "List v3 · Money Agents". Server-side port of the
// original's `list3Evidence.ts` fallback path (D8: no materialized view /
// pg_cron here, computed per-request over the same facet tables). The exact
// original scoring/confidence algorithm is not available in this repo (the
// source app is deprecated); `backend/src/projects/leaderboard-projections.ts`
// documents the formula this port uses (matches the plan's §5.3 formula
// verbatim for signalScore; confidence/evidence status are a documented,
// deterministic approximation over real columns only — never fabricated).
export type EvidenceStatus = "verified" | "partial" | "missing";
export type ConfidenceLabel = "High" | "Medium" | "Low";

export interface LeaderboardEvidence {
  wallet: EvidenceStatus;
  moneyIn: EvidenceStatus;
  x402: EvidenceStatus;
  token: EvidenceStatus;
  identity: EvidenceStatus;
  freshness: EvidenceStatus;
}

export interface LeaderboardRow {
  id: string;
  rank: number;
  name: string;
  href: string;
  protocol: string | null;
  sourceBadge: string | null; // set only when it differs from `protocol` (§5.3)
  revenue30dUsd: number | null;
  walletBalanceUsd: number | null;
  walletAddress: string | null;
  x402VolumeUsd: number | null;
  x402Txns: number | null;
  tokenTicker: string | null;
  tokenMarketCapUsd: number | null;
  lastObservedAt: string | null;
  moneyTrailSparkline: number[]; // 26-week momentum; [] when no history (original: all-zero placeholder, hidden)
  signalScore: number;
  confidence: ConfidenceLabel;
  evidence: LeaderboardEvidence;
}

// "Leaderboard health (debug)" collapsible + the 4 header StatCards (§5.3).
export interface LeaderboardSourceHealth {
  name: string; // e.g. "openclaw_agents", "tracked_wallets"
  role: string; // short description of what this source backs
  status: "healthy" | "partial" | "stale" | "empty";
  freshCount: number;
  totalCount: number;
  latestRefreshAt: string | null;
}

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  stats: {
    listedAgents: number;
    verifiedWalletBalanceUsd: number;
    moneyIn30dUsd: number;
    highConfidenceCount: number;
  };
  debug: {
    rowCount: number;
    lastRefreshAt: string;
    sources: LeaderboardSourceHealth[];
  };
  asOf: string;
}

// POST /api/dashboards/submissions (issue #393, /submit §5.17) — public
// agent-onboarding / community-commit intake. Anonymous, unauthenticated;
// lands in a moderation queue (status stays 'pending' until an admin acts on
// it from /admin) — no auto-publish. `actionType` mirrors the form's action
// Select; `registration` is only present/validated when actionType is
// 'register_agent'.
export type SubmissionActionType =
  | "register_agent"
  | "update_agent"
  | "link_wallet"
  | "link_token"
  | "link_vault"
  | "report_issue"
  | "endorse_agent"
  | "general";

export interface SubmissionRegistration {
  name: string;
  walletAddress?: string | null;
  description?: string | null;
  // "Claimed Metrics (optional · unverified)" — self-reported by the
  // submitter, never treated as verified data anywhere downstream.
  claimedRevenueUsd?: number | null;
  claimedTxns?: number | null;
  claimedUsers?: number | null;
  website?: string | null;
  twitter?: string | null;
  launchDate?: string | null; // YYYY-MM-DD
}

export interface SubmissionCreate {
  actionType: SubmissionActionType;
  submitterHandle: string;
  agentId?: string | null; // tag-agent Select value, when actionType targets an existing agent
  summary: string;
  registration?: SubmissionRegistration | null;
}

export interface Submission {
  id: string;
  actionType: SubmissionActionType;
  submitterHandle: string;
  agentId: string | null;
  summary: string;
  registration: SubmissionRegistration | null;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

// GET /api/dashboards/activity (issue #392, docs/bot-analytics-ui-port-plan.md
// §5.6, P4.1) — the /market + /dashboard TerminalFeed: a real-time feed of
// agent actions, governance votes, and market events. Backed by
// agent_activity_log (migration 0023); a fresh deploy with no writer yet
// returns `{ entries: [] }`, never a fabricated row (issue #98/#346 honesty
// contract). `agentHref` is null when the row's agent_id has no live
// openclaw_agents match (deleted agent, or no agent attached to this action).
export type ActivityLogStatus = "success" | "pending" | "rejected";

export interface ActivityLogEntry {
  id: string;
  occurredAt: string; // ISO 8601
  agentId: string | null;
  agentName: string;
  agentHref: string | null;
  actionType: string;
  status: ActivityLogStatus;
  commitSummary: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
}

export interface ActivityLogResponse {
  entries: ActivityLogEntry[]; // newest first, zero-score noise filtered, up to 50
}

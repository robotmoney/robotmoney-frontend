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

// One PERSISTED day of history — the series is deliberately sparse over the
// calendar axis, not continuous (issue #614): the seeded pre-launch portion
// carries known gaps ported from its v0 source, and any window this pipeline
// cannot backfill (chain state is read at "latest"; prices are spot-only —
// docs/decisions.md D16) is recorded as missing rather than fabricated. A
// consumer MUST NOT assume `history[i+1].date === history[i].date + 1 day`;
// index a dense calendar axis by `date` and treat absent days as gaps, not
// errors. byAsset is separately sparse (only symbols held that day); totalUsd
// is the sum of the held legs.
export interface WalletHistoryPoint {
  date: string; // ISO calendar day
  byAsset: Record<string, number>;
  totalUsd: number;
  // issue #614 AC5: which kind of row produced this day — 'live' wins if ANY
  // symbol that day was a genuine chain read, else 'stale', else 'seed'
  // (ported pre-launch history), else 'stub'. Lets a consumer render/disclose
  // the seam between backfilled and live-sampled spans instead of one
  // undifferentiated line.
  provenance: WalletHoldingProvenance;
}

export interface WalletBalances {
  asOf: string; // ISO 8601
  totalUsd: number;
  source: "live" | "stub";
  priceSource: "live" | "stub";
  holdings: WalletHolding[]; // the eight fixed labelled series, in group/colour order
  history: WalletHistoryPoint[];
  // Day counts by history[].provenance (issue #614 AC5) — e.g. a consumer can
  // tell "95% of this series is seed rows" without scanning `history` itself.
  // `source` above only ever describes the CURRENT sampler's config; this is
  // the composition of what was actually returned.
  historyProvenance: Record<WalletHoldingProvenance, number>;
}

// Row-level provenance for the analytics pipeline (issue #397): which data
// source actually wrote this row, mirroring the honesty-contract enum other
// dashboard DTOs already use (VaultEconomics.source, WalletHoldingProvenance).
// 'live' = the production orchestrator's real keyless fetchers; 'hermetic' =
// the deterministic seeded source (CI/demo default); 'fixture' = a
// test-injected source; 'seed' = raw_indicator_history's vendored floor-seed
// gap-fill / regime_snapshots' reference-snapshot import — real historical
// data, not computed this run. Pre-migration rows have no recorded
// provenance: `null`, never fabricated.
export type AnalyticsProvenance = "live" | "hermetic" | "fixture" | "seed";

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
  // #402: forward-fill provenance — how many days the last real print has been
  // carried forward (null before any real observation exists) and whether that
  // age has exceeded MAX_FORWARD_FILL_DAYS, excluding the indicator from that
  // day's percentile/panel-weight contribution. Computed by buildRichIndicators
  // in backend/src/analytics/index.ts on every latest-snapshot indicator.
  forward_fill_age_days: number | null;
  forward_fill_expired: boolean;
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
  // Row-level provenance (issue #397): which data source produced this row.
  // `null` on every pre-migration row — genuinely unknown, never fabricated.
  source?: AnalyticsProvenance | null;
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

// `value`/`percentile` are nullable, and null carries a specific, deliberate
// meaning (#505): "no reading for this signal's as-of date" — the underlying
// series had no finite value at the position the gauge reads. It is NOT a raw
// NaN leaking through JSON.stringify (which is what it used to be), and it must
// never be rendered as 0 or as a neutral mid-scale reading. `read` is the
// literal "no reading" whenever `percentile` is null.
export interface ResearchGauge {
  id: string;
  name: string;
  value: number | null;
  percentile: number | null; // 0..1, or null when there is no reading
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

// GET /api/dashboards/agents (issue #385, /agents "OpenClaw Agents" P2.2,
// docs/bot-analytics-ui-port-plan.md §5.7) — one row per tracked agent. Each
// row carries all three selectable 26-week sparkline series up front (score/
// x402/balance) so the frontend's metric selector re-renders instantly
// instead of re-fetching.
export interface AgentDirectoryRow {
  id: string;
  name: string;
  protocol: string | null; // protocol_standard (x402/acp/virtuals/olas/bankr/eliza/facilitator/other/null)
  isFacilitator: boolean; // protocol === 'facilitator'
  active: boolean;
  score: number; // composite: max(x402Score, productivityScore, min(100, log10(rev30d+1)*25))
  x402Txns: number;
  x402VolumeUsd: number;
  balanceUsd: number | null; // matched tracked_wallets row by lowercased address, else null
  walletAddress: string | null;
  sparkline: { score: number[]; x402: number[]; balance: number[] }; // up to 26 weekly buckets, chronological
}

export interface AgentsDirectorySummary {
  active: number;
  idle: number;
  x402Txns: number;
  x402VolumeUsd: number;
  totalBalanceUsd: number;
}

export interface AgentsDirectoryResponse {
  agents: AgentDirectoryRow[];
  summary: AgentsDirectorySummary;
}

// ═══ Analytics-dashboard directory list feeds (issue #386, docs/bot-
// analytics-ui-port-plan.md §5.9 `/lobster`, §5.11 `/vaults`, §5.13
// `/wallets` — Phase 2 list pages P2.3/P2.4/P2.5) ═══════════════════════════
// A distinct feature area from the treasury-dashboard DTOs above, sharing
// only this file + the `dashboards.*` route namespace (precedent: #384/#385).
// Read-only DTOs over the existing #70/#87 facet tables (lobster_coins,
// agent_vaults, tracked_wallets, openclaw_agents) — no new tables, no
// fabricated columns: every field here traces to a real column already
// populated (or honestly null/never-refreshed) by the projects pipelines
// (issue #87). Provenance (`refreshedAt`/`stale`) mirrors the #346 pattern
// used by contract/src/projects.d.ts.

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

// GET /api/dashboards/agents/:id (issue #390, docs/bot-analytics-ui-port-
// plan.md §5.8, P3.2) — the "Money-agent dossier" AgentProfile detail. Fields
// beyond the directory row above (§5.7) come from three real joins, never
// fabricated:
//   - `description`/`websiteUrl`/`twitterHandle` are the agent's PROJECT
//     row's overview_short/website_url/twitter_handle (openclaw_agents has no
//     socials/description columns of its own — projects does); null when the
//     agent has no project_id.
//   - `vaults`/`wallets` are every agent_vaults/tracked_wallets row sharing
//     the agent's project_id (the schema has no per-agent FK on either
//     table — both are project-scoped) — a real, coarser-grained join, not a
//     literal "vaults this agent manages" relation. `wallets` always
//     includes the agent's own wallet_address match (if any) plus any other
//     tracked wallet on the same project.
//   - `evidence`/`whyIncluded`/`openGaps` are computed deterministically from
//     the fields above (wallet presence/balance, 30d revenue, x402 activity,
//     identity links, enrichedAt recency) — see
//     backend/src/projects/agent-detail-projections.ts for the exact rules.
// `confidence` is the existing openclaw_agents.source_confidence column
// (high|medium|low), not re-derived.
export interface AgentVaultSummary {
  id: string;
  name: string;
  strategyType: string | null;
  tvlUsd: number | null;
  apy: number | null;
}

export interface AgentWalletSummary {
  id: string;
  label: string;
  address: string | null;
  chain: string | null;
  balanceUsd: number | null;
  isAgentWallet: boolean; // true for the row matched by the agent's own wallet_address
}

// Reuses the same verified/partial/missing vocabulary as
// LeaderboardEvidence (§5.3) — no `token` leg here (AgentProfile has no
// linked-coin evidence row in the plan, unlike the leaderboard).
export interface AgentEvidence {
  wallet: EvidenceStatus;
  moneyIn: EvidenceStatus;
  x402: EvidenceStatus;
  identity: EvidenceStatus;
  freshness: EvidenceStatus;
}

export interface AgentDetail {
  id: string;
  name: string;
  protocol: string | null;
  isFacilitator: boolean;
  active: boolean;
  description: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  walletAddress: string | null;
  walletBalanceUsd: number | null;
  createdAt: string; // ISO 8601 — "seen · date" chip
  enrichedAt: string | null; // ISO 8601 — freshness reference
  confidence: "high" | "medium" | "low" | null;
  score: number; // composite, same formula as AgentDirectoryRow.score
  x402Score: number | null;
  x402Txns: number;
  x402VolumeUsd: number;
  x402Resources: number;
  revenue30dUsd: number;
  cumulativeRevenueUsd: number | null;
  productivityScore: number | null;
  x402Sparkline: number[]; // up to 26 weekly-summed buckets, chronological — PerformanceChart series
  evidence: AgentEvidence;
  whyIncluded: string[];
  openGaps: string[];
  vaults: AgentVaultSummary[];
  wallets: AgentWalletSummary[];
}

// GET /api/dashboards/coins/:id, /vaults/:id, /wallets/:id (issue #391,
// docs/bot-analytics-ui-port-plan.md §5.10/§5.12/§5.14, P3.3/P3.4/P3.5) — the
// coin/vault/wallet detail dossiers. Distinct from the LIST DTOs directly
// above (issue #386): a detail dossier carries history series + linked-
// entity lists a table row does not, so this is its own DTO set rather than
// a reshape of CoinListItem/VaultListItem/WalletListItem (same reasoning
// list2-projections.ts documents for List2*Row vs EntityRow).
//
// Every field is a real column/aggregate over the SAME facet + snapshot
// tables list2-projections.ts (#387) and entities-projections.ts (#384)
// already read (lobster_coins/agent_vaults/tracked_wallets + their daily_*_
// snapshots, migrations 0013/0014) — no new tables, no new writers. Two
// upstream dependencies have NOT landed as of this issue, so the fields they
// would have fed are simply absent rather than fabricated:
//   - P1.7 (CoinGecko/DexScreener/Blockscout proxy endpoints): CoinProfile's
//     About/rank/liquidity/ATH stats and ExtLink row, VaultProfile/
//     WalletProfile's on-chain tx summaries.
//   - P1.6 (wallet_holdings table + activity-log writer — the plan's OWN
//     documented data caveat at §5.14): WalletProfile's TokenHoldingsCard,
//     TokenDetailsDrawer, TransactionsCard/TxTransfersDialog, Recent Activity.
// Each interface below only carries what's actually backed today.

export interface CoinProfileLinkedAgent {
  id: string;
  name: string;
  href: string; // /agents/:id
}

export interface CoinProfilePricePoint {
  date: string; // YYYY-MM-DD, daily_coin_snapshots.snapshot_date
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

export interface CoinProfile {
  id: string;
  name: string;
  ticker: string | null;
  chain: string | null;
  logoUrl: string | null;
  contractAddress: string | null;
  priceUsd: number | null;
  percentChange24h: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  stale: boolean; // isStale(refreshedAt, COIN_REFRESH_FRESHNESS_BUDGET_MS) — same D24 rule as every other coin facet read
  refreshedAt: string | null;
  priceHistory: CoinProfilePricePoint[]; // ascending by date, up to 365d of daily_coin_snapshots
  linkedAgents: CoinProfileLinkedAgent[]; // same project_id, is_active agents
}

export interface VaultProfileLinkedAgent {
  id: string;
  name: string;
  href: string; // /agents/:id
}

export interface VaultProfileWallet {
  id: string;
  label: string;
  address: string | null;
  chain: string | null;
  balanceUsd: number | null;
  href: string; // /wallets/:id
}

export interface VaultProfileTvlPoint {
  date: string; // YYYY-MM-DD, daily_tvl_snapshots.snapshot_date
  tvlUsd: number | null;
}

export interface VaultProfileYieldPoint {
  date: string;
  apy: number | null;
}

export interface VaultProfile {
  id: string;
  name: string;
  protocol: string | null;
  strategyType: string | null;
  chain: string | null;
  vaultAddress: string | null;
  dataSource: string | null; // 'live' | 'static' | null — same domain list2/list3 already render (no SIMULATED/UPCOMING value exists in this schema; see dash-vault-profile.js)
  tvlUsd: number | null;
  apy: number | null;
  lastRebalanceAt: string | null;
  createdAt: string | null;
  stale: boolean; // isStale(refreshedAt, VAULT_REFRESH_FRESHNESS_BUDGET_MS)
  refreshedAt: string | null;
  tvlHistory: VaultProfileTvlPoint[]; // ascending by date, up to 365d of daily_tvl_snapshots
  // Always [] today (D11): this repo never fabricates the original's seeded
  // random-walk yield chart. Port the chart frame + toggle, feed the empty
  // state, until a real per-vault APY history table/writer exists.
  yieldHistory: VaultProfileYieldPoint[];
  linkedAgents: VaultProfileLinkedAgent[]; // best-effort project_id join — agent_vaults has no direct managing-agent FK
  linkedWallets: VaultProfileWallet[]; // best-effort project_id join, same caveat
}

export interface WalletProfileLinkedAgent {
  id: string;
  name: string;
  href: string; // /agents/:id
}

export interface WalletProfileBalancePoint {
  date: string; // YYYY-MM-DD, daily_wallet_snapshots.snapshot_date
  balanceUsd: number | null;
}

export interface WalletProfile {
  id: string;
  label: string;
  category: string | null;
  chain: string | null;
  address: string | null;
  balanceUsd: number | null;
  balance30dAgoUsd: number | null; // last snapshot at/before 30d ago, for the +/-30d delta
  lastTxAt: string | null;
  refreshedAt: string | null;
  stale: boolean; // isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS) — D14: wallet refresh is unimplemented, so this is near-always true today, honestly
  balanceHistory: WalletProfileBalancePoint[]; // ascending by date, up to 365d of daily_wallet_snapshots
  linkedAgent: WalletProfileLinkedAgent | null; // wallet_address match (lowercased) first, else same project_id
}

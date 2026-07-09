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
  balanceUsd: number | null;
}

export interface VaultEconomics {
  asOf: string; // ISO 8601
  stale: boolean;
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
// 'live' | 'stub' | 'stale' — a single failing leg degrades to its last
// persisted sample marked 'stale', never a fabricated or falsely-live number.
export type WalletHoldingProvenance = "live" | "stub" | "stale";

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

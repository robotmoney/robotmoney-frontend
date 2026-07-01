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
  // Asof-only regime backtest + predictive correlations (ported from the original
  // regime-snapshot.json). Present on the latest snapshot only; null on historical
  // rows. Additive/superset — existing fields unchanged.
  backtest?: BacktestPayload | null;
  correlations?: CorrelationsPayload | null;
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

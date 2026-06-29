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

export interface RegimeSnapshot {
  date: string;
  composite: number | null;
  compositePercentile: number | null;
  regime: string | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  percentiles: Record<string, number>;
  indicators: Record<string, unknown>;
}

export interface ResearchSignal {
  signalKey: string;
  date: string;
  payload: unknown;
}

// The asset_prices write's shape and its disagreement rule (D41; issue #849),
// with no database import: the pipeline worker builds these rows and the api
// writes them (ops/asset-prices.ts writeAssetPrice, issue 1034).
export type AssetPriceSource = "geckoterminal" | "pinned";

export interface AssetPriceWrite {
  priceDate: string;
  symbol: string;
  priceUsd: number;
  source: AssetPriceSource;
  /** Which pool answered; null when pinned or unresolved (markets §5.6). */
  poolKey: string | null;
  /** What `token=` named; null when pinned. */
  tokenAddress: string | null;
  observedAt: Date;
  fetchedAt: Date;
  configIdentity: string;
}

export interface AssetPriceDisagreement {
  priceDate: string;
  symbol: string;
  previousPriceUsd: number;
  freshPriceUsd: number;
  /** What the disagreeing value came from. `writeAssetPrice` always reports
   *  `'asset_prices'` (a value this table already held); a caller may report
   *  `'sample_row'` for a disagreement against the wallet_balance_samples row
   *  a prior pass wrote for the same (date, symbol) — the literal
   *  "sample row vs. price row" reading of D41 phase 2's verify step. */
  against: "asset_prices" | "sample_row";
}

// A relative tolerance, not an exact-equality check: the same numeric value
// can arrive through `numeric` round-tripping with a different string
// representation (e.g. trailing zeros), and that is not a disagreement worth
// reporting. Anything past this tolerance is a genuine reconciliation finding.
const DISAGREEMENT_RELATIVE_TOLERANCE = 1e-9;

export function assetPricesDisagree(previous: number, fresh: number): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(fresh)) return true;
  const scale = Math.max(Math.abs(previous), Math.abs(fresh), 1e-12);
  return Math.abs(previous - fresh) / scale > DISAGREEMENT_RELATIVE_TOLERANCE;
}


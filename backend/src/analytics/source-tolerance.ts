// Issue #1035 (decision D56 in docs/decisions.md): how far a re-observed value
// may differ from what the ledger already holds before it counts as NEW
// information. Pure — no I/O — because two writers must reach the SAME answer
// for the same pair of numbers:
//
//   - store/source-ledger-store.ts decides whether a re-acquisition appends a
//     source_value_versions row at all, and
//   - store/raw-history-store.ts decides whether raw_indicator_history's row is
//     rewritten (which is what fires migration 0056's overwrite trigger).
//
// If those two disagreed, the compatibility table and the ledger would drift by
// exactly the noise this module exists to absorb, and cutover/parity.ts would
// record a permanent matched:false. So both import withinTolerance() from here
// and nowhere else.
//
// THE RULE. |next - prior| <= relative * max(|next|, |prior|). A relative of 0
// is exact equality, which is what every source gets unless there is evidence
// that its upstream jitters (D56). Plain IEEE-754 double arithmetic, so the
// compaction migration (backend/migrations/0080_analytics_ledger_compaction.sql)
// computes the identical predicate in SQL `double precision`.
//
// A source_key that is not in the table below is compared EXACTLY. That is the
// conservative failure: an unlisted series records every change, as it did
// before this issue, rather than silently dropping real revisions.
// tests/analytics-source-tolerance.test.ts fails if an extractor uses a key
// that has no entry here.

export interface SourceTolerance {
  /** Relative tolerance: the largest |Δ| / max(|a|, |b|) still treated as the same observation. */
  relative: number;
  /** Why this value — the evidence D56 records for it. */
  basis: "exact" | "yahoo-float32";
}

const EXACT: SourceTolerance = { relative: 0, basis: "exact" };

// Yahoo's chart API serves float32-derived numbers (e.g. 18.719999313354492):
// the same close re-served can differ in its last representable digits, and a
// ratio of two such series compounds that. The production ledger measured the
// resulting 'revision' rows at a relative 1e-9 to 1e-6 of their prior (issue
// #1035). 1e-6 is the top of that measured band — and still well below any real
// Yahoo revision (a one-cent correction on a $500 close is 2e-5; a dividend or
// split re-adjustment is 1e-4 and up).
const YAHOO_FLOAT32: SourceTolerance = { relative: 1e-6, basis: "yahoo-float32" };

/**
 * Every source_key the extractors write, with its tolerance. Keep this list in
 * step with D56 in docs/decisions.md: that decision names each key.
 */
export const SOURCE_TOLERANCES: Readonly<Record<string, SourceTolerance>> = {
  // extract/sources.ts — the regime registry (analyze/indicators.ts), one key per indicator.
  "raw_indicator_history:T10Y2Y": EXACT, // fred
  "raw_indicator_history:DFII10": EXACT, // fred
  "raw_indicator_history:T5YIE": EXACT, // fred
  "raw_indicator_history:HY_OAS": EXACT, // fred
  "raw_indicator_history:DXY": EXACT, // fred
  "raw_indicator_history:ICSA": EXACT, // fred
  "raw_indicator_history:VIX": YAHOO_FLOAT32, // yahoo ^VIX
  "raw_indicator_history:COPPER_GOLD": YAHOO_FLOAT32, // yahoo HG=F / GC=F
  "raw_indicator_history:SPX_TREND": YAHOO_FLOAT32, // yahoo ^GSPC
  "raw_indicator_history:IWM_SPY": YAHOO_FLOAT32, // yahoo IWM / SPY
  "raw_indicator_history:DEFI_TVL": EXACT, // defillama_tvl
  "raw_indicator_history:STABLES": EXACT, // defillama_stables
  "raw_indicator_history:BTC_ACTIVE": EXACT, // blockchain_com
  "raw_indicator_history:ETH_ACTIVE": EXACT, // coinmetrics
  "raw_indicator_history:BTC_MVRV": EXACT, // coinmetrics
  "raw_indicator_history:BTC_ETH": YAHOO_FLOAT32, // yahoo BTC-USD / ETH-USD
  "raw_indicator_history:ETH_TREND": YAHOO_FLOAT32, // yahoo ETH-USD
  "raw_indicator_history:NEW_TOKENS": EXACT, // geckoterminal_newpools
  "raw_indicator_history:DEFI_GROWTH": EXACT, // defillama_tvl
  "raw_indicator_history:STABLES_GROWTH": EXACT, // defillama_stables
  "raw_indicator_history:SPHB_SPLV": YAHOO_FLOAT32, // yahoo SPHB / SPLV
  "raw_indicator_history:MTUM_SPY": YAHOO_FLOAT32, // yahoo MTUM / SPY
  "raw_indicator_history:IWF_IWD": YAHOO_FLOAT32, // yahoo IWF / IWD
  "raw_indicator_history:XLU_SPY": YAHOO_FLOAT32, // yahoo XLU / SPY
  "raw_indicator_history:XLP_XLY": YAHOO_FLOAT32, // yahoo XLP / XLY
  "raw_indicator_history:SHILLER_CAPE": EXACT, // shiller_cape / multpl

  // access/data-source.ts — research inputs.
  "raw_indicator_history:MNA": EXACT, // edgar filing counts
  "research:BTC-USD": YAHOO_FLOAT32,
  "research:QQQ": YAHOO_FLOAT32,
  "research:SPY": YAHOO_FLOAT32,
  "research:RSP": YAHOO_FLOAT32,
  "research:NVDA": YAHOO_FLOAT32, // TOP7
  "research:MSFT": YAHOO_FLOAT32, // TOP7
  "research:AAPL": YAHOO_FLOAT32, // TOP7
  "research:GOOGL": YAHOO_FLOAT32, // TOP7
  "research:AMZN": YAHOO_FLOAT32, // TOP7
  "research:META": YAHOO_FLOAT32, // TOP7
  "research:AVGO": YAHOO_FLOAT32, // TOP7
  "research:MARGIN": EXACT, // fred BOGZ1FL663067003Q
  "research:CONF": EXACT, // fred UMCSENT

  // access/data-source.ts — backtest overlays.
  "backtest:^GSPC": YAHOO_FLOAT32,
  "backtest:ETH-USD": YAHOO_FLOAT32,
  "backtest:DTB3": EXACT, // fred
};

export function toleranceFor(sourceKey: string): SourceTolerance {
  return SOURCE_TOLERANCES[sourceKey] ?? EXACT;
}

/** The raw_indicator_history row for `indicator` lives in the ledger under this key. */
export function rawIndicatorSourceKey(indicator: string): string {
  return `raw_indicator_history:${indicator}`;
}

/**
 * True when `next` carries no new information over `prior` for this source.
 * Exact equality always counts as within tolerance, whatever the table says.
 */
export function withinTolerance(sourceKey: string, prior: number, next: number): boolean {
  if (prior === next) return true;
  const { relative } = toleranceFor(sourceKey);
  return Math.abs(next - prior) <= relative * Math.max(Math.abs(next), Math.abs(prior));
}

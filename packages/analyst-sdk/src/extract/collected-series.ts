// Collected series (issue 1653): series that are fetched, stored and served on
// the public raw-history route, but never scored. An entry carries only its
// collection fields. It has no panel, sign, transform, weight or fill policy:
// those are scoring parameters.
//
// Every scoring reader (computeRegime, prepareRegimeInputs, the backend
// snapshot builder, run.ts READ_IDS, coverage, labels, signals, the
// comparisons) reads INDICATORS only, so an entry here changes no figure.
// Collection readers (the fetch, merge and store of a run, the producer's gap
// catch-up, fetchAll's default list, the floor-seed generator, sourceCalendar,
// the admin raw-series allowlist) read collectionRegistry().
//
// To score a collected series, an analyst moves its entry into INDICATORS and
// adds the scoring fields under a methodology version
// (docs/technical/regime-engine.md section 2). It needs no further collection
// work.
import { INDICATORS, type Indicator } from "../analyze/indicators.ts";

/** The fields a fetch, store and route need. Every Indicator is one. */
// `ratioInput` says whether a Yahoo ratio is stored (issue 1644): a collection field.
// `field` (issue 1753) is the value read of a Yahoo chart response: absent, the
// adjusted close; "volume", the day's volume, its own series `yahoo:<SYMBOL>.volume`.
export type SourceSeries = Pick<Indicator, "id" | "name" | "source" | "series" | "unit" | "source_url" | "description" | "ratioInput"> & { field?: "volume" };

export interface CollectedSeries extends SourceSeries {
  source_url: string;
  description: string;
}

/** The source id of a single-series collected entry: `<provider>:<symbol>`, with `.volume` for a volume field. */
export function collectedSourceId(s: SourceSeries): string {
  if (typeof s.series !== "string") throw new Error(`collected series ${s.id}: it names no single source series`);
  return `${s.source}:${s.series}${s.field === undefined ? "" : `.${s.field}`}`;
}

export const COLLECTED_SERIES: readonly CollectedSeries[] = [
  {
    id: "BAA10Y",
    name: "Baa corporate credit spread",
    source: "fred",
    series: "BAA10Y",
    unit: "percent",
    source_url: "https://fred.stlouisfed.org/series/BAA10Y",
    description:
      "Moody's seasoned Baa corporate bond yield minus the 10-year Treasury constant maturity yield, published daily by FRED. Its free history starts 1986-01-02.",
  },
  // Issue 1753: the raw inputs of methodology v5's derived indicators
  // (analyze/indicators.ts V5_DERIVED_SERIES). Collected by every regime run,
  // scored by nothing on the main line. Their ids are V5_INPUT_IDS.
  {
    id: "FED_SURPLUS_MONTHLY",
    name: "Monthly federal surplus or deficit",
    source: "fred",
    series: "MTSDS133FMS",
    unit: "millions of dollars",
    source_url: "https://fred.stlouisfed.org/series/MTSDS133FMS",
    description: "The federal government's monthly surplus (positive) or deficit (negative) from the Monthly Treasury Statement, in millions of dollars, published by FRED.",
  },
  {
    id: "US_GDP",
    name: "US nominal GDP",
    source: "fred",
    series: "GDP",
    unit: "billions of dollars",
    source_url: "https://fred.stlouisfed.org/series/GDP",
    description: "US gross domestic product, quarterly, in billions of dollars at a seasonally adjusted annual rate, published by FRED.",
  },
  {
    id: "CBOE_VIX3M",
    name: "CBOE 3-month volatility index",
    source: "yahoo",
    series: "^VIX3M",
    unit: "index",
    source_url: "https://finance.yahoo.com/quote/%5EVIX3M",
    description: "The market's expected volatility of the S&P 500 over the next three months, from option prices (CBOE VIX3M), daily close.",
  },
  {
    id: "CBOE_SKEW",
    name: "CBOE SKEW index",
    source: "yahoo",
    series: "^SKEW",
    unit: "index",
    source_url: "https://finance.yahoo.com/quote/%5ESKEW",
    description: "The price of protection against a large S&P 500 fall, from out-of-the-money option prices (CBOE SKEW), daily close.",
  },
  {
    id: "SPX_VOLUME",
    name: "S&P 500 daily volume",
    source: "yahoo",
    series: "^GSPC",
    field: "volume",
    unit: "shares",
    source_url: "https://finance.yahoo.com/quote/%5EGSPC",
    description: "The S&P 500 index's daily volume, read from the same Yahoo chart response as its close.",
  },
];

/**
 * The INDICATORS entries followed by the COLLECTED_SERIES entries. Throws
 * when an id is in both lists, or twice in one.
 */
export function collectionRegistry(
  indicators: readonly SourceSeries[] = INDICATORS,
  collected: readonly SourceSeries[] = COLLECTED_SERIES,
): SourceSeries[] {
  const seen = new Set<string>();
  const out = [...indicators, ...collected];
  for (const s of out) {
    if (seen.has(s.id)) throw new Error(`collection registry: id ${s.id} is declared twice (INDICATORS and COLLECTED_SERIES must not share an id)`);
    seen.add(s.id);
  }
  return out;
}

// Checked at module load: a duplicate declaration stops every run before any fetch.
collectionRegistry();

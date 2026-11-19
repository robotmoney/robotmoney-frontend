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
export type SourceSeries = Pick<Indicator, "id" | "name" | "source" | "series" | "unit" | "source_url" | "description" | "ratioInput">;

export interface CollectedSeries extends SourceSeries {
  source_url: string;
  description: string;
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

// The storage half of each published model preset (issue 1765, phase 2): the
// series mapping a run of the version reads, and the stored-under aliases it
// resolves its input with. presets.ts reads these rows into its presets and
// re-exports seriesMappingFor and storedUnderFor; nothing else states them.
//
// WHY A SEPARATE FILE. The archive format (archive/format1.ts) picks a run's
// mapping by its methodology label, and the public analytics routes import that
// module, so it must reach no calculation code
// (backend/tests/api/public-analytics-archives.test.ts forbids src/transform/
// and every src/analyze/ file but indicators.ts). presets.ts imports the
// derived-series declarations from transform/derived.ts. This file imports the
// series ids alone, so format1.ts reads it and stays clear of the calculation.
//
// A label is a string here, never checked against REGIME_VERSIONS: a label that
// names no preset (the synthetic fixtures' regime-v3) reads the main-line
// mapping, as it always has.
import { SERIES_MAPPING, STORED_UNDER, V5_SERIES_MAPPING, V5_STORED_UNDER, type SeriesMapping } from "../series-ids.ts";

/** The storage facts of one preset. */
export interface PresetSeries {
  /** Every storage key the version reads, per consumer (SERIES_MAPPING, or the main-line mapping plus the derived inputs). */
  readonly seriesMapping: readonly SeriesMapping[];
  /** The input ids read from another input's stream when the input omits them (resolveInputHistory). */
  readonly storedUnder: Readonly<Record<string, string>>;
}

// The main line's storage: what v3 and v4 read, and what any other label reads.
const MAIN_LINE_SERIES: PresetSeries = Object.freeze({ seriesMapping: SERIES_MAPPING, storedUnder: STORED_UNDER });

/** The storage facts of each published preset, keyed by its tag. */
export const PRESET_SERIES = Object.freeze({
  v3: MAIN_LINE_SERIES,
  v4: MAIN_LINE_SERIES,
  v5: Object.freeze({ seriesMapping: V5_SERIES_MAPPING, storedUnder: V5_STORED_UNDER }) satisfies PresetSeries,
});

const seriesOf = (version: string): PresetSeries =>
  Object.hasOwn(PRESET_SERIES, version) ? PRESET_SERIES[version as keyof typeof PRESET_SERIES] : MAIN_LINE_SERIES;

/** The storage mapping a methodology version reads (issue 1753): its preset's, and SERIES_MAPPING for a label that names no preset. */
export function seriesMappingFor(version: string): readonly SeriesMapping[] {
  return seriesOf(version).seriesMapping;
}

/** The stored-under aliases a methodology version resolves its input with: its preset's, and STORED_UNDER for a label that names no preset. */
export function storedUnderFor(version: string): Readonly<Record<string, string>> {
  return seriesOf(version).storedUnder;
}

// The published model presets (issue 1765, phase 2): whatever a methodology tag
// means, stated once as one frozen object per tag. Every model fact of a
// published tag is stated here, with two exceptions: the storage half of a
// preset lives in model/preset-series.ts, for the reason given there, and the
// backtest rules stay in analyze/backtest.ts (REGIME_BACKTEST_RULES). Every
// per-version model table of analyze/regime-versions.ts (REGIME_RULES,
// REGIME_REGISTRY, REGIME_KEPT_HISTORY and the rest) is a view of PRESETS, and
// MODELS (model/models.ts) is PRESETS plus each version's backtest rules. Where
// a version is published (REGIME_LINE, REGIME_ARTIFACT_KIND,
// REGIME_PUBLISHED_PANELS) is a platform fact, not a model property, and stays
// in analyze/regime-versions.ts.
//
// A LEAF. This module imports the indicator registry, the derived-series
// declarations and the series ids, and never analyze/regime-versions.ts or
// analyze/backtest.ts: backtest.ts imports regime-versions.ts and calls
// adoptionDate() as it loads, so a preset module that reached backtest.ts would
// be read before it is defined.
//
// Methodology version tag stamped on every persisted regime snapshot row —
// mirrors agentjuno/robotmoney data/regime/regime-versions.json `current`.
//
// v3: point-in-time inverse-correlation weighting (the declared weight lookback
// per day; 21-day refresh, 25% cap) — every run recomputes the full history on
// best-available raw data. Raw input KEYS are never deleted, but
// raw_indicator_history VALUES are revised in place (ON CONFLICT DO UPDATE) when
// a fetched value differs beyond the D56 per-source tolerance; each revision is
// recorded in analytics_overwrite_events and source_value_versions. A run's
// recomputed history is kept in its frozen artifact (analytics_output_snapshots)
// and is not what readers are served: each day shows the figure published that
// day, frozen once the day is over (decision D83, issue 1182). See
// docs/technical/regime-engine.md section 8.1 and decision D59. The labels are
// cut on a second rolling rank, over the declared percentile lookback, of the
// composite and of each panel index.
//
// v4 (issue 1652, decisions D84 and D88; tagged v5 before D88): v3 with the regime label cut on the composite
// itself and each panel label on its panel index. The rolling ranks of the
// composite and the panel indices stay in the output as information only.
// Issue 1739 corrected v4 in place: its panel weights refit on a fixed 21-day
// calendar (rules.weightRefresh), never on the run's last day, which v3 keeps.
//
// v5 (issue 1753, decision D96): the model ported from the downstream
// experiment-lex-equity. It is computed and published beside the served line
// (REGIME_LINE), never on it. Its registry is V5_INDICATORS
// (analyze/indicators.ts): VIX in the factor panel and four derived indicators.
// Every day is computed on the day and kept (analyze/kept-regime.ts): weights
// are refit every day, the composite is the mid-rank of the equal-weight panel
// mean within every kept mean to date, and a later run never changes a kept day.
//
// Tags increase by one with no gaps (D88). The frozen, versioned publication
// model (docs/technical/regime-engine.md section 11.8.3, PD10) takes the next
// unused tag when it is built.
import { ALL_PANELS, INDICATORS, PANELS, ROLLING_WINDOW_DAYS, V5_INDICATORS, type Indicator, type Panel } from "../analyze/indicators.ts";
import { V5_DERIVED_SERIES, type DerivedSeries } from "../transform/derived.ts";
import type { SeriesMapping } from "../series-ids.ts";
import { PRESET_SERIES, type PresetSeries } from "./preset-series.ts";

export { seriesMappingFor, storedUnderFor, type PresetSeries } from "./preset-series.ts";

export const REGIME_VERSIONS = ["v3", "v4", "v5"] as const;
export type RegimeVersion = (typeof REGIME_VERSIONS)[number];

// The served methodology: the last version declared main (D88 item 2 as D96 amends it; REGIME_LINE).
export const CURRENT_REGIME_VERSION: RegimeVersion = "v4";

/**
 * One lookback window of the regime engine (issue 1659). `trailing` is the
 * trailing `days` days ending on the day computed; `inception` is all history
 * from day 0 of the date axis, with no cap.
 */
export type LookbackWindow = { kind: "trailing"; days: number } | { kind: "inception" };

/**
 * The lookback windows of one methodology version: `rank` is the indicator
 * rank window, `weight` the panel weight window, `percentile` the window of the
 * composite and panel percentiles (which cut the label under v3).
 */
export interface RegimeLookback {
  rank: LookbackWindow;
  weight: LookbackWindow;
  percentile: LookbackWindow;
}

/**
 * The panel weight refresh rule of one methodology version (issue 1739): refit
 * every `intervalDays` days on a fixed calendar that starts at `anchor`, so a
 * day's weights never depend on the run that computes it. `refitOnLastDay`
 * keeps the legacy refit on the run's last axis day: only v3 sets it.
 */
export interface WeightRefresh {
  intervalDays: number;
  /** Calendar date of day 0 of the refresh calendar (the regime backfill start). */
  anchor: string;
  refitOnLastDay: boolean;
}

export const WEIGHT_REFRESH_ANCHOR = "2018-01-01";

/**
 * The composite rule when an included panel has no index on a day (issue 1741):
 * `rebase` averages the panels that are finite (v3), `nan` leaves the composite
 * NaN and the label null (v4).
 */
export type MissingPanelRule = "rebase" | "nan";

/**
 * How the composite is normalised (issue 1753). `none`: the composite is the
 * mean of the panel indices (v3, v4). `percentile`: the composite is the
 * mid-rank of that mean over the percentile lookback (v5: since inception), and
 * no second percentile of the composite or of a panel is computed.
 */
export type CompositeNormalisation = "none" | "percentile";

/**
 * What a label is cut on (issue 1751): `series` is the composite or panel index
 * itself (v4, issue 1652), `percentile` its rolling percentile over the
 * percentile lookback (v3).
 */
export type LabelCut = "series" | "percentile";

/**
 * Every rule of the engine, stated as one object (issue 1751). A caller passes
 * its own `rules` to prepareRegimeInputs, knowledgeTimeHistory,
 * latestCompleteDay, missingOnDay, computeRegime and regimeLabels to change one
 * rule; without it they read REGIME_RULES of the version.
 */
export interface RegimeRules {
  /** Dating rule: read each value from the day it was published (REGIME_KNOWLEDGE_TIME). */
  knowledgeTime: boolean;
  /** Window counting: an `exchange` series counts its own observation days (REGIME_OBSERVATION_WINDOWS). */
  observationWindows: boolean;
  /** The weight refit calendar (REGIME_WEIGHT_REFRESH). */
  weightRefresh: WeightRefresh;
  /** The composite on a day an included panel has no index (REGIME_MISSING_PANEL). */
  missingPanel: MissingPanelRule;
  /** What each label is cut on (REGIME_LABEL_CUT). */
  labelCut: LabelCut;
  /** The rank, weight and percentile windows (REGIME_LOOKBACK). */
  lookback: RegimeLookback;
  /** The in-sample end of a backtest of these rules (REGIME_ADOPTION_DATE). */
  adoptionDate: string;
  /** How the composite is normalised (REGIME_COMPOSITE_NORMALISATION). Absent: "none". */
  compositeNormalisation?: CompositeNormalisation;
  /** Whether each day is computed once and kept (REGIME_KEPT_HISTORY). Absent: false. */
  keptHistory?: boolean;
}

/**
 * Whether a model keeps its history (issue 1753). `recompute`: every run
 * recomputes every day from its own inputs (v3, v4). `kept`: a day is computed
 * once, on the day, and kept; a later run computes only its own day and derives
 * the composite and the labels from the kept days (analyze/kept-regime.ts).
 * rules.keptHistory states the same fact for the engine and must agree with it.
 */
export type ModelHistory = "recompute" | "kept";

/**
 * The panels of a model: `all` are computed and published, `included` are the
 * ones the composite averages, 1/n each (runRegime's default). The panels each
 * version's published runs averaged are a platform fact, REGIME_PUBLISHED_PANELS
 * in analyze/regime-versions.ts.
 */
export interface ModelPanels {
  readonly all: readonly Panel[];
  readonly included: readonly Panel[];
}

/**
 * Every fact of a model but its backtest rules, which live in
 * analyze/backtest.ts (REGIME_BACKTEST_RULES) and which this leaf cannot import.
 * RegimeModel (model/models.ts) is these facts plus `backtest`.
 */
export interface ModelFacts {
  /** The published tag ("v4"), or any research name. */
  readonly id: string;
  /** Every engine rule; lookback, weightRefresh and adoptionDate live here and nowhere else. */
  readonly rules: RegimeRules;
  /** The scoring registry. */
  readonly registry: readonly Indicator[];
  /** The derived series the model computes from raw inputs (none for v3 and v4). */
  readonly derived: readonly DerivedSeries[];
  readonly history: ModelHistory;
  readonly panels: ModelPanels;
  /** The storage keys the model reads (seriesMappingFor). */
  readonly seriesMapping: readonly SeriesMapping[];
  /** The stored-under aliases the model resolves its input with (storedUnderFor). */
  readonly storedUnder: Readonly<Record<string, string>>;
}

const TRAILING_3Y: LookbackWindow = Object.freeze({ kind: "trailing", days: ROLLING_WINDOW_DAYS });
const PANELS_OF_EVERY_PRESET: ModelPanels = Object.freeze({ all: ALL_PANELS, included: PANELS });
const NO_DERIVED: readonly DerivedSeries[] = Object.freeze([]);
// Every published preset's storage row; the table is checked whole against the tags here.
const SERIES: Readonly<Record<RegimeVersion, PresetSeries>> = PRESET_SERIES;

// Rules are stated in this key order; compositeNormalisation and keptHistory
// only where a version departs from v3 and v4, so their rules keep the shape they had.
const V3: ModelFacts = Object.freeze({
  id: "v3",
  rules: Object.freeze({
    knowledgeTime: false,
    observationWindows: false,
    weightRefresh: Object.freeze({ intervalDays: 21, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: true }),
    missingPanel: "rebase",
    labelCut: "percentile",
    lookback: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
    adoptionDate: "2026-07-01",
  }),
  registry: INDICATORS,
  derived: NO_DERIVED,
  history: "recompute",
  panels: PANELS_OF_EVERY_PRESET,
  seriesMapping: SERIES.v3.seriesMapping,
  storedUnder: SERIES.v3.storedUnder,
});

const V4: ModelFacts = Object.freeze({
  id: "v4",
  rules: Object.freeze({
    // Corrected in place (issue 1733): each value is read from the day it was published.
    knowledgeTime: true,
    // Issue 1741, D93: an `exchange` series counts its own observation days.
    observationWindows: true,
    weightRefresh: Object.freeze({ intervalDays: 21, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: false }),
    missingPanel: "nan",
    labelCut: "series",
    lookback: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
    adoptionDate: "2026-11-17",
  }),
  registry: INDICATORS,
  derived: NO_DERIVED,
  history: "recompute",
  panels: PANELS_OF_EVERY_PRESET,
  seriesMapping: SERIES.v4.seriesMapping,
  storedUnder: SERIES.v4.storedUnder,
});

const V5: ModelFacts = Object.freeze({
  id: "v5",
  rules: Object.freeze({
    // v5 reads the registry's own series by period date; only its derived series
    // are lagged, on their DerivedSeries declarations (issue 1753).
    knowledgeTime: false,
    observationWindows: false,
    // v5 refits every day, so every day is a refresh date and none depends on the run's last day.
    weightRefresh: Object.freeze({ intervalDays: 1, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: false }),
    missingPanel: "rebase",
    labelCut: "series",
    // The composite is ranked within every kept mean since inception.
    lookback: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: Object.freeze({ kind: "inception" }) }),
    // The day the model was chosen. It is not v5's backtest split (REGIME_BACKTEST_RULES.v5).
    adoptionDate: "2026-11-23",
    compositeNormalisation: "percentile",
    keptHistory: true,
  }),
  registry: V5_INDICATORS,
  derived: V5_DERIVED_SERIES,
  history: "kept",
  panels: PANELS_OF_EVERY_PRESET,
  seriesMapping: SERIES.v5.seriesMapping,
  storedUnder: SERIES.v5.storedUnder,
});

/** The published presets without their backtest rules, in tag order. MODELS (model/models.ts) is the public value. */
export const PRESETS: Readonly<Record<RegimeVersion, ModelFacts>> = Object.freeze({ v3: V3, v4: V4, v5: V5 });

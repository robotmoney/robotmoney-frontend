import { ALL_PANELS, INDICATORS, PANELS, ROLLING_WINDOW_DAYS, V5_INDICATORS, type Indicator, type Panel, type PanelMembership } from "./indicators.ts";
import { V5_DERIVED_SERIES, type DerivedSeries } from "../transform/derived.ts";

// Methodology version tag stamped on every persisted regime snapshot row —
// mirrors agentjuno/robotmoney data/regime/regime-versions.json `current`.
//
// v3: point-in-time inverse-correlation weighting (the declared weight lookback
// per day, REGIME_LOOKBACK below; 21-day refresh, 25% cap) — every run recomputes the full history on
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
// calendar (REGIME_WEIGHT_REFRESH), never on the run's last day, which v3 keeps.
//
// v5 (issue 1753, decision D96): the model ported from the downstream
// experiment-lex-equity. It is computed and published beside the served line
// (REGIME_LINE), never on it. Its registry is REGIME_REGISTRY.v5 (V5_INDICATORS
// in analyze/indicators.ts): VIX in the factor panel and four derived indicators.
// Every day is computed on the day and kept (analyze/kept-regime.ts): weights
// are refit every day, the composite is the mid-rank of the equal-weight panel
// mean within every kept mean to date, and a later run never changes a kept day.
//
// Tags increase by one with no gaps (D88). The frozen, versioned publication
// model (docs/technical/regime-engine.md section 11.8.3, PD10) takes the next
// unused tag when it is built.
export const REGIME_VERSIONS = ["v3", "v4", "v5"] as const;
export type RegimeVersion = (typeof REGIME_VERSIONS)[number];

/**
 * Where a version is published (issue 1753, decision D96). `main`: the served
 * line (regime_snapshots, every reader of the main line). `beside`: its own
 * labelled line, read only by a request that names the version.
 */
export type RegimeLine = "main" | "beside";
export const REGIME_LINE: Readonly<Record<RegimeVersion, RegimeLine>> = Object.freeze({ v3: "main", v4: "main", v5: "beside" });

/** The versions published beside the main line, in tag order. */
export const BESIDE_REGIME_VERSIONS: readonly RegimeVersion[] = Object.freeze(REGIME_VERSIONS.filter((v) => REGIME_LINE[v] === "beside"));

/**
 * The artifact kind a line's regime rows are frozen under (issue 1753,
 * migration 0136; issue 1765, D-b). A run of a beside version freezes its rows
 * as `regime_beside_snapshots`, and its `regime_snapshots` artifact is the
 * empty list. A platform fact, not a property of a model.
 */
export const REGIME_ARTIFACT_KIND = Object.freeze({ main: "regime_snapshots", beside: "regime_beside_snapshots" } as const);
export type RegimeArtifactKind = (typeof REGIME_ARTIFACT_KIND)[RegimeLine];

/** The artifact kind a run of `version` freezes its regime rows under: the kind of its line. */
export function regimeArtifactKindOf(version: RegimeVersion): RegimeArtifactKind {
  return REGIME_ARTIFACT_KIND[REGIME_LINE[version]];
}

// The panel membership every published v3 run was computed under, before D89
// included the factor panel: computed and published, not averaged.
const V3_PUBLISHED_MEMBERSHIP: Readonly<Record<Panel, PanelMembership>> = Object.freeze({ macro: "included", onchain: "included", factor: "excluded" });
const includedPanels = (m: Readonly<Record<Panel, PanelMembership>>): readonly Panel[] => Object.freeze(ALL_PANELS.filter((p) => m[p] === "included"));

/**
 * The panels the composite of each version's published runs averages (issue
 * 1765). Every production v3 run averaged macro and onchain only (D89 item 6);
 * v4 was never published over two panels (D89 item 5), and v5 averages all
 * three. A published run's methodology row records no panels, so a replay
 * reads them here. A platform fact, never derived from a model.
 */
export const REGIME_PUBLISHED_PANELS: Readonly<Record<RegimeVersion, readonly Panel[]>> = Object.freeze({
  v3: includedPanels(V3_PUBLISHED_MEMBERSHIP),
  v4: PANELS,
  v5: PANELS,
});

// The served methodology: the last version declared main (D88 item 2 as D96 amends it).
export const CURRENT_REGIME_VERSION: RegimeVersion = "v4";

/** The scoring registry of each methodology version (issue 1753). v3 and v4 read INDICATORS itself. */
export const REGIME_REGISTRY: Readonly<Record<RegimeVersion, readonly Indicator[]>> = Object.freeze({ v3: INDICATORS, v4: INDICATORS, v5: V5_INDICATORS });

/** The derived series each methodology version computes from raw inputs (none for v3 and v4). */
export const REGIME_DERIVED_SERIES: Readonly<Record<RegimeVersion, readonly DerivedSeries[]>> = Object.freeze({ v3: [], v4: [], v5: V5_DERIVED_SERIES });

/** True for a methodology version this engine can compute (and so replay). */
export function isRegimeVersion(v: unknown): v is RegimeVersion {
  return typeof v === "string" && (REGIME_VERSIONS as readonly string[]).includes(v);
}

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

const TRAILING_3Y: LookbackWindow = Object.freeze({ kind: "trailing", days: ROLLING_WINDOW_DAYS });

/** The declared lookback of every methodology version (issue 1659). */
export const REGIME_LOOKBACK: Readonly<Record<RegimeVersion, RegimeLookback>> = Object.freeze({
  v3: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
  v4: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
  // v5: the composite is ranked within every kept mean since inception.
  v5: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: Object.freeze({ kind: "inception" }) }),
});

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

export const REGIME_WEIGHT_REFRESH: Readonly<Record<RegimeVersion, WeightRefresh>> = Object.freeze({
  v3: Object.freeze({ intervalDays: 21, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: true }),
  v4: Object.freeze({ intervalDays: 21, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: false }),
  // v5 refits every day, so every day is a refresh date and none depends on the run's last day.
  v5: Object.freeze({ intervalDays: 1, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: false }),
});

/**
 * Whether a version reads its inputs by knowledge time (issue 1733,
 * docs/technical/regime-engine.md section 8.1.2): each value from the day it was
 * published, at the version known then. v4 is corrected in place; v3 keeps
 * reading by period date, so its published runs replay byte for byte.
 */
// v5 reads the registry's own series by period date; only its derived series
// are lagged, on their DerivedSeries declarations (issue 1753).
export const REGIME_KNOWLEDGE_TIME: Readonly<Record<RegimeVersion, boolean>> = Object.freeze({ v3: false, v4: true, v5: false });

/**
 * Whether a version counts observation days (issue 1741, decision D93): an
 * `exchange` series is transformed, ranked and correlated over its own real
 * observations, each counted once, and the result is placed on the calendar
 * axis. v3 keeps the forward-filled rows in every window.
 */
export const REGIME_OBSERVATION_WINDOWS: Readonly<Record<RegimeVersion, boolean>> = Object.freeze({ v3: false, v4: true, v5: false });

/**
 * The composite rule when an included panel has no index on a day (issue 1741):
 * `rebase` averages the panels that are finite (v3), `nan` leaves the composite
 * NaN and the label null (v4).
 */
export type MissingPanelRule = "rebase" | "nan";
export const REGIME_MISSING_PANEL: Readonly<Record<RegimeVersion, MissingPanelRule>> = Object.freeze({ v3: "rebase", v4: "nan", v5: "rebase" });

/**
 * How the composite is normalised (issue 1753). `none`: the composite is the
 * mean of the panel indices (v3, v4). `percentile`: the composite is the
 * mid-rank of that mean over the percentile lookback (v5: since inception), and
 * no second percentile of the composite or of a panel is computed.
 */
export type CompositeNormalisation = "none" | "percentile";
export const REGIME_COMPOSITE_NORMALISATION: Readonly<Record<RegimeVersion, CompositeNormalisation>> = Object.freeze({ v3: "none", v4: "none", v5: "percentile" });

/**
 * Whether a version keeps its history (issue 1753). false: every run recomputes
 * every day from its own inputs (v3, v4). true: a day is computed once, on the
 * day, and kept; a later run computes only its own day and derives the
 * composite and the labels from the kept days (analyze/kept-regime.ts).
 */
export const REGIME_KEPT_HISTORY: Readonly<Record<RegimeVersion, boolean>> = Object.freeze({ v3: false, v4: false, v5: true });

const MS_PER_DAY = 86_400_000;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);

/** The latest refresh date on or before `day`; null before the anchor. */
export function refreshDateOn(day: string, refresh: WeightRefresh): string | null {
  const n = dayNumber(day) - dayNumber(refresh.anchor);
  if (!Number.isFinite(n)) throw new RangeError(`bad day ${JSON.stringify(day)}`);
  if (n < 0) return null;
  const fit = dayNumber(refresh.anchor) + Math.floor(n / refresh.intervalDays) * refresh.intervalDays;
  return new Date(fit * MS_PER_DAY).toISOString().slice(0, 10);
}

/** True when `day` is a refresh date of the calendar. */
export function isRefreshDate(day: string, refresh: WeightRefresh): boolean {
  return refreshDateOn(day, refresh) === day;
}

/**
 * The day each methodology version was adopted (issue 1734, decision D94).
 * Every backtest statistic before it is in-sample (the version was tuned on
 * that data), after it out-of-sample.
 */
export const REGIME_ADOPTION_DATE: Readonly<Record<string, string>> = Object.freeze({
  v3: "2026-07-01",
  v4: "2026-11-17",
  // The day the model was chosen. It is not v5's backtest split (REGIME_BACKTEST_RULES.v5).
  v5: "2026-11-23",
});

/** Thrown by adoptionDate for a version with no declared adoption date. */
export class AdoptionDateError extends Error {
  constructor(version: string) {
    super(`regime methodology version ${JSON.stringify(version)} declares no adoption date (REGIME_ADOPTION_DATE)`);
    this.name = "AdoptionDateError";
  }
}

/** The adoption date (YYYY-MM-DD) of a methodology version; throws AdoptionDateError when there is none. */
export function adoptionDate(version: string): string {
  const d = Object.hasOwn(REGIME_ADOPTION_DATE, version) ? REGIME_ADOPTION_DATE[version] : undefined;
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new AdoptionDateError(version);
  return d;
}

/**
 * What a label is cut on (issue 1751): `series` is the composite or panel index
 * itself (v4, issue 1652), `percentile` its rolling percentile over the
 * percentile lookback (v3).
 */
export type LabelCut = "series" | "percentile";
export const REGIME_LABEL_CUT: Readonly<Record<RegimeVersion, LabelCut>> = Object.freeze({ v3: "percentile", v4: "series", v5: "series" });

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

const rulesOfVersion = (v: RegimeVersion): RegimeRules =>
  Object.freeze({
    knowledgeTime: REGIME_KNOWLEDGE_TIME[v],
    observationWindows: REGIME_OBSERVATION_WINDOWS[v],
    weightRefresh: REGIME_WEIGHT_REFRESH[v],
    missingPanel: REGIME_MISSING_PANEL[v],
    labelCut: REGIME_LABEL_CUT[v],
    lookback: REGIME_LOOKBACK[v],
    adoptionDate: adoptionDate(v),
    // Stated only where a version departs from v3 and v4, so their presets keep the shape they had.
    ...(REGIME_COMPOSITE_NORMALISATION[v] === "none" ? {} : { compositeNormalisation: REGIME_COMPOSITE_NORMALISATION[v] }),
    ...(REGIME_KEPT_HISTORY[v] ? { keptHistory: true } : {}),
  });

/** The named presets: the rules of each methodology version, built from the per-version tables. */
export const REGIME_RULES: Readonly<Record<RegimeVersion, RegimeRules>> = Object.freeze({ v3: rulesOfVersion("v3"), v4: rulesOfVersion("v4"), v5: rulesOfVersion("v5") });

/**
 * The rules in force: `rules` when given (checked, a RangeError names a bad
 * field), else the preset of `version` (default the current version).
 */
export function regimeRulesOf(version: RegimeVersion = CURRENT_REGIME_VERSION, rules?: RegimeRules): RegimeRules {
  if (rules === undefined) return REGIME_RULES[version];
  if (rules === null || typeof rules !== "object") throw new RangeError("rules must be a RegimeRules object");
  if (typeof rules.knowledgeTime !== "boolean") throw new RangeError(`rules.knowledgeTime must be a boolean, got ${JSON.stringify(rules.knowledgeTime)}`);
  if (typeof rules.observationWindows !== "boolean") throw new RangeError(`rules.observationWindows must be a boolean, got ${JSON.stringify(rules.observationWindows)}`);
  if (rules.missingPanel !== "rebase" && rules.missingPanel !== "nan") throw new RangeError(`rules.missingPanel must be "rebase" or "nan", got ${JSON.stringify(rules.missingPanel)}`);
  if (rules.labelCut !== "series" && rules.labelCut !== "percentile") throw new RangeError(`rules.labelCut must be "series" or "percentile", got ${JSON.stringify(rules.labelCut)}`);
  const r = rules.weightRefresh;
  if (r === null || typeof r !== "object" || !Number.isInteger(r.intervalDays) || r.intervalDays <= 0 || typeof r.anchor !== "string" || typeof r.refitOnLastDay !== "boolean") {
    throw new RangeError(`rules.weightRefresh must be { intervalDays, anchor, refitOnLastDay }, got ${JSON.stringify(r)}`);
  }
  if (rules.lookback === null || typeof rules.lookback !== "object") throw new RangeError("rules.lookback is missing");
  if (typeof rules.adoptionDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rules.adoptionDate)) throw new RangeError(`rules.adoptionDate must be a YYYY-MM-DD date, got ${JSON.stringify(rules.adoptionDate)}`);
  const cn = rules.compositeNormalisation;
  if (cn !== undefined && cn !== "none" && cn !== "percentile") throw new RangeError(`rules.compositeNormalisation must be "none" or "percentile", got ${JSON.stringify(cn)}`);
  if (rules.keptHistory !== undefined && typeof rules.keptHistory !== "boolean") throw new RangeError(`rules.keptHistory must be a boolean, got ${JSON.stringify(rules.keptHistory)}`);
  return rules;
}

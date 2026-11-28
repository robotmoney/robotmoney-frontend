import { ALL_PANELS, PANELS, type Indicator, type Panel, type PanelMembership } from "./indicators.ts";
import type { DerivedSeries } from "../transform/derived.ts";
import {
  CURRENT_REGIME_VERSION, PRESETS, REGIME_VERSIONS, type CompositeNormalisation, type LabelCut, type MissingPanelRule, type ModelFacts, type RegimeLookback, type RegimeRules,
  type RegimeVersion, type WeightRefresh,
} from "../model/presets.ts";

// The methodology versions and their per-version tables. Since issue 1765 a
// version's facts are one preset object (model/presets.ts, where each version
// is described), and every model table below is a view of the presets: one
// value per version, read from its preset by identity. The names stay exported
// so no import breaks. REGIME_LINE, REGIME_ARTIFACT_KIND and
// REGIME_PUBLISHED_PANELS are platform tables, not model properties, and are
// stated here.
export {
  REGIME_VERSIONS, CURRENT_REGIME_VERSION, WEIGHT_REFRESH_ANCHOR,
  type RegimeVersion, type LookbackWindow, type RegimeLookback, type WeightRefresh, type MissingPanelRule, type CompositeNormalisation, type LabelCut,
  type RegimeRules,
} from "../model/presets.ts";

// A per-version table read from the presets, in tag order.
const view = <T>(field: (preset: ModelFacts) => T): Readonly<Record<RegimeVersion, T>> =>
  Object.freeze(Object.fromEntries(REGIME_VERSIONS.map((v) => [v, field(PRESETS[v])])) as Record<RegimeVersion, T>);

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

/** The scoring registry of each methodology version (issue 1753). v3 and v4 read INDICATORS itself. */
export const REGIME_REGISTRY: Readonly<Record<RegimeVersion, readonly Indicator[]>> = view((m) => m.registry);

/** The derived series each methodology version computes from raw inputs (none for v3 and v4). */
export const REGIME_DERIVED_SERIES: Readonly<Record<RegimeVersion, readonly DerivedSeries[]>> = view((m) => m.derived);

/** True for a methodology version this engine can compute (and so replay). */
export function isRegimeVersion(v: unknown): v is RegimeVersion {
  return typeof v === "string" && (REGIME_VERSIONS as readonly string[]).includes(v);
}

/** The declared lookback of every methodology version (issue 1659). */
export const REGIME_LOOKBACK: Readonly<Record<RegimeVersion, RegimeLookback>> = view((m) => m.rules.lookback);

/** The panel weight refresh rule of every methodology version (issue 1739; WeightRefresh). */
export const REGIME_WEIGHT_REFRESH: Readonly<Record<RegimeVersion, WeightRefresh>> = view((m) => m.rules.weightRefresh);

/**
 * Whether a version reads its inputs by knowledge time (issue 1733,
 * docs/technical/regime-engine.md section 8.1.2): each value from the day it was
 * published, at the version known then. v4 is corrected in place; v3 keeps
 * reading by period date, so its published runs replay byte for byte.
 */
// v5 reads the registry's own series by period date; only its derived series
// are lagged, on their DerivedSeries declarations (issue 1753).
export const REGIME_KNOWLEDGE_TIME: Readonly<Record<RegimeVersion, boolean>> = view((m) => m.rules.knowledgeTime);

/**
 * Whether a version counts observation days (issue 1741, decision D93): an
 * `exchange` series is transformed, ranked and correlated over its own real
 * observations, each counted once, and the result is placed on the calendar
 * axis. v3 keeps the forward-filled rows in every window.
 */
export const REGIME_OBSERVATION_WINDOWS: Readonly<Record<RegimeVersion, boolean>> = view((m) => m.rules.observationWindows);

/** The composite rule of every version when an included panel has no index on a day (issue 1741; MissingPanelRule). */
export const REGIME_MISSING_PANEL: Readonly<Record<RegimeVersion, MissingPanelRule>> = view((m) => m.rules.missingPanel);

/** How every version normalises its composite (issue 1753; CompositeNormalisation). A preset that states none reads "none". */
export const REGIME_COMPOSITE_NORMALISATION: Readonly<Record<RegimeVersion, CompositeNormalisation>> = view((m) => m.rules.compositeNormalisation ?? "none");

/**
 * Whether a version keeps its history (issue 1753): its preset's `history` is
 * "kept". false: every run recomputes every day from its own inputs (v3, v4).
 * true: a day is computed once, on the day, and kept; a later run computes only
 * its own day and derives the composite and the labels from the kept days
 * (analyze/kept-regime.ts).
 */
export const REGIME_KEPT_HISTORY: Readonly<Record<RegimeVersion, boolean>> = view((m) => m.history === "kept");

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
 * that data), after it out-of-sample. v5's is the day the model was chosen, not
 * its backtest split (REGIME_BACKTEST_RULES.v5).
 */
export const REGIME_ADOPTION_DATE: Readonly<Record<string, string>> = view((m) => m.rules.adoptionDate);

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

/** What every version cuts its labels on (issue 1751; LabelCut). */
export const REGIME_LABEL_CUT: Readonly<Record<RegimeVersion, LabelCut>> = view((m) => m.rules.labelCut);

/**
 * The named presets: the rules of each methodology version (issue 1751), its
 * preset's own rules object. v3 and v4 state no compositeNormalisation and no
 * keptHistory, so their rules keep the shape they had.
 */
export const REGIME_RULES: Readonly<Record<RegimeVersion, RegimeRules>> = view((m) => m.rules);

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

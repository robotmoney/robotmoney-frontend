// The kept record of a methodology that keeps its history (issue 1753, decision
// D96; REGIME_KEPT_HISTORY). Pure: no fs, env, db or network.
//
// A kept day is computed once, on the day, from the inputs known that day, and
// never changes. It is its date, its panel indices and its signed scores. A
// first run walks forward from its own inputs; a later run computes only its
// own day. The kept days are laid on one daily axis (a day with no kept figure
// is a gap) and the composite mean, the composite and every label are derived
// from them in date order. All of it is causal, so a day computed alone equals
// the same day inside a longer walk, and a day published late does not change
// a row already published.
//
// Since issue 1765 the kept record is a driver of the regime engine
// (src/engine/history.ts, keptHistory) over the same stages as the daily
// recompute: the score (engine/score.ts), the day's weights and panel index
// (engine/fit.ts, engine/combine.ts), the composite and the labels
// (engine/combine.ts). This module keeps the kept record's own rules (the
// settings below), its option defaults and its public names: the kept-day
// layout (deriveKeptRecord), the one-day path (fitDay, keptDayOf, walkForward)
// and computeKeptRegime. None of it ranks, fits or combines on its own.
import type { RawIndicatorHistory } from "../types.ts";
import type { DerivedSeries } from "../transform/derived.ts";
import { publishedRows } from "../replay/rows.ts";
import type { RegimeSnapshotRow } from "../report/canonical.ts";
import { ALL_PANELS, PANELS, type Indicator, type Panel } from "./indicators.ts";
import { REGIME_DERIVED_SERIES, REGIME_KEPT_HISTORY, REGIME_REGISTRY, REGIME_RULES, REGIME_VERSIONS, regimeRulesOf, type RegimeRules, type RegimeVersion } from "./regime-versions.ts";
import { prepareModel, withDerivedSeries as deriveInputs } from "../engine/prepare.ts";
import {
  assertKeptRules, keptDay, keptFits, keptHistory, keptRecord, keptScores,
  type DayFit, type DayScores, type KeptDay, type KeptRecord, type KeptRegimeRun,
} from "../engine/history.ts";

export type { DayFit, DayScores, KeptDay, KeptRecord, KeptRegimeRun } from "../engine/history.ts";

export interface KeptOptions {
  /** The methodology version (default the first published version that keeps its history, v5). */
  version?: RegimeVersion;
  /** Every engine rule; default the preset of `version`. */
  rules?: RegimeRules;
  /** The scoring registry; default REGIME_REGISTRY of `version`. */
  indicators?: readonly Indicator[];
  /** Every panel computed and published; default ALL_PANELS. */
  panels?: readonly Panel[];
  /** The panels the composite averages; default PANELS. */
  included?: readonly Panel[];
}

// The first preset whose history is kept: the version these functions default to.
const KEPT_VERSION: RegimeVersion = (() => {
  const v = REGIME_VERSIONS.find((x) => REGIME_KEPT_HISTORY[x]);
  if (v === undefined) throw new RangeError("no published version keeps its history (REGIME_KEPT_HISTORY)");
  return v;
})();

function settings(opts: KeptOptions) {
  const version = opts.version ?? KEPT_VERSION;
  const rules = opts.rules ?? REGIME_RULES[version];
  regimeRulesOf(version, rules);
  assertKeptRules(rules);
  return { version, rules, indicators: opts.indicators ?? REGIME_REGISTRY[version], panels: opts.panels ?? ALL_PANELS, included: opts.included ?? PANELS };
}

/**
 * `raw` cut at `asof`, plus each derived series computed from its raw inputs as
 * known on `asof` and dated by its publication rule, so the day reads no
 * derived value dated after it. A declaration whose input is absent gives an
 * empty series: its indicator is missing under its fill policy.
 */
export function withDerivedSeries(raw: RawIndicatorHistory, asof: string, derived: readonly DerivedSeries[] = REGIME_DERIVED_SERIES[KEPT_VERSION]): RawIndicatorHistory {
  return deriveInputs(raw, asof, derived);
}

/**
 * Score every indicator on every day of prepared inputs: the mid-rank of its
 * value within its trailing rank window, each calendar day counted once
 * including a carried day, aligned by sign. A rank reads only the window ending
 * on its own day, so day d's scores are the same whether the inputs end on d
 * or later.
 */
export function scoreDays(transformed: Record<string, number[]>, dateAxis: string[], opts: KeptOptions = {}): DayScores {
  return keptScores(transformed, dateAxis, settings(opts));
}

/** Day `k` of a scored run: each panel's weights, fit on day k from the scores of the weight window ending on k, and its index. */
export function fitDay(scores: DayScores, k: number, opts: KeptOptions = {}): DayFit {
  return keptFits(scores, [k], settings(opts))[0]!;
}

/** Day `k` of a scored run as that day computed it. `fit` is fitDay(scores, k), when the caller already has it. */
export function keptDayOf(scores: DayScores, k: number, opts: KeptOptions = {}, fit: DayFit = fitDay(scores, k, opts)): KeptDay {
  return keptDay(scores, k, fit);
}

/**
 * The kept day of every day before axis index `end`, from one run's scores:
 * day d is fit on d from the scores up to d. Preparation and ranking read only
 * earlier values, so these are the figures a run as of d computes from this
 * input.
 */
export function walkForward(scores: DayScores, end: number, opts: KeptOptions = {}): KeptDay[] {
  const days = Array.from({ length: Math.max(0, end) }, (_, k) => k);
  const fits = keptFits(scores, days, settings(opts));
  return days.map((k, j) => keptDay(scores, k, fits[j]!));
}

/**
 * Lay the kept days on `dateAxis` (a day with none is a gap) and derive, in
 * date order, the composite mean, the composite (its mid-rank within every
 * kept mean up to the day, under composite normalisation "percentile") and the
 * labels: the composite label cut on the composite, each panel label on its
 * panel index, both smoothed by smoothRegimes.
 */
export function deriveKeptRecord(dateAxis: string[], days: readonly KeptDay[], opts: KeptOptions = {}): KeptRecord {
  return keptRecord(dateAxis, days, settings(opts));
}

/**
 * One run as of `asof`. `raw` is the run's input history under the ids the
 * computation reads (the registry ids and the raw inputs of the derived
 * series). It is cut at `asof`, the derived series are computed, and every
 * indicator is placed on the daily axis from `start`, carried forward and
 * transformed (prepareRegimeInputs under the version's rules and registry).
 *
 * `kept` holds the kept days before `asof` (later ones are refused). With none,
 * this is a first run: it computes every day from `start` to the day before
 * `asof` one by one from its own input, then `asof`. Otherwise it computes only
 * `asof`, and derives that day's composite and labels from the kept days plus
 * its own.
 */
export function computeKeptRegime(
  raw: RawIndicatorHistory,
  opts: KeptOptions & { asof: string; start: string; derived?: readonly DerivedSeries[]; kept?: readonly KeptDay[] },
): KeptRegimeRun {
  const s = settings(opts);
  const kept = opts.kept ?? [];
  for (const d of kept) if (!(d.date < opts.asof)) throw new RangeError(`kept day ${d.date} is not before the as-of day ${opts.asof}`);
  const prepared = prepareModel(raw, { registry: s.indicators, derived: opts.derived ?? REGIME_DERIVED_SERIES[s.version], rules: s.rules }, { start: opts.start, asof: opts.asof });
  return keptHistory(prepared, { ...s, kept });
}

/**
 * The rows a run publishes, in the stored row shape: one for every day it
 * computed that has a composite mean. `composite` and `regime` are null before
 * the record holds enough means, so a later run can rebuild the record from the
 * rows; a reader serves only the rows that have a label. No trailing percentile
 * exists, so every percentile field is null. The as-of row also carries the
 * indicator details, the panel weights with their fit date (the as-of day), the
 * panels, the correlations and the backtest. The rows are built by the one row
 * builder, publishedRows (src/replay/rows.ts, issue 1765).
 */
export function keptRegimeRows(
  run: KeptRegimeRun,
  asofRow: { source?: string | null; backtest?: unknown | null; correlations?: unknown | null },
  opts: KeptOptions = {},
): RegimeSnapshotRow[] {
  const { indicators, panels } = settings({ ...opts, version: opts.version ?? run.version });
  return publishedRows(run, { source: asofRow.source ?? null, backtest: asofRow.backtest ?? null, correlations: asofRow.correlations ?? null, indicators, panels });
}

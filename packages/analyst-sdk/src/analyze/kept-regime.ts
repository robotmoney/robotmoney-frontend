// The kept record of a methodology that keeps its history (issue 1753, decision
// D96; REGIME_KEPT_HISTORY). Pure: no fs, env, db or network.
//
// A kept day is computed once, on the day, from the inputs known that day, and
// never changes. It is its date, its panel indices and its signed scores. This
// module scores a day, walks a first run forward from its own inputs, lays the
// kept days on one daily axis (a day with no kept figure is a gap) and derives,
// in date order, the composite mean, the composite and every label. All of it
// is causal, so a day computed alone equals the same day inside a longer walk,
// and a day published late does not change a row already published.
//
// Every step is one SDK function, read by import: deriveSeries (the derived
// inputs), prepareRegimeInputs (the daily axis, the carry-forward and the
// transform), rollingPercentileRank (the score and the composite),
// fitPanelWeights and weightedMeanOnDay (the day's weights and panel index),
// panelMean (the composite mean) and smoothRegimes (the labels).
import type { Point, RawIndicatorHistory } from "../types.ts";
import { deriveSeries, derivedInputIds, type DerivedSeries } from "../transform/derived.ts";
import { rollingPercentileRank } from "../transform/math.ts";
import { cutAtAsof, prepareRegimeInputs, type PreparedRegimeInputs } from "../prepare.ts";
import { buildRichIndicators } from "../report/indicator-rows.ts";
import type { RegimeSnapshotRow } from "../report/canonical.ts";
import { bucketFn, fitPanelWeights, lookbackDays, panelMean, smoothRegimes, weightedMeanOnDay } from "./compute.ts";
import { ALL_PANELS, PANELS, type Indicator, type Panel } from "./indicators.ts";
import { REGIME_DERIVED_SERIES, REGIME_REGISTRY, REGIME_RULES, regimeRulesOf, type RegimeRules, type RegimeVersion } from "./regime-versions.ts";

/** One day's figures as that day computed them. */
export interface KeptDay {
  date: string;
  /** Each computed panel's index; NaN (or absent) when the panel had none that day. */
  panelIndices: Record<string, number>;
  /** Each indicator's sign-aligned score. Absent on a kept day read back from a published line. */
  signed?: Record<string, number>;
}

/** One run's scores on its daily axis: each indicator's rank within its own trailing window, on every day. */
export interface DayScores {
  dateAxis: string[];
  ranks: Record<string, number[]>;
  /** The rank aligned by the indicator's sign, so 1 is the most risk-on. */
  signed: Record<string, number[]>;
}

/** One day's weights and panel indices, fit on that day. */
export interface DayFit {
  weightsByPanel: Record<string, Record<string, number>>;
  panelIndices: Record<string, number>;
}

/** The kept days on one daily axis, and what is derived from them. */
export interface KeptRecord {
  dateAxis: string[];
  /** Whether the day has a kept figure. */
  kept: boolean[];
  panelIndices: Record<string, number[]>;
  /** m(t): the equal-weight mean of the included panel indices present that day. */
  compositeMean: number[];
  /** c(t): the composite the methodology publishes. */
  composite: number[];
  regime: (string | null)[];
  panelRegimes: Record<string, (string | null)[]>;
}

export interface KeptOptions {
  /** The methodology version (default v5, the one version that keeps its history). */
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

const KEPT_VERSION: RegimeVersion = "v5";

function settings(opts: KeptOptions) {
  const version = opts.version ?? KEPT_VERSION;
  const rules = opts.rules ?? REGIME_RULES[version];
  regimeRulesOf(version, rules);
  if (rules.observationWindows) throw new RangeError("the kept record counts calendar days: rules.observationWindows must be false");
  if (rules.labelCut !== "series") throw new RangeError('the kept record cuts each label on its series: rules.labelCut must be "series"');
  // fitDay fits every day, so another refit calendar would be silently ignored (issue 1765).
  if (rules.weightRefresh.intervalDays !== 1) {
    throw new RangeError(`the kept record refits its weights every day: rules.weightRefresh.intervalDays must be 1, got ${JSON.stringify(rules.weightRefresh.intervalDays)}`);
  }
  return { version, rules, indicators: opts.indicators ?? REGIME_REGISTRY[version], panels: opts.panels ?? ALL_PANELS, included: opts.included ?? PANELS };
}

/**
 * `raw` cut at `asof`, plus each derived series computed from its raw inputs as
 * known on `asof` and dated by its publication rule, so the day reads no
 * derived value dated after it. A declaration whose input is absent gives an
 * empty series: its indicator is missing under its fill policy.
 */
export function withDerivedSeries(raw: RawIndicatorHistory, asof: string, derived: readonly DerivedSeries[] = REGIME_DERIVED_SERIES[KEPT_VERSION]): RawIndicatorHistory {
  const out: RawIndicatorHistory = {};
  for (const id in raw) out[id] = cutAtAsof(raw[id]!, asof);
  for (const d of derived) {
    if (Object.hasOwn(raw, d.id)) throw new RangeError(`derived series ${d.id} is already an input of the run: it is computed from its raw inputs, never read as stored`);
  }
  for (const d of derived) {
    const inputs: Record<string, Point[]> = {};
    let complete = true;
    for (const id of derivedInputIds(d)) {
      if (!Object.hasOwn(raw, id)) complete = false;
      else inputs[id] = out[id]!;
    }
    out[d.id] = complete ? cutAtAsof(deriveSeries(d, inputs), asof) : [];
  }
  return out;
}

/**
 * Score every indicator on every day of prepared inputs: the mid-rank of its
 * value within its trailing rank window, each calendar day counted once
 * including a carried day, aligned by sign. A rank reads only the window ending
 * on its own day, so day d's scores are the same whether the inputs end on d
 * or later.
 */
export function scoreDays(transformed: Record<string, number[]>, dateAxis: string[], opts: KeptOptions = {}): DayScores {
  const { rules, indicators } = settings(opts);
  const window = lookbackDays(rules.lookback, "rank");
  const ranks: Record<string, number[]> = {};
  const signed: Record<string, number[]> = {};
  for (const ind of indicators) {
    const values = transformed[ind.id];
    if (!values) throw new Error(`Missing series for ${ind.id}`);
    const r = rollingPercentileRank(values, window);
    ranks[ind.id] = r;
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }
  return { dateAxis, ranks, signed };
}

/** Day `k` of a scored run: each panel's weights, fit on day k from the scores of the weight window ending on k, and its index. */
export function fitDay(scores: DayScores, k: number, opts: KeptOptions = {}): DayFit {
  const { rules, indicators, panels } = settings(opts);
  const weightsByPanel: Record<string, Record<string, number>> = {};
  const panelIndices: Record<string, number> = {};
  for (const p of panels) {
    const inds = indicators.filter((ind) => ind.panel === p);
    const weights = fitPanelWeights(scores.signed, inds, k, { rules });
    weightsByPanel[p] = weights;
    panelIndices[p] = weightedMeanOnDay(scores.signed, weights, inds, k);
  }
  return { weightsByPanel, panelIndices };
}

/** Day `k` of a scored run as that day computed it. `fit` is fitDay(scores, k), when the caller already has it. */
export function keptDayOf(scores: DayScores, k: number, opts: KeptOptions = {}, fit: DayFit = fitDay(scores, k, opts)): KeptDay {
  const signed: Record<string, number> = {};
  for (const id of Object.keys(scores.signed)) signed[id] = scores.signed[id]![k]!;
  return { date: scores.dateAxis[k]!, panelIndices: fit.panelIndices, signed };
}

/**
 * The kept day of every day before axis index `end`, from one run's scores:
 * day d is fit on d from the scores up to d. Preparation and ranking read only
 * earlier values, so these are the figures a run as of d computes from this
 * input.
 */
export function walkForward(scores: DayScores, end: number, opts: KeptOptions = {}): KeptDay[] {
  const out: KeptDay[] = [];
  for (let k = 0; k < end; k++) out.push(keptDayOf(scores, k, opts));
  return out;
}

/**
 * Lay the kept days on `dateAxis` (a day with none is a gap) and derive, in
 * date order, the composite mean, the composite (its mid-rank within every
 * kept mean up to the day, under composite normalisation "percentile") and the
 * labels: the composite label cut on the composite, each panel label on its
 * panel index, both smoothed by smoothRegimes.
 */
export function deriveKeptRecord(dateAxis: string[], days: readonly KeptDay[], opts: KeptOptions = {}): KeptRecord {
  const { rules, panels, included } = settings(opts);
  const at = new Map(dateAxis.map((d, i) => [d, i]));
  const kept = new Array<boolean>(dateAxis.length).fill(false);
  const panelIndices: Record<string, number[]> = {};
  for (const p of panels) panelIndices[p] = new Array<number>(dateAxis.length).fill(NaN);
  for (const day of days) {
    const i = at.get(day.date);
    if (i === undefined) throw new RangeError(`kept day ${day.date} is not on the axis ${dateAxis[0]}..${dateAxis[dateAxis.length - 1]}`);
    if (kept[i]) throw new RangeError(`kept day ${day.date} is given twice: a kept day never changes`);
    kept[i] = true;
    for (const p of panels) {
      const v = day.panelIndices[p];
      panelIndices[p]![i] = typeof v === "number" && Number.isFinite(v) ? v : NaN;
    }
  }
  const compositeMean = dateAxis.map((_, i) => panelMean(included.map((p) => panelIndices[p]![i]!), rules.missingPanel));
  const composite = rules.compositeNormalisation === "percentile" ? rollingPercentileRank(compositeMean, lookbackDays(rules.lookback, "percentile")) : compositeMean;
  const panelRegimes: Record<string, (string | null)[]> = {};
  for (const p of panels) panelRegimes[p] = smoothRegimes(panelIndices[p]!, bucketFn);
  return { dateAxis, kept, panelIndices, compositeMean, composite, regime: smoothRegimes(composite, bucketFn), panelRegimes };
}

/** One run of a kept-history methodology. */
export interface KeptRegimeRun {
  version: RegimeVersion;
  dateAxis: string[];
  prepared: PreparedRegimeInputs;
  scores: DayScores;
  /** The as-of day's fit: its weights, fit on the as-of day, and its panel indices. */
  fit: DayFit;
  /** The days this run computed, in date order: the walk-forward days of a first run, then its own as-of day. */
  computed: KeptDay[];
  /** The kept record on the run's axis: the kept days before the as-of day, then `computed`. */
  record: KeptRecord;
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
  const { version, rules, indicators } = settings(opts);
  const kept = opts.kept ?? [];
  for (const d of kept) if (!(d.date < opts.asof)) throw new RangeError(`kept day ${d.date} is not before the as-of day ${opts.asof}`);
  const input = withDerivedSeries(raw, opts.asof, opts.derived ?? REGIME_DERIVED_SERIES[version]);
  const prepared = prepareRegimeInputs(input, { start: opts.start, asof: opts.asof, indicators, rules });
  const { dateAxis } = prepared;
  const last = dateAxis.length - 1;
  const scores = scoreDays(prepared.transformed, dateAxis, opts);
  const fit = fitDay(scores, last, opts);
  const computed = kept.length === 0 ? walkForward(scores, last, opts) : [];
  computed.push(keptDayOf(scores, last, opts, fit));
  // A kept day before the axis start is outside this run's record.
  const onAxis = kept.filter((d) => d.date >= dateAxis[0]!);
  return { version, dateAxis, prepared, scores, fit, computed, record: deriveKeptRecord(dateAxis, [...onAxis, ...computed], opts) };
}

const nn = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The rows a run publishes, in the stored row shape: one for every day it
 * computed that has a composite mean. `composite` and `regime` are null before
 * the record holds enough means, so a later run can rebuild the record from the
 * rows; a reader serves only the rows that have a label. No trailing percentile
 * exists, so every percentile field is null. The as-of row also carries the
 * indicator details, the panel weights with their fit date (the as-of day), the
 * panels, the correlations and the backtest.
 */
export function keptRegimeRows(
  run: KeptRegimeRun,
  asofRow: { source?: string | null; backtest?: unknown | null; correlations?: unknown | null },
  opts: KeptOptions = {},
): RegimeSnapshotRow[] {
  const { indicators, panels } = settings({ ...opts, version: opts.version ?? run.version });
  const { record, dateAxis, scores, prepared } = run;
  const at = new Map(dateAxis.map((d, i) => [d, i]));
  const lastIdx = dateAxis.length - 1;
  const rows: RegimeSnapshotRow[] = [];
  for (const day of run.computed) {
    const i = at.get(day.date)!;
    if (!Number.isFinite(record.compositeMean[i])) continue;
    const isAsof = i === lastIdx;
    const percentiles: Record<string, number> = {};
    for (const ind of indicators) {
      const s = day.signed?.[ind.id];
      if (typeof s === "number" && Number.isFinite(s)) percentiles[ind.id] = Number(s.toFixed(6));
    }
    const asofScores = { ranks: scores.ranks, signed: scores.signed, weightsByPanel: run.fit.weightsByPanel };
    rows.push({
      date: day.date,
      composite: nn(record.composite[i]),
      compositePercentile: null,
      regime: record.regime[i] ?? null,
      macroRegime: record.panelRegimes.macro?.[i] ?? null,
      onchainRegime: record.panelRegimes.onchain?.[i] ?? null,
      factorRegime: record.panelRegimes.factor?.[i] ?? null,
      macroIndex: nn(record.panelIndices.macro?.[i]),
      onchainIndex: nn(record.panelIndices.onchain?.[i]),
      factorIndex: nn(record.panelIndices.factor?.[i]),
      macroPercentile: null,
      onchainPercentile: null,
      factorPercentile: null,
      panelWeights: isAsof ? { ...Object.fromEntries(panels.map((p) => [p, run.fit.weightsByPanel[p]!])), weightFitDate: day.date } : null,
      version: run.version,
      source: asofRow.source ?? null,
      percentiles,
      indicators: isAsof ? buildRichIndicators(i, asofScores, asofScores, prepared.transformed, prepared.lastRaw, dateAxis, prepared.ages, indicators) : [],
      panels: isAsof ? [...panels] : null,
      backtest: isAsof ? (asofRow.backtest ?? null) : null,
      correlations: isAsof ? (asofRow.correlations ?? null) : null,
    });
  }
  return rows;
}

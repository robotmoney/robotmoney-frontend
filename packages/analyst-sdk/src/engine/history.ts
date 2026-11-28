// The history drivers of the regime engine (issue 1765, phase 2; proposal
// section 6.3). Pure: no fs, env, db or network.
//
// A driver runs the stages (score.ts, fit.ts, combine.ts) over one prepared
// axis. It adds no computation step of its own.
//
//   recompute  every day on the axis: score every registry indicator once (with
//              the forward-fill ages mask), fit the refresh calendar of the
//              rules once over every panel of every panel set, then combine once
//              per panel set (v3, v4). computeRegime is this driver over one set.
//   kept       the D96 kept record (v5, issue 1753): score without ages, fit
//              each day the run computes on that day (every day of a first run;
//              only the as-of day of a run given kept days), lay the kept days
//              and the computed ones on the axis, and derive the composite and
//              the labels from them in date order. computeKeptRegime
//              (analyze/kept-regime.ts) is this driver.
//
// Both drivers read every rule from the rules they are given, never from a
// version tag. A driver takes an optional `memo`: runModel passes its stage
// cache through it (engine/cache.ts). Every value a memo returns may be shared
// with an earlier run, so no caller may write to a result's arrays or objects.
import type { Indicator, Panel } from "../analyze/indicators.ts";
import type { RegimeRules, RegimeVersion } from "../analyze/regime-versions.ts";
import type { PreparedRegimeInputs } from "../prepare.ts";
import { combinePanels, panelIndexSeries, weightedMeanOnDay } from "./combine.ts";
import { fitInForce, fitPanels, panelIndicators, refitDays, type PanelFit } from "./fit.ts";
import { engineWindows, scoreIndicators, type StageScores } from "./score.ts";
import { MAX_FORWARD_FILL_DAYS } from "../transform/math.ts";

export interface RegimeComputeResult {
  dateAxis: string[];
  panels: Panel[];
  ranks: Record<string, number[]>;
  signed: Record<string, number[]>;
  weightsByPanel: Record<string, Record<string, number>>;
  panelIndices: Record<string, number[]>;
  panelPercentiles: Record<string, number[]>;
  panelRegimes: Record<string, (string | null)[]>;
  composite: number[];
  compositePercentile: number[];
  regime: (string | null)[];
  /** The fit date of `weightsByPanel` (issue 1739): the refresh date those weights came from. */
  weightFitDate: string | null;
  /** Every fit of the run, only when the caller passes `recordWeightFits`. */
  weightFits?: { date: string; weights: Record<string, Record<string, number>> }[];
  /** The mean of the panel indices, only under composite normalisation "percentile" (issue 1753): `composite` is its rank. */
  compositeMean?: number[];
  // Legacy convenience fields, populated when the panel was computed.
  macroIndex?: number[];
  macroPercentile?: number[];
  macroRegime?: (string | null)[];
  onchainIndex?: number[];
  onchainPercentile?: number[];
  onchainRegime?: (string | null)[];
  factorIndex?: number[];
  factorPercentile?: number[];
  factorRegime?: (string | null)[];
}

/** A stage of the engine, as the stage cache counts it. */
export type StageName = "prepare" | "score" | "fit" | "combine";

/**
 * How a driver runs a stage: `compute` gives the value; `params` names what it
 * is computed from (read only by a cache). The default runs `compute`.
 */
export type StageMemo = <T>(stage: StageName, params: () => object, compute: () => T) => T;

const direct: StageMemo = (_stage, _params, compute) => compute();

// The params of each stage name what its value is computed from: the cache key
// of the value (engine/cache.ts). They are built only when a cache asks, so a
// run without one reads nothing a stage does not (a calendar is read as
// declared, never checked here).
//
// The score stage's params name its driver: the recompute driver stores
// StageScores and the kept driver DayScores (the scores with their axis). A
// recompute run without ages and a kept run over one input and one registry
// would otherwise share a key, and one driver would read the other's value.
const scoreParams = (driver: "recompute" | "kept", indicators: readonly Indicator[], rules: RegimeRules, ages: boolean, cap: number) => ({
  driver,
  registry: indicators.map((i) => ({ id: i.id, sign: i.sign, calendar: i.calendar ?? null })),
  rank: rules.lookback.rank,
  observationWindows: rules.observationWindows,
  ages,
  cap,
});

// What the fit stage reads besides the scores.
const fitParams = (score: () => object, indicators: readonly Indicator[], rules: RegimeRules, panels: readonly Panel[], days: string) => ({
  score: score(),
  weight: rules.lookback.weight,
  weightRefresh: rules.weightRefresh,
  observationWindows: rules.observationWindows,
  panelOf: indicators.map((i) => [i.id, i.panel]),
  panels,
  days,
});

// ── recompute ────────────────────────────────────────────────────────────────

export interface RecomputeInputs {
  dateAxis: string[];
  /** Post-transform values per indicator id (prepareRegimeInputs `transformed`). */
  transformed: Record<string, number[]>;
  /** Forward-fill ages; a day older than `maxForwardFillDays` is missing before the rank. Without them no day is masked. */
  ages?: Record<string, number[]>;
  /** prepareRegimeInputs `carried`, read only under rules that count observation days. */
  carried?: Record<string, boolean[]>;
}

export interface RecomputeOptions {
  rules: RegimeRules;
  indicators: readonly Indicator[];
  /** The panel sets to combine, each in its own order; each result's `panels` is the list given. Every panel of every set is fit once. */
  panelSets: readonly Panel[][];
  maxForwardFillDays?: number;
  /** List every weight fit of the run in each result's `weightFits`. */
  recordWeightFits?: boolean;
  memo?: StageMemo;
}

/**
 * The recompute driver: one RegimeComputeResult per panel set, in the order
 * given. Each result has exactly the keys a run over that set alone has: its
 * weights, panel maps and legacy fields name only its own panels, and its
 * composite averages them in their order. The scores are computed once and
 * shared by every result.
 */
export function recomputeHistory(inputs: RecomputeInputs, opts: RecomputeOptions): RegimeComputeResult[] {
  const { rules, indicators } = opts;
  const memo = opts.memo ?? direct;
  const { dateAxis, transformed, ages, carried } = inputs;
  engineWindows(rules);
  const cap = opts.maxForwardFillDays ?? MAX_FORWARD_FILL_DAYS;
  const sp = () => scoreParams("recompute", indicators, rules, ages !== undefined, cap);
  const scores = memo("score", sp, () => scoreIndicators(transformed, indicators, { rules, ages, maxForwardFillDays: cap, carried }));
  // Every panel of every set, each once, in first-seen order.
  const fitted = [...new Set(opts.panelSets.flat())];
  const fp = () => fitParams(sp, indicators, rules, fitted, "calendar");
  const fits = memo("fit", fp, () => fitPanels(scores.signed, indicators, fitted, refitDays(dateAxis, rules.weightRefresh), { rules, carried }));
  return opts.panelSets.map((panels) =>
    memo(
      "combine",
      () => ({ fit: fp(), missingPanel: rules.missingPanel, compositeNormalisation: rules.compositeNormalisation ?? "none", labelCut: rules.labelCut, percentile: rules.lookback.percentile, panels, recordWeightFits: opts.recordWeightFits === true }),
      () => recomputedSet(dateAxis, scores, fits, panels, indicators, rules, opts.recordWeightFits === true),
    ),
  );
}

// One panel set of a recomputing run, from the shared scores and fits.
function recomputedSet(dateAxis: string[], scores: StageScores, fits: readonly PanelFit[], panels: Panel[], indicators: readonly Indicator[], rules: RegimeRules, recordWeightFits: boolean): RegimeComputeResult {
  const byPanel = panelIndicators(indicators, panels);
  const inForce = fitInForce(dateAxis.length, fits);
  const panelIndices: Record<string, number[]> = {};
  for (const p of panels) panelIndices[p] = panelIndexSeries(scores.signed, byPanel[p]!, dateAxis.length, (i) => fits[inForce[i]!]?.weights[p]);
  const last = fits.length > 0 ? fits[fits.length - 1]! : null;
  const weightsByPanel: Record<string, Record<string, number>> = {};
  for (const p of panels) weightsByPanel[p] = last ? last.weights[p]! : {};
  const c = combinePanels(panelIndices, dateAxis.length, { rules, panels, included: panels, percentiles: true });
  const out: RegimeComputeResult = {
    dateAxis,
    panels,
    ranks: scores.ranks,
    signed: scores.signed,
    weightsByPanel,
    panelIndices,
    panelPercentiles: c.panelPercentiles,
    panelRegimes: c.panelRegimes,
    composite: c.composite,
    compositePercentile: c.compositePercentile,
    regime: c.regime,
    weightFitDate: last ? dateAxis[last.day]! : null,
  };
  if (recordWeightFits) out.weightFits = fits.map((f) => ({ date: dateAxis[f.day]!, weights: Object.fromEntries(panels.map((p) => [p, { ...f.weights[p] }])) }));
  if (c.compositeMean) out.compositeMean = c.compositeMean;
  if (panels.includes("macro")) {
    out.macroIndex = panelIndices.macro;
    out.macroPercentile = c.panelPercentiles.macro;
    out.macroRegime = c.panelRegimes.macro;
  }
  if (panels.includes("onchain")) {
    out.onchainIndex = panelIndices.onchain;
    out.onchainPercentile = c.panelPercentiles.onchain;
    out.onchainRegime = c.panelRegimes.onchain;
  }
  if (panels.includes("factor")) {
    out.factorIndex = panelIndices.factor;
    out.factorPercentile = c.panelPercentiles.factor;
    out.factorRegime = c.panelRegimes.factor;
  }
  return out;
}

// ── kept ─────────────────────────────────────────────────────────────────────

/** One day's figures as that day computed them. */
export interface KeptDay {
  date: string;
  /** Each computed panel's index; NaN (or absent) when the panel had none that day. */
  panelIndices: Record<string, number>;
  /** Each indicator's sign-aligned score. Absent on a kept day read back from a published line. */
  signed?: Record<string, number>;
}

/** One run's scores on its daily axis: each indicator's rank within its own trailing window, on every day. */
export interface DayScores extends StageScores {
  dateAxis: string[];
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

/** What the kept driver reads besides the prepared inputs. */
export interface KeptSettings {
  rules: RegimeRules;
  indicators: readonly Indicator[];
  /** Every panel computed and published, in this order. */
  panels: readonly Panel[];
  /** The panels the composite averages, in this order. */
  included: readonly Panel[];
}

/**
 * The rules the kept record can run: calendar-day windows, labels cut on the
 * series and a daily refit (each day is fit on itself, so another calendar
 * would be silently ignored, issue 1765). A RangeError names the rule.
 */
export function assertKeptRules(rules: RegimeRules): void {
  if (rules.observationWindows) throw new RangeError("the kept record counts calendar days: rules.observationWindows must be false");
  if (rules.labelCut !== "series") throw new RangeError('the kept record cuts each label on its series: rules.labelCut must be "series"');
  if (rules.weightRefresh.intervalDays !== 1) {
    throw new RangeError(`the kept record refits its weights every day: rules.weightRefresh.intervalDays must be 1, got ${JSON.stringify(rules.weightRefresh.intervalDays)}`);
  }
}

/** The kept score stage: every indicator ranked within its trailing window, with no ages mask (a kept run never reads ages). */
export function keptScores(transformed: Record<string, number[]>, dateAxis: string[], s: Pick<KeptSettings, "rules" | "indicators">): DayScores {
  const { ranks, signed } = scoreIndicators(transformed, s.indicators, { rules: s.rules });
  return { dateAxis, ranks, signed };
}

/** The fits of `days` on themselves (the kept fit stage), each panel's index on its own day beside its weights. */
export function keptFits(scores: StageScores, days: readonly number[], s: Pick<KeptSettings, "rules" | "indicators" | "panels">): DayFit[] {
  const byPanel = panelIndicators(s.indicators, s.panels);
  return fitPanels(scores.signed, s.indicators, s.panels, days, { rules: s.rules }).map(({ day, weights }) => {
    const panelIndices: Record<string, number> = {};
    for (const p of s.panels) panelIndices[p] = weightedMeanOnDay(scores.signed, weights[p]!, byPanel[p]!, day);
    return { weightsByPanel: weights, panelIndices };
  });
}

/** Day `k` of a scored run as that day computed it, from its fit. */
export function keptDay(scores: DayScores, k: number, fit: DayFit): KeptDay {
  const signed: Record<string, number> = {};
  for (const id of Object.keys(scores.signed)) signed[id] = scores.signed[id]![k]!;
  return { date: scores.dateAxis[k]!, panelIndices: fit.panelIndices, signed };
}

/**
 * Lay the kept days on `dateAxis` (a day with none is a gap) and derive, in
 * date order, the composite mean, the composite (its mid-rank within every
 * kept mean up to the day, under composite normalisation "percentile") and the
 * labels: the composite label cut on the composite, each panel label on its
 * panel index, both smoothed by smoothRegimes. A day off the axis, or given
 * twice, is a RangeError.
 */
export function keptRecord(dateAxis: string[], days: readonly KeptDay[], s: Pick<KeptSettings, "rules" | "panels" | "included">): KeptRecord {
  const at = new Map(dateAxis.map((d, i) => [d, i]));
  const kept = new Array<boolean>(dateAxis.length).fill(false);
  const panelIndices: Record<string, number[]> = {};
  for (const p of s.panels) panelIndices[p] = new Array<number>(dateAxis.length).fill(NaN);
  for (const day of days) {
    const i = at.get(day.date);
    if (i === undefined) throw new RangeError(`kept day ${day.date} is not on the axis ${dateAxis[0]}..${dateAxis[dateAxis.length - 1]}`);
    if (kept[i]) throw new RangeError(`kept day ${day.date} is given twice: a kept day never changes`);
    kept[i] = true;
    for (const p of s.panels) {
      const v = day.panelIndices[p];
      panelIndices[p]![i] = typeof v === "number" && Number.isFinite(v) ? v : NaN;
    }
  }
  const c = combinePanels(panelIndices, dateAxis.length, { rules: s.rules, panels: s.panels, included: s.included, percentiles: false, withMean: true });
  return { dateAxis, kept, panelIndices, compositeMean: c.compositeMean!, composite: c.composite, regime: c.regime, panelRegimes: c.panelRegimes };
}

/**
 * The kept driver over one prepared axis ending on the as-of day. `kept` holds
 * the kept days before the as-of day (the caller checks they are). With none,
 * this is a first run: every day of the axis is fit on itself and computed.
 * Otherwise only the as-of day is, and the record is the kept days on the axis
 * plus that day.
 */
export function keptHistory(prepared: PreparedRegimeInputs, s: KeptSettings & { version: RegimeVersion; kept: readonly KeptDay[]; memo?: StageMemo }): KeptRegimeRun {
  assertKeptRules(s.rules);
  const memo = s.memo ?? direct;
  const { dateAxis } = prepared;
  const last = dateAxis.length - 1;
  const sp = () => scoreParams("kept", s.indicators, s.rules, false, MAX_FORWARD_FILL_DAYS);
  const scores = memo("score", sp, () => keptScores(prepared.transformed, dateAxis, s));
  const first = s.kept.length === 0;
  // A first run walks every day before the as-of day, then the as-of day.
  const days = first ? [...Array.from({ length: Math.max(0, last) }, (_, k) => k), last] : [last];
  const fits = memo("fit", () => fitParams(sp, s.indicators, s.rules, s.panels, first ? "every-day" : "as-of-day"), () => keptFits(scores, days, s));
  const computed = days.map((k, j) => keptDay(scores, k, fits[j]!));
  const fit = fits[fits.length - 1]!;
  // A kept day before the axis start is outside this run's record.
  const onAxis = s.kept.filter((d) => d.date >= dateAxis[0]!);
  return { version: s.version, dateAxis, prepared, scores, fit, computed, record: keptRecord(dateAxis, [...onAxis, ...computed], s) };
}

/**
 * A kept run in RegimeComputeResult's shape, over `panels` (a subset of the
 * panels it computed). The composite is the kept record's; no trailing
 * percentile exists, so those series are NaN.
 */
export function keptComputeResult(run: KeptRegimeRun, panels: Panel[]): RegimeComputeResult {
  const { record, scores, dateAxis } = run;
  const none = (): number[] => new Array(dateAxis.length).fill(NaN);
  const pick = <T>(by: Record<string, T>): Record<string, T> => Object.fromEntries(panels.map((p) => [p, by[p]!]));
  const out: RegimeComputeResult = {
    dateAxis,
    panels,
    ranks: scores.ranks,
    signed: scores.signed,
    weightsByPanel: pick(run.fit.weightsByPanel),
    panelIndices: pick(record.panelIndices),
    panelPercentiles: Object.fromEntries(panels.map((p) => [p, none()])),
    panelRegimes: pick(record.panelRegimes),
    composite: record.composite,
    compositePercentile: none(),
    regime: record.regime,
    weightFitDate: dateAxis[dateAxis.length - 1] ?? null,
    compositeMean: record.compositeMean,
  };
  for (const p of panels) {
    out[`${p}Index`] = out.panelIndices[p];
    out[`${p}Percentile`] = out.panelPercentiles[p];
    out[`${p}Regime`] = out.panelRegimes[p];
  }
  return out;
}

// The combine stage of the regime engine (issue 1765, phase 2; proposal section
// 6.3). Pure: no fs, env, db or network.
//
// From each panel's weights and the signed scores: each panel index (the
// weighted mean of the day's signed scores), the composite over an explicit
// `included` list of panels in that order (panelMean), its normalisation, the
// trailing percentiles and the smoothed labels, every rule read from the rules
// (missingPanel, compositeNormalisation, labelCut, lookback.percentile).
//
// Every array is new: no input is written. The panel index and label
// functions moved here from analyze/compute.ts, which re-exports them.
//
// Accuracy (decision D78): the panel weighted mean, the composite mean and the
// fast-track sigma are compensated (transform/exact.ts).
import { COMPOSITE_BUCKETS, type Indicator, type Panel } from "../analyze/indicators.ts";
import { CURRENT_REGIME_VERSION, regimeRulesOf, type MissingPanelRule, type RegimeRules, type RegimeVersion } from "../analyze/regime-versions.ts";
import { ddDiv, ddDivD, ddValue, dotDD, meanAndSampleSd, sumDD } from "../transform/exact.ts";
import { rollingPercentileRank } from "../transform/math.ts";
import { lookbackDays } from "./score.ts";

/**
 * A panel index on one axis day (issue 1751): the weighted mean of that day's
 * signed scores, skipping an indicator with no finite score or weight; NaN
 * when no weight is left. Every panel index of every driver is this function.
 */
export function weightedMeanOnDay(
  signed: Record<string, number[]>,
  weights: Record<string, number>,
  indicators: readonly Indicator[],
  dayIdx: number,
): number {
  const ws: number[] = [];
  const vs: number[] = [];
  for (const ind of indicators) {
    const v = signed[ind.id]![dayIdx]!;
    const w = weights[ind.id]!;
    if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
    ws.push(w);
    vs.push(v);
  }
  const den = sumDD(ws);
  return den[0] > 0 ? ddValue(ddDiv(dotDD(ws, vs), den)) : NaN;
}

/**
 * The equal-weight mean of one day's panel indices, in panel order (the
 * composite before any normalisation). `rebase` averages the finite ones;
 * `nan` gives NaN when any is missing (issue 1741: a missing panel is a missing
 * composite, never a re-based mean). NaN when none is finite.
 */
export function panelMean(indices: readonly number[], missingPanel: MissingPanelRule): number {
  const vs: number[] = [];
  for (const v of indices) if (Number.isFinite(v)) vs.push(v);
  return vs.length > 0 && !(missingPanel === "nan" && vs.length < indices.length) ? ddValue(ddDivD(sumDD(vs), vs.length)) : NaN;
}

/**
 * One panel's index on every axis day: day i reads the weights `weightsOn(i)`
 * (the fit in force that day), or NaN when it gives none.
 */
export function panelIndexSeries(
  signed: Record<string, number[]>,
  indicators: readonly Indicator[],
  length: number,
  weightsOn: (i: number) => Record<string, number> | undefined,
): number[] {
  const out = new Array<number>(length).fill(NaN);
  for (let i = 0; i < length; i++) {
    const w = weightsOn(i);
    if (w !== undefined) out[i] = weightedMeanOnDay(signed, w, indicators, i);
  }
  return out;
}

/** What the combine stage derives from the panel indices of one panel set. */
export interface Combined {
  /** The composite before normalisation, only under composite normalisation "percentile" or when asked (`withMean`). */
  compositeMean?: number[];
  composite: number[];
  compositePercentile: number[];
  panelPercentiles: Record<string, number[]>;
  panelRegimes: Record<string, (string | null)[]>;
  regime: (string | null)[];
}

export interface CombineOptions {
  rules: RegimeRules;
  /** The panels labelled, in this order. */
  panels: readonly Panel[];
  /** The panels the composite averages, 1/n each, in this order. */
  included: readonly Panel[];
  /**
   * Whether the trailing percentiles of the composite and of each panel index
   * exist (a recomputing run). A kept run has none: they are NaN. Under
   * composite normalisation "percentile" they never exist.
   */
  percentiles: boolean;
  /** Always return the composite mean (a kept run states it under every normalisation). */
  withMean?: boolean;
}

/**
 * The combine stage over `panelIndices` (each of `opts.panels`, axis length
 * `length`): the composite mean over `included`, the composite (under
 * normalisation "percentile" the mid-rank of the mean over the percentile
 * lookback), the trailing percentiles when they exist, and the labels, each
 * cut on what rules.labelCut names and smoothed by smoothRegimes.
 */
export function combinePanels(panelIndices: Record<string, number[]>, length: number, opts: CombineOptions): Combined {
  const { rules } = opts;
  // Read only when a rank over it is taken, so rules that take none are not asked for the window.
  const percentileWindow = (): number => lookbackDays(rules.lookback, "percentile");
  const mean = new Array<number>(length).fill(NaN);
  for (let i = 0; i < length; i++) mean[i] = panelMean(opts.included.map((p) => panelIndices[p]![i]!), rules.missingPanel);
  // Composite normalisation (issue 1753): under "percentile" the composite is
  // the mid-rank of the panel mean over the percentile lookback, and no second
  // percentile of the composite or of a panel is computed.
  const normalised = rules.compositeNormalisation === "percentile";
  const composite = normalised ? rollingPercentileRank(mean, percentileWindow()) : mean;
  const ranked = opts.percentiles && !normalised;
  const none = (): number[] => new Array<number>(length).fill(NaN);
  const compositePercentile = ranked ? rollingPercentileRank(composite, percentileWindow()) : none();
  const panelPercentiles: Record<string, number[]> = {};
  const panelRegimes: Record<string, (string | null)[]> = {};
  for (const p of opts.panels) {
    panelPercentiles[p] = ranked ? rollingPercentileRank(panelIndices[p]!, percentileWindow()) : none();
    panelRegimes[p] = regimeLabels(panelIndices[p]!, panelPercentiles[p]!, undefined, rules);
  }
  const out: Combined = { composite, compositePercentile, panelPercentiles, panelRegimes, regime: regimeLabels(composite, compositePercentile, undefined, rules) };
  if (normalised || opts.withMean) out.compositeMean = mean;
  return out;
}

/**
 * The smoothed labels of one series (the composite, or a panel index) under a
 * methodology version: since v4 cut on the series itself, under v3 on `rank`,
 * its rolling percentile over the percentile lookback (issue 1652). `rules`,
 * when given, decides (rules.labelCut).
 */
export function regimeLabels(series: number[], rank: number[], version: RegimeVersion = CURRENT_REGIME_VERSION, rules?: RegimeRules): (string | null)[] {
  return smoothRegimes(regimeRulesOf(version, rules).labelCut === "percentile" ? rank : series, bucketFn);
}

// ─── Regime smoothing: 5-day confirmation OR 2σ fast-track ──────────────────
export const CONFIRMATION_DAYS = 5;
export const FAST_TRACK_SIGMA = 2.0;
export const SIGMA_LOOKBACK_DAYS = 252;

// `rankSeries` is the series the label is cut on: since v4 the composite or a
// panel index, under v3 its rolling percentile. The fast track measures σ on
// that same series.
export function smoothRegimes(
  rankSeries: number[],
  bucketFnArg: (p: number) => string | null,
): (string | null)[] {
  const out: (string | null)[] = new Array(rankSeries.length).fill(null);
  let prevRegime: string | null = null;
  for (let i = 0; i < rankSeries.length; i++) {
    const pct = rankSeries[i]!;
    if (!Number.isFinite(pct)) {
      out[i] = null;
      continue;
    }
    const naive = bucketFnArg(pct);
    if (prevRegime == null) {
      out[i] = naive;
      prevRegime = naive;
      continue;
    }
    if (naive === prevRegime) {
      out[i] = prevRegime;
      continue;
    }

    let fastTrack = false;
    if (i > 0 && Number.isFinite(rankSeries[i - 1])) {
      const delta = pct - rankSeries[i - 1]!;
      const start = Math.max(1, i - SIGMA_LOOKBACK_DAYS + 1);
      const deltas: number[] = [];
      for (let j = start; j <= i; j++) {
        const d = rankSeries[j]! - rankSeries[j - 1]!;
        if (Number.isFinite(d)) deltas.push(d);
      }
      if (deltas.length >= 30) {
        const sigma = ddValue(meanAndSampleSd(deltas).sd);
        if (sigma > 0 && Math.abs(delta) > FAST_TRACK_SIGMA * sigma) {
          const goingDown = delta < 0;
          if (
            (naive === "risk_off" && goingDown) ||
            (naive === "risk_on" && !goingDown) ||
            naive === "neutral"
          ) {
            fastTrack = true;
          }
        }
      }
    }

    if (fastTrack) {
      out[i] = naive;
      prevRegime = naive;
      continue;
    }

    const start = i - CONFIRMATION_DAYS + 1;
    if (start < 0) {
      out[i] = prevRegime;
      continue;
    }
    let allMatch = true;
    for (let j = start; j <= i; j++) {
      if (!Number.isFinite(rankSeries[j]) || bucketFnArg(rankSeries[j]!) !== naive) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      out[i] = naive;
      prevRegime = naive;
    } else {
      out[i] = prevRegime;
    }
  }
  return out;
}

export function bucketFn(p: number): string | null {
  if (!Number.isFinite(p)) return null;
  if (p < COMPOSITE_BUCKETS.risk_off) return "risk_off";
  if (p > COMPOSITE_BUCKETS.risk_on) return "risk_on";
  return "neutral";
}

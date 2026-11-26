// The fit stage of the regime engine (issue 1765, phase 2; proposal section
// 6.3). Pure: no fs, env, db or network.
//
// A panel's weights are the inverse-correlation weights of its indicators'
// signed scores over the weight window ending on the fit day
// (inverseCorrelationWeights). A panel's weights read only its own
// indicators, so fitting every panel once and reading any panel set from the
// fit equals fitting that set alone (D-e).
//
// Which days are fit is the driver's choice. A recomputing run fits the refresh
// calendar of its rules (refitDays: every `intervalDays` from the anchor, plus
// the run's last day under v3, issue 1739). A kept run fits each day it computes
// on that day.
//
// Moved here from analyze/compute.ts, which re-exports fitPanelWeights and
// WeightAnchorOutOfRangeError.
import type { Indicator, Panel } from "../analyze/indicators.ts";
import { isRefreshDate, refreshDateOn, regimeRulesOf, type RegimeRules, type WeightRefresh } from "../analyze/regime-versions.ts";
import { inverseCorrelationWeights } from "../transform/math.ts";
import { lookbackDays, observationMask } from "./score.ts";

/** The axis starts between refresh dates and the input does not reach the prior fit date (issue 1739). */
export class WeightAnchorOutOfRangeError extends RangeError {
  constructor(
    readonly firstDay: string,
    readonly fitDate: string,
  ) {
    super(`the axis starts ${firstDay}, after the refresh date ${fitDate}, so the weights in force on its first day cannot be fitted from this input`);
    this.name = "WeightAnchorOutOfRangeError";
  }
}

/**
 * The inverse-correlation weights of one panel, fitted on the weight window
 * ending on axis day `dayIdx` (issue 1751). `signed` holds the sign-aligned
 * ranks per indicator id (RegimeComputeResult.signed), `indicators` the panel's
 * indicators. `rules` defaults to the current version's preset; `carried` is
 * prepareRegimeInputs' mask, read only under rules that count observation
 * days. Every fit of every driver is this function.
 */
export function fitPanelWeights(
  signed: Record<string, number[]>,
  indicators: readonly Indicator[],
  dayIdx: number,
  opts: { rules?: RegimeRules; carried?: Record<string, boolean[]> } = {},
): Record<string, number> {
  const rules = regimeRulesOf(undefined, opts.rules);
  const weightWindow = lookbackDays(rules.lookback, "weight");
  const start = weightWindow === Infinity ? 0 : Math.max(0, dayIdx - weightWindow + 1);
  const window: Record<string, number[]> = {};
  const masks: Record<string, boolean[] | undefined> = {};
  for (const ind of indicators) {
    window[ind.id] = signed[ind.id]!.slice(start, dayIdx + 1);
    const m = observationMask(ind, rules, opts.carried);
    masks[ind.id] = m && m.slice(start, dayIdx + 1);
  }
  return inverseCorrelationWeights(window, undefined, undefined, masks);
}

/**
 * The axis days a recomputing run refits on, in order: each refresh date of the
 * calendar on the axis, plus the last day when the calendar refits on the
 * run's last day (v3). Day 0 is always a fit: on the calendar, or before the
 * anchor (no calendar yet). An axis that starts between refresh dates throws
 * WeightAnchorOutOfRangeError: the fit in force on its first day lies before it.
 */
export function refitDays(dateAxis: readonly string[], refresh: WeightRefresh): number[] {
  const days: number[] = [];
  for (let i = 0; i < dateAxis.length; i++) {
    const day = dateAxis[i]!;
    if (isRefreshDate(day, refresh) || (refresh.refitOnLastDay && i === dateAxis.length - 1)) days.push(i);
    else if (i === 0) {
      const prior = refreshDateOn(day, refresh);
      if (prior != null) throw new WeightAnchorOutOfRangeError(day, prior);
      days.push(0);
    }
  }
  return days;
}

/** The weights of every fitted panel on one fit day. */
export interface PanelFit {
  /** The axis index of the fit day. */
  day: number;
  weights: Record<string, Record<string, number>>;
}

/**
 * The fit stage: each of `panels` fit on each of `days` (axis indices, in
 * order), from the signed scores. Each panel reads only its own indicators,
 * in registry order. The weight objects are new; `signed` is never written.
 */
export function fitPanels(
  signed: Record<string, number[]>,
  indicators: readonly Indicator[],
  panels: readonly Panel[],
  days: readonly number[],
  opts: { rules: RegimeRules; carried?: Record<string, boolean[]> },
): PanelFit[] {
  const byPanel = panelIndicators(indicators, panels);
  return days.map((day) => {
    const weights: Record<string, Record<string, number>> = {};
    for (const p of panels) weights[p] = fitPanelWeights(signed, byPanel[p]!, day, opts);
    return { day, weights };
  });
}

/** Each panel's indicators, in registry order. */
export function panelIndicators(indicators: readonly Indicator[], panels: readonly Panel[]): Record<string, Indicator[]> {
  const out: Record<string, Indicator[]> = {};
  for (const p of panels) out[p] = indicators.filter((x) => x.panel === p);
  return out;
}

/** For each axis day, the index into `fits` of the fit in force (the latest fit on or before it); -1 before the first. */
export function fitInForce(length: number, fits: readonly PanelFit[]): Int32Array {
  const out = new Int32Array(length).fill(-1);
  let k = -1;
  for (let i = 0; i < length; i++) {
    while (k + 1 < fits.length && fits[k + 1]!.day <= i) k++;
    out[i] = k;
  }
  return out;
}

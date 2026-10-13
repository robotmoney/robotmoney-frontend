// Point-in-time regime labels: one runRegime per decision date, as-of that date,
// so no row dated after the decision is seen. This is the only honest way to get
// a historical label: a single full-history run uses end-of-history weights for
// every day (weightsByPanel is one record per run), so its past labels carry
// hindsight. Cost: ~0.8 s per run on the production floor.
import type { RawIndicatorHistory } from "../types.ts";
import { runRegime } from "../run.ts";
import { combineAggressiveN, combineConservativeN } from "../analyze/backtest.ts";
import type { State } from "./types.ts";

export interface AsofLabel {
  asof: string;
  composite: State | null;
  conservative: State | null;
  aggressive: State | null;
  macro: State | null;
  onchain: State | null;
  compositeValue: number | null;
  compositePercentile: number | null;
  macroPercentile: number | null;
  onchainPercentile: number | null;
  // What a single full-history run (current view) says for the same day. Reported
  // so the page can state how many labels differ between as-of and current view.
}

const st = (s: string | null | undefined): State | null =>
  s === "risk_off" || s === "neutral" || s === "risk_on" ? s : null;

export function asofLabel(raw: RawIndicatorHistory, asof: string, start?: string): AsofLabel {
  const run = runRegime(raw, { asof, start });
  const r = run.result;
  const last = run.dateAxis.length - 1;
  const panels = r.panels.map((p) => r.panelRegimes[p]?.[last] ?? null);
  const at = (xs: number[] | undefined) => {
    const v = xs?.[last];
    return v !== undefined && Number.isFinite(v) ? v : null;
  };
  return {
    asof,
    composite: st(r.regime[last]),
    conservative: st(combineConservativeN(panels)),
    aggressive: st(combineAggressiveN(panels)),
    macro: st(r.panelRegimes.macro?.[last]),
    onchain: st(r.panelRegimes.onchain?.[last]),
    compositeValue: at(r.composite),
    compositePercentile: at(r.compositePercentile),
    macroPercentile: at(r.panelPercentiles.macro),
    onchainPercentile: at(r.panelPercentiles.onchain),
  };
}

// Labels from one full-history run (the current view), keyed by date. Used only
// to measure hindsight: how often the as-of label differs from the current view.
export function currentViewLabels(raw: RawIndicatorHistory, asof: string, start?: string): Map<string, State | null> {
  const run = runRegime(raw, { asof, start });
  const out = new Map<string, State | null>();
  run.dateAxis.forEach((d, i) => out.set(d, st(run.result.regime[i])));
  return out;
}

// The score stage of the regime engine (issue 1765, phase 2; proposal section
// 6.3). Pure: no fs, env, db or network.
//
// Every indicator of a registry is scored once per axis: the mid-rank of its
// value within its trailing rank window (rollingPercentileRank), sign-aligned so
// 1 is the most risk-on. A recomputing run masks a day whose forward-fill age
// is beyond the global cap (#402) before the rank; a kept run does not (it
// never reads ages). Under rules that count observation days an `exchange`
// series ranks only its own real rows (issue 1741).
//
// Moved here from analyze/compute.ts, which re-exports lookbackDays: every
// driver (computeRegime, the kept record, runModel) scores through this file.
import { calendarOf, type Calendar, type Indicator } from "../analyze/indicators.ts";
import type { LookbackWindow, RegimeLookback, RegimeRules } from "../analyze/regime-versions.ts";
import { MAX_FORWARD_FILL_DAYS, rollingPercentileRank } from "../transform/math.ts";

/** Each indicator's rank within its own trailing window on every axis day, and the rank aligned by its sign. */
export interface StageScores {
  ranks: Record<string, number[]>;
  /** The rank aligned by the indicator's sign, so 1 is the most risk-on. */
  signed: Record<string, number[]>;
}

/**
 * The window length of one lookback window: `days` for a trailing window,
 * Infinity (the whole prefix) for an inception window. Throws RangeError naming
 * the window when it is missing, of an unknown kind, or has a `days` that is
 * not a positive integer.
 */
export function lookbackDays(lookback: RegimeLookback, name: keyof RegimeLookback): number {
  const w = (lookback as unknown as Record<string, LookbackWindow | undefined> | null | undefined)?.[name];
  if (w == null || typeof w !== "object") throw new RangeError(`lookback.${name} is missing`);
  if (w.kind === "inception") return Infinity;
  if (w.kind === "trailing") {
    if (!Number.isInteger(w.days) || w.days <= 0) {
      throw new RangeError(`lookback.${name}.days must be a positive integer, got ${String(w.days)}`);
    }
    return w.days;
  }
  throw new RangeError(`lookback.${name} has unknown kind ${JSON.stringify((w as { kind: unknown }).kind)}`);
}

/** The three windows of the rules, checked in the order the engine reads them: rank, weight, percentile. */
export function engineWindows(rules: RegimeRules): { rank: number; weight: number; percentile: number } {
  const rank = lookbackDays(rules.lookback, "rank");
  const weight = lookbackDays(rules.lookback, "weight");
  return { rank, weight, percentile: lookbackDays(rules.lookback, "percentile") };
}

/**
 * The rows of an indicator that count in a window: under rules that count
 * observation days, the `carried` mask of an `exchange` series; else every row
 * (undefined).
 */
export function observationMask(ind: { id: string; calendar?: Calendar }, rules: RegimeRules, carried: Record<string, boolean[]> | undefined): boolean[] | undefined {
  return rules.observationWindows && calendarOf(ind) === "exchange" ? carried?.[ind.id] : undefined;
}

export interface ScoreOptions {
  rules: RegimeRules;
  /** Days since the last real observation per indicator (prepareRegimeInputs `ages`). Without it no day is masked. */
  ages?: Record<string, number[]>;
  /** The global forward-fill cap the ages are read against (default MAX_FORWARD_FILL_DAYS, 120 days). */
  maxForwardFillDays?: number;
  /** prepareRegimeInputs `carried`, read only under rules that count observation days. */
  carried?: Record<string, boolean[]>;
}

/**
 * Score every indicator of `indicators` on every axis day of `transformed`.
 * Throws Error naming an indicator with no series. A day's score reads only
 * the window ending on it, so it is the same whether the axis ends on that day
 * or later. Every array is new; the inputs are never written.
 */
export function scoreIndicators(transformed: Record<string, number[]>, indicators: readonly Indicator[], opts: ScoreOptions): StageScores {
  const window = lookbackDays(opts.rules.lookback, "rank");
  const cap = opts.maxForwardFillDays ?? MAX_FORWARD_FILL_DAYS;
  const ranks: Record<string, number[]> = {};
  const signed: Record<string, number[]> = {};
  for (const ind of indicators) {
    const raw = transformed[ind.id];
    if (!raw) throw new Error(`Missing series for ${ind.id}`);
    const age = opts.ages?.[ind.id];
    const xs = age ? raw.map((v, i) => (Number.isFinite(age[i]) && age[i]! > cap ? NaN : v)) : raw;
    const r = rollingPercentileRank(xs, window, observationMask(ind, opts.rules, opts.carried));
    ranks[ind.id] = r;
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }
  return { ranks, signed };
}

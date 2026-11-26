// Regime compute pipeline — ported VERBATIM from agentjuno/robotmoney
// scripts/regime/compute.js. Deterministic and pure: same inputs, same outputs.
//
// Inputs: a map of indicator id → daily POST-TRANSFORM values aligned to a shared
// date axis.
//
// Pipeline:
//   1. Rolling percentile rank per indicator over the rank lookback
//   2. Sign-align so +1 = risk-on (sign>=0 ? v : 1-v)
//   3. Point-in-time inverse-correlation weights per panel (weight lookback
//      ending that day; refit on the fixed refresh calendar of the version, REGIME_WEIGHT_REFRESH)
//   4. Panel index = weighted mean of sign-aligned percentile-ranks
//   5. Composite = arithmetic mean of all included panel indices (v4: NaN on a
//      day any included panel has no index; v3 averages the panels that have one)
//   6. Bucket the composite → risk-off / neutral / risk-on, with 5-day
//      confirmation OR 2σ fast-track smoothing. Each panel label is bucketed
//      the same way from its panel index. The rolling percentile of the
//      composite and of each panel index, over the percentile lookback, is
//      still computed, as information.
//
// Since issue 1765 the steps are the stages of the regime engine (src/engine/:
// score.ts, fit.ts, combine.ts), and computeRegime is its recompute driver
// (engine/history.ts) over one panel set. This module keeps the names every
// caller imports: computeRegime and the step functions, re-exported.
//
// Methodology version (regime-versions.ts): v4 (current, issue 1652) cuts each
// label on the composite or panel index itself. v3 cut it on the rolling
// percentile of that series (a second ranking); it is kept so a run stamped v3
// replays exactly.
//
// Lookback (issue 1659): the rank, weight and percentile windows are the
// methodology parameters REGIME_LOOKBACK[version] declares (regime-versions.ts),
// unless a caller passes its own `lookback`.
//
// Accuracy (decision D78): the panel weighted mean, the composite
// mean and the fast-track σ are compensated (transform/exact.ts).
import { INDICATORS, PANELS, type Indicator, type Panel } from "./indicators.ts";
import { MAX_FORWARD_FILL_DAYS } from "../transform/math.ts";
import {
  CURRENT_REGIME_VERSION,
  isRegimeVersion,
  regimeRulesOf,
  type RegimeLookback,
  type RegimeRules,
  type RegimeVersion,
} from "./regime-versions.ts";
import { recomputeHistory, type RegimeComputeResult } from "../engine/history.ts";

export type { RegimeComputeResult } from "../engine/history.ts";
export { lookbackDays } from "../engine/score.ts";
export { WeightAnchorOutOfRangeError, fitPanelWeights } from "../engine/fit.ts";
export {
  CONFIRMATION_DAYS, FAST_TRACK_SIGMA, SIGMA_LOOKBACK_DAYS, bucketFn, panelMean, regimeLabels, smoothRegimes, weightedMeanOnDay,
} from "../engine/combine.ts";

/** computeRegime's options (issue 1765): every argument after the date axis, by name. */
export interface ComputeRegimeOptions {
  /** The panels computed, in this order; the composite averages them (default PANELS). */
  panels?: Panel[];
  // #402: per-indicator forward-fill age (days since the last REAL observation;
  // see transform/math.ts forwardFillAge), OPTIONAL and additive. When omitted,
  // behaviour is exactly unchanged. When supplied, any day whose age exceeds
  // `maxForwardFillDays` is treated as missing (NaN) for that indicator BEFORE
  // percentile ranking — it drops out of its own rank series, the sign-aligned
  // panel weighting (weightedMeanOnDay skips non-finite weight/value), and —
  // once persistently dead — inverseCorrelationWeights' minValidObs floor, so a
  // long-dead indicator's weight decays to 0 rather than dragging its last real
  // value forward forever. A resumed real observation resets age to 0 on that
  // date, so the indicator re-enters normally with no special-casing.
  ages?: Record<string, number[]>;
  /** The global forward-fill cap the ages are read against (default MAX_FORWARD_FILL_DAYS). */
  maxForwardFillDays?: number;
  /** Every engine rule as one object (issue 1751); default the current version's preset. */
  rules?: RegimeRules;
  /**
   * The scoring registry (issue 1653), as prepareRegimeInputs takes it. Default
   * INDICATORS; a caller passes its own list to try scoring another series. Any
   * key of panelData outside the list is ignored.
   */
  indicators?: readonly Indicator[];
  /**
   * Which rows are carried over from an earlier real observation, per indicator
   * (prepareRegimeInputs `carried`, issue 1741). Optional: without it every row
   * counts. Used only under rules that count observation days, and only for an
   * `exchange` indicator.
   */
  carried?: Record<string, boolean[]>;
  /** List every weight fit of the run in `weightFits` (tests, research). */
  recordWeightFits?: boolean;
}

/**
 * The regime of every day of `dateAxis` from the post-transform values in
 * `panelData`, over one panel set (issue 1765: the engine's recompute driver).
 * Called with exactly three arguments, the third a non-array object, it reads
 * the options form; any other call is the positional form below.
 */
export function computeRegime(panelData: Record<string, number[]>, dateAxis: string[], opts?: ComputeRegimeOptions): RegimeComputeResult;
/**
 * The positional form: the version's preset rules (REGIME_RULES[version]),
 * with `lookback` overriding their windows and `opts.rules` replacing them.
 * @deprecated Since issue 1765; pass the options object instead. Kept for one release.
 */
export function computeRegime(
  panelData: Record<string, number[]>,
  dateAxis: string[],
  panels?: Panel[],
  ages?: Record<string, number[]>,
  maxForwardFillDays?: number,
  version?: RegimeVersion,
  lookback?: RegimeLookback,
  indicators?: readonly Indicator[],
  opts?: { recordWeightFits?: boolean; rules?: RegimeRules },
  carried?: Record<string, boolean[]>,
): RegimeComputeResult;
export function computeRegime(panelData: Record<string, number[]>, dateAxis: string[], ...rest: unknown[]): RegimeComputeResult {
  const third = rest[0];
  if (rest.length === 1 && third !== null && typeof third === "object" && !Array.isArray(third)) return computeOver(panelData, dateAxis, third as ComputeRegimeOptions);
  return computeOver(panelData, dateAxis, positionalOptions(...(rest as Parameters<typeof positionalOptions>)));
}

// The options the positional form names: the version maps to its preset rules.
function positionalOptions(
  panels: Panel[] = PANELS,
  ages?: Record<string, number[]>,
  maxForwardFillDays: number = MAX_FORWARD_FILL_DAYS,
  version: RegimeVersion = CURRENT_REGIME_VERSION,
  lookback?: RegimeLookback,
  indicators: readonly Indicator[] = INDICATORS,
  opts: { recordWeightFits?: boolean; rules?: RegimeRules } = {},
  carried?: Record<string, boolean[]>,
): ComputeRegimeOptions {
  if (!isRegimeVersion(version)) throw new RangeError(`unknown regime version ${JSON.stringify(version)}`);
  const preset = regimeRulesOf(version, opts.rules);
  const rules: RegimeRules = lookback === undefined ? preset : { ...preset, lookback };
  return { panels, ages, maxForwardFillDays, rules, indicators, carried, recordWeightFits: opts.recordWeightFits };
}

const OPTION_NAMES: readonly string[] = ["panels", "ages", "maxForwardFillDays", "rules", "indicators", "carried", "recordWeightFits"];

function computeOver(panelData: Record<string, number[]>, dateAxis: string[], o: ComputeRegimeOptions): RegimeComputeResult {
  // A misspelt option would otherwise fall back to its default unnoticed.
  for (const k of Object.keys(o)) if (!OPTION_NAMES.includes(k)) throw new RangeError(`unknown computeRegime option ${JSON.stringify(k)}; expected ${OPTION_NAMES.join(", ")}`);
  const rules = regimeRulesOf(undefined, o.rules);
  const [result] = recomputeHistory(
    { dateAxis, transformed: panelData, ages: o.ages, carried: o.carried },
    { rules, indicators: o.indicators ?? INDICATORS, panelSets: [o.panels ?? PANELS], maxForwardFillDays: o.maxForwardFillDays, recordWeightFits: o.recordWeightFits },
  );
  return result!;
}

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
//      ending that day; recomputed on a 21-day cadence + always the final day)
//   4. Panel index = weighted mean of sign-aligned percentile-ranks
//   5. Composite = arithmetic mean of all included panel indices
//   6. Bucket the composite → risk-off / neutral / risk-on, with 5-day
//      confirmation OR 2σ fast-track smoothing. Each panel label is bucketed
//      the same way from its panel index. The rolling percentile of the
//      composite and of each panel index, over the percentile lookback, is
//      still computed, as information.
//
// Methodology version (regime-versions.ts): v5 (current, issue 1652) cuts each
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
import { ddDiv, ddDivD, ddValue, dotDD, meanAndSampleSd, sumDD } from "../transform/exact.ts";
import {
  INDICATORS,
  PANELS,
  COMPOSITE_BUCKETS,
  scoredIndicators,
  type Indicator,
  type Panel,
} from "./indicators.ts";
import {
  rollingPercentileRank,
  inverseCorrelationWeights,
  MAX_FORWARD_FILL_DAYS,
} from "../transform/math.ts";
import {
  CURRENT_REGIME_VERSION,
  REGIME_LOOKBACK,
  isRegimeVersion,
  type LookbackWindow,
  type RegimeLookback,
  type RegimeVersion,
} from "./regime-versions.ts";

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

export function computeRegime(
  panelData: Record<string, number[]>,
  dateAxis: string[],
  panels: Panel[] = PANELS,
  // #402: per-indicator forward-fill age (days since the last REAL observation;
  // see transform/math.ts forwardFillAge), OPTIONAL and additive. When omitted
  // (every existing call site, incl. the regime-fidelity byte-identical-replay
  // tests), behaviour is exactly unchanged. When supplied, any day whose age
  // exceeds `maxForwardFillDays` is treated as missing (NaN) for that indicator
  // BEFORE percentile ranking — it drops out of its own rank series, the sign-
  // aligned panel weighting (weightedMeanOnDay skips non-finite weight/value),
  // and — once persistently dead — inverseCorrelationWeights' minValidObs floor,
  // so a long-dead indicator's weight decays to 0 rather than dragging its last
  // real value forward forever. A resumed real observation resets age to 0 on
  // that date, so the indicator re-enters normally with no special-casing.
  ages?: Record<string, number[]>,
  maxForwardFillDays: number = MAX_FORWARD_FILL_DAYS,
  // The methodology version to compute (issue 1652). v5 cuts each label on the
  // composite or panel index; v3 on its rolling percentile.
  version: RegimeVersion = CURRENT_REGIME_VERSION,
  // The rank, weight and percentile windows (issue 1659). Defaults to the
  // declaration of `version`; a caller passes its own to try another value.
  lookback: RegimeLookback = REGIME_LOOKBACK[version],
  // The registry (issue 1654). Ranks, weights and panel membership come from
  // the indicators it scores under `version` (scoredIndicators) only: an
  // unscored indicator gets no rank and no weight, and needs no series.
  indicators: readonly Indicator[] = INDICATORS,
): RegimeComputeResult {
  if (!isRegimeVersion(version)) throw new RangeError(`unknown regime version ${JSON.stringify(version)}`);
  const rankWindow = lookbackDays(lookback, "rank");
  const weightWindow = lookbackDays(lookback, "weight");
  const percentileWindow = lookbackDays(lookback, "percentile");
  const scored = scoredIndicators(version, indicators);
  const ranks: Record<string, number[]> = {};
  const signed: Record<string, number[]> = {};
  for (const ind of scored) {
    const raw = panelData[ind.id];
    if (!raw) throw new Error(`Missing series for ${ind.id}`);
    const age = ages?.[ind.id];
    const xs = age
      ? raw.map((v, i) => (Number.isFinite(age[i]) && age[i] > maxForwardFillDays ? NaN : v))
      : raw;
    const r = rollingPercentileRank(xs, rankWindow);
    ranks[ind.id] = r;
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }

  const WEIGHT_REFRESH_DAYS = 21;
  const indsByPanel: Record<string, Indicator[]> = {};
  for (const p of panels) indsByPanel[p] = scored.filter((x) => x.panel === p);

  const panelIndices: Record<string, number[]> = {};
  for (const p of panels) panelIndices[p] = new Array(dateAxis.length).fill(NaN);

  const curWeights: Record<string, Record<string, number>> = {};
  for (const p of panels) curWeights[p] = {};

  for (let i = 0; i < dateAxis.length; i++) {
    if (i % WEIGHT_REFRESH_DAYS === 0 || i === dateAxis.length - 1) {
      for (const p of panels) {
        const start = weightWindow === Infinity ? 0 : Math.max(0, i - weightWindow + 1);
        const window: Record<string, number[]> = {};
        for (const ind of indsByPanel[p]) {
          window[ind.id] = signed[ind.id].slice(start, i + 1);
        }
        curWeights[p] = inverseCorrelationWeights(window);
      }
    }
    for (const p of panels) {
      panelIndices[p][i] = weightedMeanOnDay(signed, curWeights[p], indsByPanel[p], i);
    }
  }
  const weightsByPanel = curWeights;

  const composite = new Array(dateAxis.length).fill(NaN);
  for (let i = 0; i < dateAxis.length; i++) {
    const vs: number[] = [];
    for (const p of panels) {
      const v = panelIndices[p][i];
      if (Number.isFinite(v)) vs.push(v);
    }
    composite[i] = vs.length > 0 ? ddValue(ddDivD(sumDD(vs), vs.length)) : NaN;
  }

  const compRank = rollingPercentileRank(composite, percentileWindow);

  const panelPercentiles: Record<string, number[]> = {};
  const panelRegimes: Record<string, (string | null)[]> = {};
  for (const p of panels) {
    panelPercentiles[p] = rollingPercentileRank(panelIndices[p], percentileWindow);
    panelRegimes[p] = regimeLabels(panelIndices[p], panelPercentiles[p], version);
  }

  const out: RegimeComputeResult = {
    dateAxis,
    panels,
    ranks,
    signed,
    weightsByPanel,
    panelIndices,
    panelPercentiles,
    panelRegimes,
    composite,
    compositePercentile: compRank,
    regime: regimeLabels(composite, compRank, version),
  };
  if (panels.includes("macro")) {
    out.macroIndex = panelIndices.macro;
    out.macroPercentile = panelPercentiles.macro;
    out.macroRegime = panelRegimes.macro;
  }
  if (panels.includes("onchain")) {
    out.onchainIndex = panelIndices.onchain;
    out.onchainPercentile = panelPercentiles.onchain;
    out.onchainRegime = panelRegimes.onchain;
  }
  if (panels.includes("factor")) {
    out.factorIndex = panelIndices.factor;
    out.factorPercentile = panelPercentiles.factor;
    out.factorRegime = panelRegimes.factor;
  }
  return out;
}

/**
 * The window length of one lookback window: `days` for a trailing window,
 * Infinity (the whole prefix) for an inception window. Throws RangeError naming
 * the window when it is missing, of an unknown kind, or has a `days` that is
 * not a positive integer.
 */
function lookbackDays(lookback: RegimeLookback, name: keyof RegimeLookback): number {
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

/**
 * The smoothed labels of one series (the composite, or a panel index) under a
 * methodology version: since v5 cut on the series itself, under v3 on `rank`,
 * its rolling percentile over the percentile lookback (issue 1652).
 */
export function regimeLabels(series: number[], rank: number[], version: RegimeVersion = CURRENT_REGIME_VERSION): (string | null)[] {
  return smoothRegimes(version === "v3" ? rank : series, bucketFn);
}

// ─── Regime smoothing: 5-day confirmation OR 2σ fast-track ──────────────────
export const CONFIRMATION_DAYS = 5;
export const FAST_TRACK_SIGMA = 2.0;
export const SIGMA_LOOKBACK_DAYS = 252;

// `rankSeries` is the series the label is cut on: since v5 the composite or a
// panel index, under v3 its rolling percentile. The fast track measures σ on
// that same series.
export function smoothRegimes(
  rankSeries: number[],
  bucketFnArg: (p: number) => string | null,
): (string | null)[] {
  const out: (string | null)[] = new Array(rankSeries.length).fill(null);
  let prevRegime: string | null = null;
  for (let i = 0; i < rankSeries.length; i++) {
    const pct = rankSeries[i];
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
      const delta = pct - rankSeries[i - 1];
      const start = Math.max(1, i - SIGMA_LOOKBACK_DAYS + 1);
      const deltas: number[] = [];
      for (let j = start; j <= i; j++) {
        const d = rankSeries[j] - rankSeries[j - 1];
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
      if (!Number.isFinite(rankSeries[j]) || bucketFnArg(rankSeries[j]) !== naive) {
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

function weightedMeanOnDay(
  signed: Record<string, number[]>,
  weights: Record<string, number>,
  indicators: Indicator[],
  dayIdx: number,
): number {
  const ws: number[] = [];
  const vs: number[] = [];
  for (const ind of indicators) {
    const v = signed[ind.id][dayIdx];
    const w = weights[ind.id];
    if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
    ws.push(w);
    vs.push(v);
  }
  const den = sumDD(ws);
  return den[0] > 0 ? ddValue(ddDiv(dotDD(ws, vs), den)) : NaN;
}

export function bucketFn(p: number): string | null {
  if (!Number.isFinite(p)) return null;
  if (p < COMPOSITE_BUCKETS.risk_off) return "risk_off";
  if (p > COMPOSITE_BUCKETS.risk_on) return "risk_on";
  return "neutral";
}

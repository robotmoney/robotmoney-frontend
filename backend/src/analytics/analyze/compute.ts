// Regime compute pipeline — ported VERBATIM from agentjuno/robotmoney
// scripts/regime/compute.js. Deterministic and pure: same inputs, same outputs.
//
// Inputs: a map of indicator id → daily POST-TRANSFORM values aligned to a shared
// date axis.
//
// Pipeline:
//   1. Rolling 3y percentile rank per indicator
//   2. Sign-align so +1 = risk-on (sign>=0 ? v : 1-v)
//   3. Point-in-time inverse-correlation weights per panel (trailing 3y window
//      ending that day; recomputed on a 21-day cadence + always the final day)
//   4. Panel index = weighted mean of sign-aligned percentile-ranks
//   5. Composite = arithmetic mean of all included panel indices
//   6. Bucket composite by 3y rolling percentile → risk-off / neutral / risk-on,
//      with 5-day confirmation OR 2σ fast-track smoothing.
import {
  INDICATORS,
  PANELS,
  ROLLING_WINDOW_DAYS,
  COMPOSITE_BUCKETS,
  type Indicator,
  type Panel,
} from "./indicators.ts";
import { rollingPercentileRank, inverseCorrelationWeights } from "../transform/math.ts";

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
): RegimeComputeResult {
  const ranks: Record<string, number[]> = {};
  const signed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const xs = panelData[ind.id];
    if (!xs) throw new Error(`Missing series for ${ind.id}`);
    const r = rollingPercentileRank(xs, ROLLING_WINDOW_DAYS);
    ranks[ind.id] = r;
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }

  const WEIGHT_REFRESH_DAYS = 21;
  const indsByPanel: Record<string, Indicator[]> = {};
  for (const p of panels) indsByPanel[p] = INDICATORS.filter((x) => x.panel === p);

  const panelIndices: Record<string, number[]> = {};
  for (const p of panels) panelIndices[p] = new Array(dateAxis.length).fill(NaN);

  const curWeights: Record<string, Record<string, number>> = {};
  for (const p of panels) curWeights[p] = {};

  for (let i = 0; i < dateAxis.length; i++) {
    if (i % WEIGHT_REFRESH_DAYS === 0 || i === dateAxis.length - 1) {
      for (const p of panels) {
        const start = Math.max(0, i - ROLLING_WINDOW_DAYS + 1);
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
    let sum = 0;
    let n = 0;
    for (const p of panels) {
      const v = panelIndices[p][i];
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    composite[i] = n > 0 ? sum / n : NaN;
  }

  const compRank = rollingPercentileRank(composite, ROLLING_WINDOW_DAYS);

  const panelPercentiles: Record<string, number[]> = {};
  const panelRegimes: Record<string, (string | null)[]> = {};
  for (const p of panels) {
    panelPercentiles[p] = rollingPercentileRank(panelIndices[p], ROLLING_WINDOW_DAYS);
    panelRegimes[p] = smoothRegimes(panelPercentiles[p], bucketFn);
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
    regime: smoothRegimes(compRank, bucketFn),
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

// ─── Regime smoothing: 5-day confirmation OR 2σ fast-track ──────────────────
export const CONFIRMATION_DAYS = 5;
export const FAST_TRACK_SIGMA = 2.0;
export const SIGMA_LOOKBACK_DAYS = 252;

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
        const m = deltas.reduce((s, v) => s + v, 0) / deltas.length;
        const variance = deltas.reduce((s, v) => s + (v - m) ** 2, 0) / (deltas.length - 1);
        const sigma = Math.sqrt(variance);
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
  let num = 0;
  let den = 0;
  for (const ind of indicators) {
    const v = signed[ind.id][dayIdx];
    const w = weights[ind.id];
    if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : NaN;
}

export function bucketFn(p: number): string | null {
  if (!Number.isFinite(p)) return null;
  if (p < COMPOSITE_BUCKETS.risk_off) return "risk_off";
  if (p > COMPOSITE_BUCKETS.risk_on) return "risk_on";
  return "neutral";
}

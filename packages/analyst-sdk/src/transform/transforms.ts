// Per-indicator transforms applied to a raw daily series before percentile
// ranking. Ported VERBATIM from agentjuno/robotmoney scripts/regime/lib/transforms.js.
//
//   level          → identity (raw level)
//   change30       → 30-day pct change
//   change90       → 90-day pct change
//   sma4           → 4-period moving average
//   sma7           → 7-day moving average
//   trend_50_200   → SMA50 / SMA200 (>1 = uptrend)
//   rolling_sum_7  → trailing 7-day sum
//   ratio          → numerator / denominator (via applyRatio)
import { sma, pctChangeLag, rollingSum } from "./math.ts";

export function applyTransform(name: string, xs: number[]): number[] {
  switch (name) {
    case "level":
      return xs.slice();
    case "change30":
      return pctChangeLag(xs, 30);
    case "change90":
      return pctChangeLag(xs, 90);
    case "sma4":
      return sma(xs, 4);
    case "sma7":
      return sma(xs, 7);
    case "trend_50_200": {
      const s50 = sma(xs, 50);
      const s200 = sma(xs, 200);
      const out = new Array(xs.length).fill(NaN);
      for (let i = 0; i < xs.length; i++) {
        if (Number.isFinite(s50[i]) && Number.isFinite(s200[i]) && s200[i] !== 0) {
          out[i] = s50[i] / s200[i];
        }
      }
      return out;
    }
    case "rolling_sum_7":
      return rollingSum(xs, 7);
    default:
      throw new Error(`Unknown transform: ${name}`);
  }
}

export function applyRatio(numXs: number[], denXs: number[]): number[] {
  const n = Math.min(numXs.length, denXs.length);
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(numXs[i]) && Number.isFinite(denXs[i]) && denXs[i] !== 0) {
      out[i] = numXs[i] / denXs[i];
    }
  }
  return out;
}

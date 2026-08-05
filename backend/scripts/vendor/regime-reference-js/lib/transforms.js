// VENDORED VERBATIM — see ../README.md for full provenance (issue #447).
// Source: robotmoney/robotmoney-site (fork of agentjuno/robotmoney)
// scripts/regime/lib/transforms.js, blob sha
// 69228d18678fb5526e258f55573b818c08fba227, fetched/verified 2026-08-02.
// NO logic changes.
// Vendored verbatim for offline regeneration of independent-fidelity golden
// fixtures only — never imported by production or runtime code.
/**
 * Transforms applied to a raw daily series before percentile ranking.
 *
 * Each transform takes an array of daily values (NaN for missing/pre-history)
 * and returns an array of the same length.
 *
 *   level          → identity (use the raw level)
 *   change30       → 30-day pct change
 *   change90       → 90-day pct change (smoother than change30; less reference-slide artifact)
 *   sma4           → 4-period (~weekly) moving average for weekly series
 *   sma7           → 7-day moving average
 *   trend_50_200   → SMA50 / SMA200 (>1 = uptrend)
 *   ratio          → numerator series / denominator series (handled by compute)
 *   rolling_sum_7  → trailing 7-day sum (for ETF net flows)
 */

const { sma, pctChange, rollingSum } = require('./utils');

function applyTransform(name, xs) {
  switch (name) {
    case 'level':
      return xs.slice();
    case 'change30':
      return pctChange(xs, 30);
    case 'change90':
      return pctChange(xs, 90);
    case 'sma4':
      return sma(xs, 4);
    case 'sma7':
      return sma(xs, 7);
    case 'trend_50_200': {
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
    case 'rolling_sum_7':
      return rollingSum(xs, 7);
    default:
      throw new Error(`Unknown transform: ${name}`);
  }
}

function applyRatio(numXs, denXs) {
  const n = Math.min(numXs.length, denXs.length);
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(numXs[i]) && Number.isFinite(denXs[i]) && denXs[i] !== 0) {
      out[i] = numXs[i] / denXs[i];
    }
  }
  return out;
}

module.exports = { applyTransform, applyRatio };

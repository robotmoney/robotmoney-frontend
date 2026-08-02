// VENDORED VERBATIM — see ./README.md for full provenance (issue #447).
// Source: robotmoney/robotmoney-site (fork of agentjuno/robotmoney)
// scripts/regime/compute.js, blob sha 75cd2110b5db587efdb04c3531aed1ffa07b1624,
// fetched/verified 2026-08-02. NO logic changes.
// Vendored verbatim for offline regeneration of independent-fidelity golden
// fixtures only — never imported by production or runtime code.
/**
 * Regime compute pipeline.
 *
 * Inputs: a map of indicator id → daily values aligned to a shared date axis.
 *         All values are post-transform (level / change / sma / etc).
 *
 * Pipeline:
 *   1. Rolling 3y percentile rank per indicator (handled here)
 *   2. Sign-align so +1 = risk-on  (high percentile after sign-align = risk-on)
 *   3. Point-in-time inverse-correlation weights per panel: each day's weights
 *      use only the trailing 3y window ending that day (no look-ahead)
 *   4. Panel index = weighted mean of sign-aligned percentile-ranks
 *   5. Composite = arithmetic mean of all included panel indices
 *   6. Bucket composite by 3y percentile → risk-off / neutral / risk-on
 *
 * The compute is deterministic and pure: same inputs, same outputs.
 *
 * computeRegime accepts an optional `panels` argument to override the default
 * panel list from indicators.js. This is used by update.js to produce two
 * snapshots in one run: the standard 2-panel ['macro', 'onchain'] composite
 * for /regime, and an extended ['macro', 'onchain', 'factor'] composite for
 * /regime_eq. When called with default panels the output is byte-identical to
 * pre-refactor behavior.
 */

const {
  INDICATORS,
  PANELS,
  ROLLING_WINDOW_DAYS,
  COMPOSITE_BUCKETS,
} = require('./lib/indicators');
const { rollingPercentileRank, inverseCorrelationWeights } = require('./lib/utils');

function computeRegime(panelData, dateAxis, panels = PANELS) {
  // panelData: { [indicatorId]: number[] aligned to dateAxis }, post-transform
  const ranks = {};
  const signed = {};
  for (const ind of INDICATORS) {
    const xs = panelData[ind.id];
    if (!xs) throw new Error(`Missing series for ${ind.id}`);
    const r = rollingPercentileRank(xs, ROLLING_WINDOW_DAYS);
    ranks[ind.id] = r;
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }

  // Point-in-time inverse-correlation weights. On each day, the weights are
  // computed from ONLY the trailing ROLLING_WINDOW_DAYS of sign-aligned data
  // ending that day — no future data is ever used to weight a past day.
  // Recomputed on a monthly cadence: a 3y correlation matrix moves
  // negligibly day-to-day (identical to <1e-3 vs daily recompute) at ~1/21
  // the cost. The final day's vector is exposed as `weightsByPanel` for the
  // snapshot's current-weights display.
  const WEIGHT_REFRESH_DAYS = 21;
  const indsByPanel = {};
  for (const p of panels) indsByPanel[p] = INDICATORS.filter((x) => x.panel === p);

  const panelIndices = {};
  for (const p of panels) panelIndices[p] = new Array(dateAxis.length).fill(NaN);

  const curWeights = {};
  for (const p of panels) curWeights[p] = {};

  for (let i = 0; i < dateAxis.length; i++) {
    if (i % WEIGHT_REFRESH_DAYS === 0 || i === dateAxis.length - 1) {
      for (const p of panels) {
        const start = Math.max(0, i - ROLLING_WINDOW_DAYS + 1);
        const window = {};
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

  // Composite = arithmetic mean of available panel indices on each day.
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

  // Bucket via 3y rolling percentile of the composite itself
  const compRank = rollingPercentileRank(composite, ROLLING_WINDOW_DAYS);
  const bucket = (p) => {
    if (!Number.isFinite(p)) return null;
    if (p < COMPOSITE_BUCKETS.risk_off) return 'risk_off';
    if (p > COMPOSITE_BUCKETS.risk_on) return 'risk_on';
    return 'neutral';
  };

  const panelPercentiles = {};
  const panelRegimes = {};
  for (const p of panels) {
    panelPercentiles[p] = rollingPercentileRank(panelIndices[p], ROLLING_WINDOW_DAYS);
    panelRegimes[p] = smoothRegimes(panelPercentiles[p], bucket);
  }

  const out = {
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
    regime: smoothRegimes(compRank, bucket),
  };
  // Legacy fields for back-compat with downstream code that still reads
  // result.macroIndex / result.onchainIndex / result.macroRegime etc.
  // These are populated only when the corresponding panel was computed.
  if (panels.includes('macro')) {
    out.macroIndex = panelIndices.macro;
    out.macroPercentile = panelPercentiles.macro;
    out.macroRegime = panelRegimes.macro;
  }
  if (panels.includes('onchain')) {
    out.onchainIndex = panelIndices.onchain;
    out.onchainPercentile = panelPercentiles.onchain;
    out.onchainRegime = panelRegimes.onchain;
  }
  if (panels.includes('factor')) {
    out.factorIndex = panelIndices.factor;
    out.factorPercentile = panelPercentiles.factor;
    out.factorRegime = panelRegimes.factor;
  }
  return out;
}

// ─── Regime smoothing: 5-day confirmation OR 2σ fast-track ──────────────────
//
// Without smoothing, the raw percentile-bucket function flips state on any
// day the percentile crosses 0.33 or 0.67 — even by 0.001. That makes the
// classifier hypersensitive to data revisions (which shift correlations →
// shift weights → shift composite by tiny amounts) and to natural noise
// near the threshold boundaries.
//
// Smoothing rule:
//   (a) Confirmation: requires CONFIRMATION_DAYS consecutive trading days
//       where the naive (unsmoothed) bucket matches the new regime before
//       switching. Filters out one- and two-day boundary flickers.
//   (b) Fast-track override: if the day-over-day Δ in composite_pctile
//       exceeds FAST_TRACK_SIGMA × σ of the trailing 1y daily-change
//       distribution, AND the move's direction is consistent with the
//       proposed new bucket, the switch happens immediately. This is the
//       circuit-breaker that handles legitimate fast regime shifts
//       (COVID March 2020 was a multi-σ daily move).
//
// Both knobs are calibrated to the data's own noise distribution, not
// tuned on backtest output (no p-hacking).

const CONFIRMATION_DAYS = 5;
const FAST_TRACK_SIGMA = 2.0;
const SIGMA_LOOKBACK_DAYS = 252;

function smoothRegimes(rankSeries, bucketFn) {
  const out = new Array(rankSeries.length).fill(null);
  let prevRegime = null;
  for (let i = 0; i < rankSeries.length; i++) {
    const pct = rankSeries[i];
    if (!Number.isFinite(pct)) {
      out[i] = null;
      continue;
    }
    const naive = bucketFn(pct);
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
      const deltas = [];
      for (let j = start; j <= i; j++) {
        const d = rankSeries[j] - rankSeries[j - 1];
        if (Number.isFinite(d)) deltas.push(d);
      }
      if (deltas.length >= 30) {
        const m = deltas.reduce((s, v) => s + v, 0) / deltas.length;
        const variance =
          deltas.reduce((s, v) => s + (v - m) ** 2, 0) / (deltas.length - 1);
        const sigma = Math.sqrt(variance);
        if (sigma > 0 && Math.abs(delta) > FAST_TRACK_SIGMA * sigma) {
          const goingDown = delta < 0;
          if (
            (naive === 'risk_off' && goingDown) ||
            (naive === 'risk_on' && !goingDown) ||
            naive === 'neutral'
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
      if (!Number.isFinite(rankSeries[j]) || bucketFn(rankSeries[j]) !== naive) {
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

function weightedMeanOnDay(signed, weights, indicators, dayIdx) {
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

function bucketFn(p) {
  if (!Number.isFinite(p)) return null;
  if (p < COMPOSITE_BUCKETS.risk_off) return 'risk_off';
  if (p > COMPOSITE_BUCKETS.risk_on) return 'risk_on';
  return 'neutral';
}

module.exports = {
  computeRegime,
  smoothRegimes,
  bucketFn,
  CONFIRMATION_DAYS,
  FAST_TRACK_SIGMA,
  SIGMA_LOOKBACK_DAYS,
};

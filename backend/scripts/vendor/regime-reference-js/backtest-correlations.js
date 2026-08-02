// VENDORED, VERBATIM EXTRACTION — see ./README.md for full provenance
// (issue #447).
// Source: robotmoney/robotmoney-site (fork of agentjuno/robotmoney)
// scripts/regime/update.js, blob sha
// aa51879cf7eea299871e1744a89ba9cdf13c0546 (identical in both repos),
// fetched/verified 2026-08-02.
//
// This file is a VERBATIM extraction of computeCorrelations / computeBacktest
// / stripDailyFromSnapshot and their private helper functions from update.js.
// update.js itself is NOT vendored wholesale (it pulls in live-fetcher
// dependencies this repo doesn't need) — only these pure functions, lifted
// out of update.js's file-writing/CLI orchestration so they're callable
// standalone against already-computed inputs. NO LOGIC CHANGES were made
// during extraction.
//
// Vendored verbatim for offline regeneration of independent-fidelity golden
// fixtures only — never imported by production or runtime code.

const { PANELS } = require('./lib/indicators');

// ─── Predictive-power: trailing Spearman ρ vs forward SPX / ETH returns ──────

const CORR_HORIZONS_DAYS = [30, 90, 180];
const CORR_ASSETS = ['spx', 'eth'];

function computeCorrelations(dateAxis, result, extras) {
  const indices = { composite: result.composite };
  for (const p of result.panels || PANELS) indices[p] = result.panelIndices[p];
  const priceMaps = {
    spx: toDateMap(extras.spx),
    eth: toDateMap(extras.eth),
  };
  const out = { forward: {}, concurrent: {} };
  for (const [idxName, series] of Object.entries(indices)) {
    out.forward[idxName] = {};
    out.concurrent[idxName] = {};
    for (const asset of CORR_ASSETS) {
      for (const h of CORR_HORIZONS_DAYS) {
        const pairs = [];
        for (let i = 0; i < dateAxis.length; i++) {
          const x = series[i];
          if (!Number.isFinite(x)) continue;
          const d = dateAxis[i];
          const p0 = lookupPrice(priceMaps[asset], d, -1);
          const p1 = lookupPrice(priceMaps[asset], addDaysIso(d, h), +1);
          if (p0 == null || p1 == null || p0 <= 0 || p1 <= 0) continue;
          pairs.push([x, Math.log(p1 / p0)]);
        }
        out.forward[idxName][`${asset}_${h}d`] = {
          rho: nullIfNaN(spearman(pairs)),
          n: pairs.length,
        };
      }
      const cPairs = [];
      for (let i = 0; i < dateAxis.length; i++) {
        const x = series[i];
        if (!Number.isFinite(x)) continue;
        const p = lookupPrice(priceMaps[asset], dateAxis[i], -1);
        if (p == null || p <= 0) continue;
        cPairs.push([x, Math.log(p)]);
      }
      out.concurrent[idxName][asset] = {
        rho: nullIfNaN(spearman(cPairs)),
        n: cPairs.length,
      };
    }
  }
  return out;
}

function toDateMap(series) {
  const m = new Map();
  if (Array.isArray(series)) for (const p of series) m.set(p.date, p.value);
  return m;
}

function lookupPrice(map, iso, dir, maxStep = 7) {
  let d = iso;
  for (let i = 0; i <= maxStep; i++) {
    const v = map.get(d);
    if (Number.isFinite(v)) return v;
    d = addDaysIso(d, dir);
  }
  return null;
}

function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function spearman(pairs) {
  if (pairs.length < 10) return NaN;
  const rx = ranks(pairs.map((p) => p[0]));
  const ry = ranks(pairs.map((p) => p[1]));
  return pearson(rx, ry);
}

function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 2) return NaN;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db; da2 += da * da; db2 += db * db;
  }
  const denom = Math.sqrt(da2 * db2);
  return denom > 0 ? num / denom : NaN;
}

// ─── Regime backtest: 3-state portfolios across multiple risk constructions ──

const BACKTEST_COST_PER_REBALANCE = 0.001;
const BACKTEST_IN_SAMPLE_END = '2024-01-31';

const PORTFOLIO_SPECS = {
  eth: {
    risky: ['eth'],
    weights: {
      risk_off: { cash: 1, eth: 0 },
      neutral:  { cash: 0.5, eth: 0.5 },
      risk_on:  { cash: 0, eth: 1 },
    },
    hodl: { key: 'eth_hodl', weights: { cash: 0, eth: 1 } },
  },
  sp500: {
    risky: ['sp500'],
    weights: {
      risk_off: { cash: 1, sp500: 0 },
      neutral:  { cash: 0.5, sp500: 0.5 },
      risk_on:  { cash: 0, sp500: 1 },
    },
    hodl: { key: 'sp500_hodl', weights: { cash: 0, sp500: 1 } },
  },
  mixed: {
    risky: ['eth', 'sp500'],
    weights: {
      risk_off: { cash: 1, eth: 0, sp500: 0 },
      neutral:  { cash: 0.5, eth: 0.25, sp500: 0.25 },
      risk_on:  { cash: 0, eth: 0.5, sp500: 0.5 },
    },
    hodl: { key: 'blend_hodl', weights: { cash: 0, eth: 0.5, sp500: 0.5 } },
  },
};

function computeBacktest(dateAxis, result, extras) {
  const tbillMap = toDateMap(extras.tbill3m);
  let lastTbill = 0;
  const tbillDaily = new Array(dateAxis.length).fill(0);
  for (let i = 0; i < dateAxis.length; i++) {
    if (tbillMap.has(dateAxis[i])) lastTbill = tbillMap.get(dateAxis[i]);
    tbillDaily[i] = Number.isFinite(lastTbill) ? lastTbill : 0;
  }

  const assetSeries = {
    eth: forwardFillDaily(extras.eth, dateAxis),
    sp500: forwardFillDaily(extras.spx, dateAxis),
  };

  const panels = result.panels || PANELS;
  const strategies = { composite: result.regime };
  for (const p of panels) strategies[p] = result.panelRegimes[p];
  if (result.panelRegimes.macro) {
    strategies.macro_inverted = result.panelRegimes.macro.map((b) => {
      if (b === 'risk_off') return 'risk_on';
      if (b === 'risk_on') return 'risk_off';
      return b;
    });
  }
  strategies.conservative = result.regime.map((_, i) =>
    combineConservativeN(panels.map((p) => result.panelRegimes[p][i]))
  );
  strategies.aggressive = result.regime.map((_, i) =>
    combineAggressiveN(panels.map((p) => result.panelRegimes[p][i]))
  );

  const out = {};
  for (const [pKey, spec] of Object.entries(PORTFOLIO_SPECS)) {
    const firstIdx = firstIndexWithAllAssets(spec.risky, assetSeries);
    if (firstIdx < 0) continue;

    const port = {};
    for (const [name, regimeSeries] of Object.entries(strategies)) {
      port[name] = simulate(
        dateAxis,
        regimeSeries,
        spec.weights,
        assetSeries,
        tbillDaily,
        firstIdx,
        null,
      );
    }
    port[spec.hodl.key] = simulate(
      dateAxis,
      null,
      null,
      assetSeries,
      tbillDaily,
      firstIdx,
      spec.hodl.weights,
    );
    port.stables_only = simulate(
      dateAxis,
      null,
      null,
      assetSeries,
      tbillDaily,
      firstIdx,
      { cash: 1 },
    );
    out[pKey] = port;
  }

  return out;
}

function combineConservativeN(labels) {
  if (labels.some((l) => !l)) return null;
  if (labels.some((l) => l === 'risk_off')) return 'risk_off';
  if (labels.every((l) => l === 'risk_on')) return 'risk_on';
  return 'neutral';
}

function combineAggressiveN(labels) {
  if (labels.some((l) => !l)) return null;
  const score = (r) => (r === 'risk_on' ? 1 : r === 'risk_off' ? -1 : 0);
  const sum = labels.reduce((s, l) => s + score(l), 0);
  if (sum > 0) return 'risk_on';
  if (sum < 0) return 'risk_off';
  return 'neutral';
}

function firstIndexWithAllAssets(assetKeys, assetSeries) {
  for (let i = 0; i < assetSeries[assetKeys[0]].length; i++) {
    if (assetKeys.every((k) => Number.isFinite(assetSeries[k][i]))) return i;
  }
  return -1;
}

function forwardFillDaily(series, dateAxis) {
  const map = new Map();
  if (Array.isArray(series)) for (const p of series) map.set(p.date, p.value);
  let last = NaN;
  const out = new Array(dateAxis.length).fill(NaN);
  for (let i = 0; i < dateAxis.length; i++) {
    if (map.has(dateAxis[i])) last = map.get(dateAxis[i]);
    out[i] = last;
  }
  return out;
}

function sameWeights(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1e-9) return false;
  }
  return true;
}

function turnoverBetween(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0;
  for (const k of keys) s += Math.abs((a[k] || 0) - (b[k] || 0));
  return s / 2;
}

function simulate(dateAxis, regimeSeries, weightsByBucket, assetSeries, tbillDaily, firstIdx, fixedWeights) {
  let equity = 1;
  let lastWeights = null;
  const equityCurve = [];
  const dailyEquity = [];
  const dailyReturns = [];
  let transitions = 0;
  let peak = 1;
  let maxDd = 0;
  let firstActiveIdx = -1;

  for (let i = firstIdx; i < dateAxis.length; i++) {
    const w = fixedWeights ? fixedWeights : (weightsByBucket && weightsByBucket[regimeSeries[i]]);
    if (!w) continue;
    if (firstActiveIdx < 0) firstActiveIdx = i;

    if (lastWeights != null) {
      const dailyTbill = Math.pow(1 + (tbillDaily[i - 1] || 0) / 100, 1 / 365) - 1;
      let portRet = (lastWeights.cash || 0) * dailyTbill;
      for (const [asset, ws] of Object.entries(lastWeights)) {
        if (asset === 'cash' || ws === 0) continue;
        const p0 = assetSeries[asset]?.[i - 1];
        const p1 = assetSeries[asset]?.[i];
        if (Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0) {
          portRet += ws * (p1 / p0 - 1);
        }
      }
      equity *= 1 + portRet;
      dailyReturns.push(portRet);
    }

    if (lastWeights != null && !sameWeights(lastWeights, w)) {
      const turnover = turnoverBetween(lastWeights, w);
      equity *= 1 - turnover * BACKTEST_COST_PER_REBALANCE;
      transitions++;
    }
    lastWeights = w;

    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;

    equityCurve.push({ date: dateAxis[i], value: equity });
    dailyEquity.push({ date: dateAxis[i], value: equity });
  }

  const startDate = dateAxis[firstActiveIdx >= 0 ? firstActiveIdx : firstIdx];
  const endDate = dateAxis[dateAxis.length - 1];
  const years = (new Date(endDate) - new Date(startDate)) / (365.25 * 86400 * 1000);
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;
  const mean = dailyReturns.reduce((s, v) => s + v, 0) / Math.max(1, dailyReturns.length);
  const variance =
    dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean * 365) / (sd * Math.sqrt(365)) : 0;

  const splitDate = BACKTEST_IN_SAMPLE_END;
  let isEquityStart = null;
  let isEquityEnd = null;
  let oosEquityStart = null;
  let oosEquityEnd = null;
  for (const pt of equityCurve) {
    if (isEquityStart == null) isEquityStart = pt.value;
    if (pt.date <= splitDate) isEquityEnd = pt.value;
    else {
      if (oosEquityStart == null) oosEquityStart = pt.value;
      oosEquityEnd = pt.value;
    }
  }
  const yearsIs = (new Date(splitDate) - new Date(startDate)) / (365.25 * 86400 * 1000);
  const yearsOos = (new Date(endDate) - new Date(splitDate)) / (365.25 * 86400 * 1000);
  const cagrIs =
    isEquityStart && isEquityEnd && yearsIs > 0 ? Math.pow(isEquityEnd / isEquityStart, 1 / yearsIs) - 1 : null;
  const cagrOos =
    oosEquityStart && oosEquityEnd && yearsOos > 0
      ? Math.pow(oosEquityEnd / oosEquityStart, 1 / yearsOos) - 1
      : null;

  const monthEnd = new Map();
  for (const pt of equityCurve) monthEnd.set(pt.date.slice(0, 7), pt);
  const downsampled = [...monthEnd.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    final_value: nullIfNaN(equity),
    cagr: nullIfNaN(cagr),
    cagr_in_sample: nullIfNaN(cagrIs),
    cagr_out_sample: nullIfNaN(cagrOos),
    sharpe: nullIfNaN(sharpe),
    max_drawdown: nullIfNaN(maxDd),
    transitions,
    n_days: dailyReturns.length,
    start_date: startDate,
    end_date: endDate,
    equity_curve: downsampled,
    _daily: dailyEquity,
  };
}

function stripDailyFromSnapshot(backtest) {
  if (!backtest) return backtest;
  const out = {};
  for (const [portfolioName, strategies] of Object.entries(backtest)) {
    out[portfolioName] = {};
    for (const [strategyName, v] of Object.entries(strategies)) {
      const { _daily, ...rest } = v;
      out[portfolioName][strategyName] = rest;
    }
  }
  return out;
}

function nullIfNaN(v) {
  return Number.isFinite(v) ? v : null;
}

module.exports = { computeCorrelations, computeBacktest, stripDailyFromSnapshot };

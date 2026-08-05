// VENDORED VERBATIM — see ../README.md for full provenance (issue #447).
// Source: robotmoney/robotmoney-site (fork of agentjuno/robotmoney)
// scripts/regime/lib/utils.js, blob sha
// 3ae7ea1859adfea0001506fcccc5322a8d6147e8, fetched/verified 2026-08-02.
// NO logic changes.
// Vendored verbatim for offline regeneration of independent-fidelity golden
// fixtures only — never imported by production or runtime code.
/**
 * Shared utilities for the regime detection pipeline.
 *
 * - atomic CSV append (write to .tmp, fsync, rename) so a mid-write crash
 *   never corrupts the long-format history file
 * - percentile rank over a rolling window
 * - simple stats (mean, stddev, sma, pearson correlation)
 * - inverse-correlation weighting from a panel's correlation matrix
 */

const fs = require('fs');
const path = require('path');

// ── filesystem ──────────────────────────────────────────────────────────────

function atomicWrite(filepath, contents) {
  const tmp = filepath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filepath);
}

function readCsv(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const text = fs.readFileSync(filepath, 'utf8').trim();
  if (!text) return [];
  const [header, ...rows] = text.split('\n');
  const cols = header.split(',');
  return rows.map((r) => {
    const v = r.split(',');
    const obj = {};
    cols.forEach((c, i) => (obj[c] = v[i]));
    return obj;
  });
}

function writeLongHistoryCsv(filepath, rows) {
  // rows: [{ date, indicator, value }]
  const lines = ['date,indicator,value'];
  for (const r of rows) lines.push(`${r.date},${r.indicator},${r.value}`);
  atomicWrite(filepath, lines.join('\n') + '\n');
}

// ── stats ───────────────────────────────────────────────────────────────────

function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stddev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

function sma(xs, n) {
  // NaN-tolerant simple moving average. Output[i] = mean of valid values in
  // xs[i-n+1..i]. Returns NaN if fewer than n/2 valid observations in the
  // window (so a window mostly composed of NaN doesn't produce a misleading
  // average from a single observation).
  const out = new Array(xs.length).fill(NaN);
  const minValid = Math.max(1, Math.floor(n / 2));
  // Maintain a running sum and valid-count over the trailing window.
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i])) {
      s += xs[i];
      c++;
    }
    if (i >= n) {
      const drop = xs[i - n];
      if (Number.isFinite(drop)) {
        s -= drop;
        c--;
      }
    }
    if (i >= n - 1 && c >= minValid) {
      out[i] = s / c;
    }
  }
  return out;
}

function pctChange(xs, lag) {
  const out = new Array(xs.length).fill(NaN);
  for (let i = lag; i < xs.length; i++) {
    if (xs[i - lag] === 0 || !Number.isFinite(xs[i - lag])) continue;
    out[i] = (xs[i] - xs[i - lag]) / xs[i - lag];
  }
  return out;
}

function rollingSum(xs, n) {
  // Strict rolling sum: output[i] = NaN if any value in xs[i-n+1..i] is NaN.
  // Use a zero-fill alignment if you want missing days to count as zero.
  const out = new Array(xs.length).fill(NaN);
  let s = 0;
  let nan = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i])) s += xs[i];
    else nan++;
    if (i >= n) {
      const drop = xs[i - n];
      if (Number.isFinite(drop)) s -= drop;
      else nan--;
    }
    if (i >= n - 1 && nan === 0) out[i] = s;
  }
  return out;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 3) return 0;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let num = 0,
    dx = 0,
    dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

// ── percentile rank over rolling window ─────────────────────────────────────

function rollingPercentileRank(xs, window) {
  // For each i, compute rank of xs[i] within xs[max(0, i-window+1)..i].
  // Returns value in [0, 1]. NaN until at least 30 observations available.
  const out = new Array(xs.length).fill(NaN);
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i])) continue;
    const start = Math.max(0, i - window + 1);
    const slice = [];
    for (let j = start; j <= i; j++) {
      if (Number.isFinite(xs[j])) slice.push(xs[j]);
    }
    if (slice.length < 30) continue;
    let below = 0;
    let equal = 0;
    for (const v of slice) {
      if (v < xs[i]) below++;
      else if (v === xs[i]) equal++;
    }
    out[i] = (below + 0.5 * equal) / slice.length;
  }
  return out;
}

// ── inverse-correlation panel weighting ────────────────────────────────────

function inverseCorrelationWeights(panel, minValidObs = 60, cap = 0.25) {
  // panel: { [indicatorId]: number[] } — sign-aligned percentile-rank series.
  // Indicators with fewer than `minValidObs` finite observations are excluded
  // (weight 0), so a failed fetcher can't accumulate phantom weight by
  // having near-zero correlation with everything.
  // After computing inverse-correlation weights, each indicator's weight is
  // capped at `cap` (default 25%) and the excess is redistributed proportionally
  // to the uncapped indicators, iterated to convergence. This prevents any
  // single indicator (typically a newly-added one with low panel correlation)
  // from dominating the panel just because inverse-correlation weighting favors
  // the most "different" series.
  const allIds = Object.keys(panel);
  const validIds = allIds.filter((id) => {
    let n = 0;
    for (const v of panel[id]) if (Number.isFinite(v)) n++;
    return n >= minValidObs;
  });

  const out = {};
  for (const id of allIds) out[id] = 0;
  if (validIds.length === 0) return out;
  if (validIds.length === 1) {
    out[validIds[0]] = 1;
    return out;
  }

  const corr = {};
  for (const a of validIds) {
    corr[a] = {};
    for (const b of validIds) {
      corr[a][b] = a === b ? 1 : pearson(panel[a], panel[b]);
    }
  }
  const avgAbs = {};
  for (const a of validIds) {
    let s = 0;
    let n = 0;
    for (const b of validIds) {
      if (a === b) continue;
      s += Math.abs(corr[a][b]);
      n++;
    }
    avgAbs[a] = n > 0 ? s / n : 0;
  }
  // weight ∝ 1 / avg |corr|. Floor at 0.05 to keep nearly-orthogonal indicators
  // from dominating numerically when avg corr happens to be ~0.
  const raw = {};
  let total = 0;
  for (const id of validIds) {
    const denom = Math.max(0.05, avgAbs[id]);
    raw[id] = 1 / denom;
    total += raw[id];
  }
  for (const id of validIds) out[id] = raw[id] / total;
  return capWeights(out, cap);
}

function capWeights(weights, cap) {
  if (!(cap > 0 && cap < 1)) return weights;
  let result = { ...weights };
  const ids = Object.keys(result);
  for (let iter = 0; iter < 20; iter++) {
    const overCap = ids.filter((id) => result[id] > cap + 1e-9);
    if (overCap.length === 0) break;
    const underCap = ids.filter((id) => !overCap.includes(id) && result[id] > 0);
    if (underCap.length === 0) break; // cap infeasible (too few indicators); leave as-is
    const excess = overCap.reduce((s, id) => s + (result[id] - cap), 0);
    const underSum = underCap.reduce((s, id) => s + result[id], 0);
    const next = { ...result };
    for (const id of overCap) next[id] = cap;
    for (const id of underCap) next[id] = result[id] * (1 + excess / underSum);
    result = next;
  }
  return result;
}

// ── date helpers ────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function alignDailyForwardFill(series, allDates) {
  // series: [{ date, value }] sorted ascending. Returns array aligned to allDates,
  // forward-filling missing days. Returns NaN before the first observation.
  const map = new Map(series.map((p) => [p.date, p.value]));
  const out = [];
  let last = NaN;
  for (const d of allDates) {
    if (map.has(d)) last = map.get(d);
    out.push(last);
  }
  return out;
}

function alignDailyZeroFill(series, allDates) {
  // For flow indicators (e.g. ETF net flows): days between observations should
  // count as 0 (no trading = no flow), but pre-history should remain NaN so
  // a fetcher failure cannot masquerade as a long stretch of zero-flow days.
  const map = new Map(series.map((p) => [p.date, p.value]));
  const out = [];
  let seen = false;
  for (const d of allDates) {
    if (map.has(d)) {
      seen = true;
      out.push(map.get(d));
    } else {
      out.push(seen ? 0 : NaN);
    }
  }
  return out;
}

function buildDateAxis(startIso, endIso) {
  const out = [];
  const cur = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  while (cur <= end) {
    out.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

module.exports = {
  atomicWrite,
  readCsv,
  writeLongHistoryCsv,
  mean,
  stddev,
  sma,
  pctChange,
  rollingSum,
  pearson,
  rollingPercentileRank,
  inverseCorrelationWeights,
  isoDate,
  daysBetween,
  alignDailyForwardFill,
  alignDailyZeroFill,
  buildDateAxis,
  mergeSeries,
};

/**
 * Append-only merge for a daily indicator series.
 *
 *   - `prior`: existing rows from the persisted CSV. The FLOOR. Every date in
 *     here survives into the result, regardless of whether the fetch returned
 *     anything for it. This is what makes the pipeline append-only.
 *   - `fetched`: today's fresh rows from the source. New dates get added;
 *     dates that already exist in `prior` get UPDATED with the fetched value
 *     (so legitimate source revisions land), but the row is never deleted.
 *
 * Both inputs are arrays of `{date, value}` with ISO date strings. Output is
 * date-sorted ascending with no duplicates. Pure function — does no I/O.
 */
function mergeSeries(prior, fetched) {
  const byDate = new Map();
  if (Array.isArray(prior)) {
    for (const p of prior) {
      if (!p || !p.date || !Number.isFinite(p.value)) continue;
      byDate.set(p.date, p.value);
    }
  }
  if (Array.isArray(fetched)) {
    for (const p of fetched) {
      if (!p || !p.date || !Number.isFinite(p.value)) continue;
      // Fetched wins on overlap so source corrections / revisions land.
      // The row itself is never removed — only its value can be replaced.
      byDate.set(p.date, p.value);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));
}

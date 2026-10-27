// Shared, pure analytics math. Used by every tool (regime + research) so the
// normalization is identical across the suite. No I/O, no data-source knowledge.
//
// ── WARNING: four semantic-smoke-twin export pairs live in this one file ─────────
// Each pair below has a v0-faithful port and a look-alike with a SHORTER,
// more attractive name and DIFFERENT semantics (A1 finding F5; full
// discussion + EXECUTED divergence numbers:
// docs/audits/v0-v1-parity/A1-regime-core-procedures.md finding F5, and
// docs/technical/regime-engine.md §7). No current regime-core or research
// call site uses the wrong smoke-twin — the risk is prospective, for the next
// person autocompleting an import.
//
//   mean (0 for empty)                      vs  exact.ts mean2 (NaN for empty)
//     The v0-faithful port (lib/utils.js `mean`) was the private meanArr;
//     stddev/pearson now use the compensated mean2 from exact.ts, which keeps
//     its NaN-for-empty contract. `mean` is a lighter helper for the
//     research/seed-provider code (rollingBeta, etc.) with no v0 analogue.
//   std (:~24, POPULATION σ)                vs  stddev (:~94, SAMPLE σ, n-1)
//     stddev is the v0-faithful port (lib/utils.js `stddev`); the regime
//     core's smoothRegimes 2σ fast-track depends on the SAMPLE form. `std` has
//     no v0 analogue and no regime-core consumer today.
//   pctChange(xs) (:~41, length-shortening,  vs  pctChangeLag(xs, lag) (:~127,
//     0 on zero denominator)                     length-preserving, NaN pad,
//                                                 skips zero/non-finite denom)
//     pctChangeLag is the v0-faithful port (lib/utils.js `pctChange(xs,lag)`,
//     renamed only to avoid clobbering `pctChange` here) — consumed by both
//     the regime core's transform layer and research-signals.ts. `pctChange`
//     is a lighter research/seed-provider helper with no v0 analogue.
//   percentileInWindow(v, window) (:~33,     vs  rollingPercentileRank(xs, w)
//     `<= count / n`, NO tie-split, 0.5           (:~178, `(below+0.5*equal)/n`
//     for n<=1, full-sample, NOT point-in-time)    mid-rank, 30-obs warm-up,
//                                                   point-in-time ROLLING)
//     rollingPercentileRank is the v0-faithful port (lib/utils.js
//     `rollingPercentileRank`) and is what the regime core (analyze/
//     compute.ts) AND both production research signals (research-signals.ts,
//     since issue #465's R7 fix) consume. percentileInWindow is EXTRA — no v0
//     analogue — and its only consumer repo-wide is the DEAD
//     analyze/regime.ts (`regimeTool`); see docs/technical/regime-engine.md
//     §7 and docs/technical/research-signals.md §2.
// ─────────────────────────────────────────────────────────────────────────
//
// Accuracy (proposed decision D78): every reduction in this file (mean, std,
// stddev, pearson, rollingBeta, sma, rollingSum, the weight sums) is compensated
// through ./exact.ts, so on finite data it returns the correctly rounded value
// of the exact result for the binary64 inputs, not the plain loop's last bits.
// Edge-case contracts (empty input, n < 2, non-finite handling, zero variance)
// are unchanged.
import {
  centeredCrossDD,
  correlation,
  ddAdd,
  ddDiv,
  ddDivD,
  ddMulD,
  ddValue,
  mean2,
  stdDD,
  sum2,
  sumDD,
} from "./exact.ts";

export function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// 0 for empty input. A non-finite value gives the plain sum's NaN or ±Infinity.
export function mean(xs: number[]): number {
  return xs.length ? mean2(xs) : 0;
}

// Population σ. 0 for fewer than two values; NaN when any value is non-finite.
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  if (!xs.every(Number.isFinite)) return NaN;
  return ddValue(stdDD(xs, 0));
}

// Fraction of `window` values <= value (0..1).
export function percentileInWindow(value: number, window: number[]): number {
  if (window.length <= 1) return 0.5;
  return window.filter((x) => x <= value).length / window.length;
}

// Sign-adjust a 0..1 percentile into a risk-on score (sign -1 inverts).
export const applySign = (pct: number, sign: 1 | -1) => (sign === 1 ? pct : 1 - pct);

export function pctChange(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i - 1] ? xs[i] / xs[i - 1] - 1 : 0);
  return out;
}

export function ratio(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(b[i] ? a[i] / b[i] : 0);
  return out;
}

// OLS slope of y on x over the last `window` paired points (rolling beta).
// 0 when x has zero variance (or no points); NaN when a value is non-finite.
export function rollingBeta(y: number[], x: number[], window: number): number {
  const n = Math.min(y.length, x.length);
  const ys = y.slice(n - window), xs = x.slice(n - window);
  if (xs.length === 0) return 0;
  if (!xs.every(Number.isFinite)) return NaN;
  const mx = mean2(xs);
  const varx = centeredCrossDD(xs, xs, mx, mx);
  if (varx[0] === 0) return 0;
  if (ys.length !== xs.length || !ys.every(Number.isFinite)) return NaN;
  return ddValue(ddDiv(centeredCrossDD(xs, ys, mx, mean2(ys)), varx));
}

// Date string `daysAgo` before an ISO YYYY-MM-DD (no Date.now()).
export function dateBefore(asof: string, daysAgo: number): string {
  const [y, m, d] = asof.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - daysAgo * 86400_000).toISOString().slice(0, 10);
}

// Epoch milliseconds → ISO YYYY-MM-DD (UTC). Shared by the extract parsers (which
// key raw upstream rows by day) and the transform grid (which dates dense days).
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Regime pipeline math — ported VERBATIM (JS → TS) from
// agentjuno/robotmoney scripts/regime/lib/utils.js. Algorithm + constants
// preserved exactly so our analytics reproduce the original's committed numbers.
// These coexist with the lighter helpers above (do not collide): the original
// `pctChange(xs, lag)` is exported here as `pctChangeLag` to avoid clobbering
// the existing length-shortening `pctChange`.
// ─────────────────────────────────────────────────────────────────────────────

// Sample standard deviation (n-1). NaN for <2 values or any non-finite value.
export function stddev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  if (!xs.every(Number.isFinite)) return NaN;
  return ddValue(stdDD(xs, 1));
}

// NaN-tolerant simple moving average. Output[i] = mean of valid values in
// xs[i-n+1..i]. Returns NaN if fewer than floor(n/2) valid observations.
// Each window is summed afresh (compensated), so there is no running
// add/subtract drift; the valid-count bookkeeping is a running integer.
export function sma(xs: number[], n: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  const minValid = Math.max(1, Math.floor(n / 2));
  let c = 0;
  const win: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i])) c++;
    if (i >= n && Number.isFinite(xs[i - n])) c--;
    if (i >= n - 1 && c >= minValid) {
      win.length = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) if (Number.isFinite(xs[j])) win.push(xs[j]);
      out[i] = ddValue(ddDivD(sumDD(win), c));
    }
  }
  return out;
}

// `pctChange(xs, lag)` from the original (length-preserving, NaN-padded).
export function pctChangeLag(xs: number[], lag: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  for (let i = lag; i < xs.length; i++) {
    if (xs[i - lag] === 0 || !Number.isFinite(xs[i - lag])) continue;
    out[i] = (xs[i] - xs[i - lag]) / xs[i - lag];
  }
  return out;
}

// Strict rolling sum: output[i] = NaN if any value in xs[i-n+1..i] is NaN.
// Each window is summed afresh (compensated): no running add/subtract drift.
export function rollingSum(xs: number[], n: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  let nan = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i])) nan++;
    if (i >= n && !Number.isFinite(xs[i - n])) nan--;
    if (i >= n - 1 && nan === 0) out[i] = sum2(xs.slice(Math.max(0, i - n + 1), i + 1));
  }
  return out;
}

// Pearson correlation over pairwise-finite points. <3 pairs → 0; zero variance → 0.
// Compensated and scale-safe (exact.ts correlation): each series is rescaled by
// a power of two first, so the products neither overflow nor underflow.
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      a.push(xs[i]);
      b.push(ys[i]);
    }
  }
  if (a.length < 3) return 0;
  const r = correlation(a, b);
  return Number.isNaN(r) ? 0 : r;
}

// For each i, rank of xs[i] within xs[max(0,i-window+1)..i]. Value in [0,1].
// NaN until at least 30 finite observations available. rank=(below+0.5·equal)/n.
export function rollingPercentileRank(xs: number[], window: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i])) continue;
    const start = Math.max(0, i - window + 1);
    const slice: number[] = [];
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

// Inverse-correlation panel weighting. panel: { id: number[] } of sign-aligned
// percentile-rank series. Indicators with <minValidObs finite obs are excluded
// (weight 0). weight ∝ 1/max(0.05, avg|corr|), normalized, then capped (cap,
// proportional redistribution, ≤20 iters).
export function inverseCorrelationWeights(
  panel: Record<string, number[]>,
  minValidObs = 60,
  cap = 0.25,
): Record<string, number> {
  const allIds = Object.keys(panel);
  const validIds = allIds.filter((id) => {
    let n = 0;
    for (const v of panel[id]) if (Number.isFinite(v)) n++;
    return n >= minValidObs;
  });

  const out: Record<string, number> = {};
  for (const id of allIds) out[id] = 0;
  if (validIds.length === 0) return out;
  if (validIds.length === 1) {
    out[validIds[0]] = 1;
    return out;
  }

  const corr: Record<string, Record<string, number>> = {};
  for (const a of validIds) {
    corr[a] = {};
    for (const b of validIds) {
      corr[a][b] = a === b ? 1 : pearson(panel[a], panel[b]);
    }
  }
  const avgAbs: Record<string, number> = {};
  for (const a of validIds) {
    const abs: number[] = [];
    for (const b of validIds) {
      if (a === b) continue;
      abs.push(Math.abs(corr[a][b]));
    }
    avgAbs[a] = abs.length > 0 ? ddValue(ddDivD(sumDD(abs), abs.length)) : 0;
  }
  const raw: Record<string, number> = {};
  for (const id of validIds) {
    const denom = Math.max(0.05, avgAbs[id]);
    raw[id] = 1 / denom;
  }
  const total = sumDD(validIds.map((id) => raw[id]));
  for (const id of validIds) out[id] = ddValue(ddDiv([raw[id], 0], total));
  return capWeights(out, cap);
}

export function capWeights(
  weights: Record<string, number>,
  cap: number,
): Record<string, number> {
  if (!(cap > 0 && cap < 1)) return weights;
  let result: Record<string, number> = { ...weights };
  const ids = Object.keys(result);
  for (let iter = 0; iter < 20; iter++) {
    const overCap = ids.filter((id) => result[id] > cap + 1e-9);
    if (overCap.length === 0) break;
    const underCap = ids.filter((id) => !overCap.includes(id) && result[id] > 0);
    if (underCap.length === 0) break; // cap infeasible; leave as-is
    // excess = sum(w - cap) over the capped ids, kept exact pair by pair.
    const excess = sumDD(overCap.flatMap((id) => [result[id], -cap]));
    const underSum = sumDD(underCap.map((id) => result[id]));
    const next: Record<string, number> = { ...result };
    for (const id of overCap) next[id] = cap;
    // w * (1 + excess / underSum), with the scale factor formed in double-double.
    const q = ddDiv(excess, underSum);
    for (const id of underCap) {
      const w = result[id];
      next[id] = ddValue(ddAdd([w, 0], ddMulD(q, w)));
    }
    result = next;
  }
  return result;
}

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// series: [{date,value}] ascending. Aligned to allDates, forward-filling missing
// days; NaN before the first observation.
export function alignDailyForwardFill(
  series: { date: string; value: number }[],
  allDates: string[],
): number[] {
  const map = new Map(series.map((p) => [p.date, p.value]));
  const out: number[] = [];
  let last = NaN;
  for (const d of allDates) {
    if (map.has(d)) last = map.get(d)!;
    out.push(last);
  }
  return out;
}

// #402: the single documented maximum age (in days) a forward-filled value may
// be carried before it is considered "dead" and must stop contributing to panel
// weights / the composite. Chosen to comfortably clear the slowest legitimate
// registry cadence (SHILLER_CAPE is monthly, ~30-35d between real prints, plus
// scrape/holiday slack) while still catching an indicator whose upstream feed
// has actually gone dark for multiple reporting cycles. Consumed by
// computeRegime (compute.ts) via the `ages` it receives from forwardFillAge —
// alignDailyForwardFill itself is intentionally left unchanged above so the
// regime-fidelity byte-identical-replay tests keep reproducing the original
// (uncapped) JS pipeline exactly.
export const MAX_FORWARD_FILL_DAYS = 120;

// Companion to alignDailyForwardFill: for each date in `allDates`, the number of
// days since the value being carried forward was last a REAL observation (0 on
// a day with a real print; NaN before the first observation ever seen). A
// resumed real observation resets the age to 0 immediately — recovery is not a
// separate code path, just the next date where age is 0 again.
export function forwardFillAge(
  series: { date: string; value: number }[],
  allDates: string[],
): number[] {
  const dates = new Set(series.map((p) => p.date));
  const out: number[] = [];
  let lastRealIdx = -1;
  for (let i = 0; i < allDates.length; i++) {
    if (dates.has(allDates[i])) lastRealIdx = i;
    out.push(lastRealIdx === -1 ? NaN : i - lastRealIdx);
  }
  return out;
}

// Days between observations count as 0 (no flow); pre-history stays NaN.
export function alignDailyZeroFill(
  series: { date: string; value: number }[],
  allDates: string[],
): number[] {
  const map = new Map(series.map((p) => [p.date, p.value]));
  const out: number[] = [];
  let seen = false;
  for (const d of allDates) {
    if (map.has(d)) {
      seen = true;
      out.push(map.get(d)!);
    } else {
      out.push(seen ? 0 : NaN);
    }
  }
  return out;
}

export function buildDateAxis(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const cur = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIso + "T00:00:00Z");
  while (cur <= end) {
    out.push(isoDateUTC(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Append-only merge of a daily indicator series. `prior` is the floor (every
// date survives); `fetched` wins on overlap. Both [{date,value}]. Output is
// date-sorted ascending, deduped. Pure.
//
// INPUT RULE (two layers, deliberate): parse is STRICT, merge is TOLERANT.
//   - src/input/load.ts (user-facing boundary) throws InputRowError on a
//     non-finite value so analysts are told about bad data.
//   - mergeSeries (backend ingest) silently DROPS non-finite values and rows
//     without a date, because upstream providers emit holes; a dropped fetched
//     hole leaves the persisted floor value for that date intact.
// For every input both layers accept (finite values, any duplicates, any
// order) the series are identical: the LAST row wins (fetched after prior),
// ascending by date (ISO days sort identically under any locale). Pinned by
// tests/input-rule.test.ts and backend/tests/input-rule-parity.test.ts.
export function mergeSeries(
  prior: { date: string; value: number }[],
  fetched: { date: string; value: number }[],
): { date: string; value: number }[] {
  const byDate = new Map<string, number>();
  if (Array.isArray(prior)) {
    for (const p of prior) {
      if (!p || !p.date || !Number.isFinite(p.value)) continue;
      byDate.set(p.date, p.value);
    }
  }
  if (Array.isArray(fetched)) {
    for (const p of fetched) {
      if (!p || !p.date || !Number.isFinite(p.value)) continue;
      byDate.set(p.date, p.value);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));
}

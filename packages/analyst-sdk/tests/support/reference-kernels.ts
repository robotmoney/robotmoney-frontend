// Verbatim copies of rollingPercentileRank, inverseCorrelationWeights and
// pearson as they stood before issue 1667 made them fast. They are the
// equality reference for tests/rank-weights-equivalence.test.ts and the
// timing baseline for scripts/bench-regime-kernels.ts. Never edit the bodies.
import { correlation, ddDiv, ddDivD, ddValue, sumDD } from "../../src/transform/exact.ts";
import { capWeights } from "../../src/transform/math.ts";

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


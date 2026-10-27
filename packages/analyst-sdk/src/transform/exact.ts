// Error-free arithmetic for the SDK's reductions (proposed decision D78 in docs/decisions.md).
//
// Every sum, mean, variance, dot product and compounding product that feeds a
// published number is computed as if in twice the working precision and rounded
// once at the end, so on real data it equals the correctly rounded exact value
// of the binary64 inputs. Pure, dependency-free, no I/O.
//
// Building blocks: TwoSum (Knuth) and Dekker's TwoProd with a Veltkamp split are
// error-free (s + e equals a + b exactly; p + e equals a * b exactly, barring
// over/underflow). Sum2 and Dot2 (Ogita, Rump and Oishi, "Accurate Sum and Dot
// Product", SIAM J. Sci. Comput. 26, 2005) give the result of the plain loop run
// in double-double. A double-double (DD) is an unevaluated pair hi + lo with
// |lo| <= ulp(hi)/2; the few DD operations here finish a division, root or
// product without a second rounding.
//
// Non-finite inputs: the hi word of Sum2 is exactly the plain left-to-right
// sum, so when it is not finite the plain result is returned. Callers keep their
// own non-finite contracts on top of that.
//
// Ported from rosemarys-baby src/lib/exact.ts, where the same functions are
// checked against an exact BigInt rational reference on real returns.

/** A double-double: the unevaluated sum hi + lo, |lo| <= ulp(hi) / 2. */
export type DD = readonly [number, number];

/** Error-free sum: s + e equals a + b exactly, s = fl(a + b). */
export function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}

/** Veltkamp split of a double into two non-overlapping 26-bit halves. */
function split(a: number): [number, number] {
  const c = 134217729 * a; // 2^27 + 1
  const hi = c - (c - a);
  return [hi, a - hi];
}

/** Error-free product (Dekker): p + e equals a * b exactly, p = fl(a * b), barring over/underflow. */
export function twoProd(a: number, b: number): [number, number] {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, al * bl - (p - ah * bh - al * bh - ah * bl)];
}

/** The double nearest a double-double. */
export const ddValue = (a: DD): number => a[0] + a[1];

/** Compensated sum (Sum2) as an unrounded double-double, fixed left-to-right order. */
export function sumDD(xs: readonly number[]): DD {
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    const [t, e] = twoSum(s, xs[i]!);
    s = t;
    c += e;
  }
  if (!Number.isFinite(s)) return [s, 0];
  return twoSum(s, c);
}

/** Compensated sum (Sum2), rounded once. */
export const sum2 = (xs: readonly number[]): number => ddValue(sumDD(xs));

/** Compensated dot product (Dot2) as an unrounded double-double. */
export function dotDD(a: readonly number[], b: readonly number[]): DD {
  let p = 0;
  let c = 0;
  let plain = 0;
  for (let i = 0; i < a.length; i++) {
    const [h, r] = twoProd(a[i]!, b[i]!);
    const [s, q] = twoSum(p, h);
    p = s;
    c += q + r;
    plain += a[i]! * b[i]!;
  }
  if (!Number.isFinite(p) || !Number.isFinite(c)) return [plain, 0];
  return twoSum(p, c);
}

/** a + b for double-doubles. */
export function ddAdd(a: DD, b: DD): DD {
  const [s, e] = twoSum(a[0], b[0]);
  return twoSum(s, e + a[1] + b[1]);
}

/** a * b for double-doubles. */
export function ddMul(a: DD, b: DD): DD {
  const [p, pe] = twoProd(a[0], b[0]);
  return twoSum(p, pe + a[0] * b[1] + a[1] * b[0]);
}

/** a * d for a double-double a and a double d. */
export function ddMulD(a: DD, d: number): DD {
  const [p, pe] = twoProd(a[0], d);
  return twoSum(p, pe + a[1] * d);
}

/** a / d for a double-double a and a double d. */
export function ddDivD(a: DD, d: number): DD {
  const q1 = a[0] / d;
  if (!Number.isFinite(q1) || q1 === 0) return [q1, 0];
  const [p, pe] = twoProd(q1, d);
  return twoSum(q1, (a[0] - p - pe + a[1]) / d);
}

/** a / b for double-doubles, as a double-double. */
export function ddDiv(a: DD, b: DD): DD {
  const q1 = a[0] / b[0];
  if (!Number.isFinite(q1) || q1 === 0) return [q1, 0];
  const [p, pe] = twoProd(q1, b[0]);
  const rem = a[0] - p - pe + a[1] - q1 * b[1];
  return twoSum(q1, rem / b[0]);
}

/** sqrt(a) for a double-double a >= 0. */
export function ddSqrt(a: DD): DD {
  const s = Math.sqrt(a[0]);
  if (s === 0 || !Number.isFinite(s)) return [s, 0];
  const [p, pe] = twoProd(s, s);
  return twoSum(s, (a[0] - p - pe + a[1]) / (2 * s));
}

/** Compensated mean: Sum2 kept in double-double, divided once. NaN for empty input. */
export function meanDD(xs: readonly number[]): DD {
  return ddDivD(sumDD(xs), xs.length);
}

/** Compensated mean, rounded once. NaN for empty input. */
export const mean2 = (xs: readonly number[]): number => ddValue(meanDD(xs));

/**
 * Centered cross-product sum_t (x_t - mx)(y_t - my) by the corrected two-pass
 * algorithm with every step compensated: each centering difference is kept as
 * an exact (hi, lo) pair, the products are accumulated error-free, and the
 * leftover first-order term -(sum d)(sum e)/n removes the effect of mx and my
 * being rounded means. Finite inputs only.
 */
export function centeredCrossDD(x: readonly number[], y: readonly number[], mx = mean2(x), my = mean2(y)): DD {
  const n = x.length;
  let p = 0;
  let c = 0;
  let ds = 0;
  let dc = 0;
  let es = 0;
  let ec = 0;
  const acc = (a: number, b: number): void => {
    const [h, r] = twoProd(a, b);
    const [s, q] = twoSum(p, h);
    p = s;
    c += q + r;
  };
  const addD = (v: number): void => {
    const [s, e] = twoSum(ds, v);
    ds = s;
    dc += e;
  };
  const addE = (v: number): void => {
    const [s, e] = twoSum(es, v);
    es = s;
    ec += e;
  };
  for (let t = 0; t < n; t++) {
    const [dh, dl] = twoSum(x[t]!, -mx);
    const [eh, el] = twoSum(y[t]!, -my);
    acc(dh, eh);
    acc(dh, el);
    acc(dl, eh);
    addD(dh);
    addD(dl);
    addE(eh);
    addE(el);
  }
  const corr = n > 0 ? ((ds + dc) * (es + ec)) / n : 0;
  return twoSum(p, c - corr);
}

/** The power of two that brings max |x| into [1, 2); 1 when every value is zero. Finite inputs only. */
export function scaleOf(xs: readonly number[]): number {
  let m = 0;
  for (const x of xs) {
    const a = Math.abs(x);
    if (a > m) m = a;
  }
  if (m === 0) return 1;
  let e = Math.floor(Math.log2(m));
  // log2 can be off by one near a power of two; correct so that m / 2^e lies in [1, 2).
  if (m / 2 ** e >= 2) e++;
  else if (m / 2 ** e < 1) e--;
  return 2 ** e;
}

/** xs divided by scaleOf(xs): exact (a power of two), so ratios such as a correlation are unchanged. */
function rescaled(xs: readonly number[], s: number): number[] {
  // Two steps when 1 / s itself would overflow or underflow.
  if (s >= 2 ** -1000 && s <= 2 ** 1000) {
    const inv = 1 / s;
    return xs.map((x) => x * inv);
  }
  const r = Math.sqrt(s);
  return xs.map((x) => x / r / (s / r));
}

/**
 * Sample (ddof = 1) or population (ddof = 0) standard deviation of finite
 * values as a double-double. The values are rescaled by a power of two first,
 * so neither the products overflow nor their errors underflow; the root of the
 * double-double variance is rounded once at the end.
 */
export function stdDD(xs: readonly number[], ddof: number): DD {
  const s = scaleOf(xs);
  const ys = s === 1 ? (xs as number[]) : rescaled(xs, s);
  const r = ddSqrt(ddDivD(centeredCrossDD(ys, ys), xs.length - ddof));
  return s === 1 ? r : [r[0] * s, r[1] * s];
}

/**
 * The three centered sums sxx, syy, sxy of two equal-length finite series in
 * one pass, by the same corrected two-pass scheme as centeredCrossDD. Each
 * deviation d = x - mx is an exact pair (dh, dl); the leading products dh*dh,
 * eh*eh, dh*eh are error-free (Dekker, sharing one split per deviation) and the
 * second-order terms dh*el + dl*eh, of relative size eps, are added plainly:
 * their rounding is eps^2-relative, the same order as the double-double itself.
 */
function centeredMoments(x: readonly number[], y: readonly number[], mx: number, my: number): { sxx: DD; syy: DD; sxy: DD } {
  const n = x.length;
  let pxx = 0, cxx = 0, pyy = 0, cyy = 0, pxy = 0, cxy = 0;
  let ds = 0, dc = 0, es = 0, ec = 0;
  for (let t = 0; t < n; t++) {
    // d = x - mx exactly, as dh + dl (TwoSum, inlined).
    const xv = x[t]!;
    const dh = xv - mx;
    let bb = dh - xv;
    const dl = xv - (dh - bb) + (-mx - bb);
    const yv = y[t]!;
    const eh = yv - my;
    bb = eh - yv;
    const el = yv - (eh - bb) + (-my - bb);
    // Veltkamp splits of dh and eh, shared by the three products.
    let c = 134217729 * dh;
    const dhh = c - (c - dh);
    const dhl = dh - dhh;
    c = 134217729 * eh;
    const ehh = c - (c - eh);
    const ehl = eh - ehh;
    // dh*dh
    let p = dh * dh;
    let pe = dhl * dhl - (p - dhh * dhh - 2 * dhh * dhl);
    let s = pxx + p;
    bb = s - pxx;
    cxx += pxx - (s - bb) + (p - bb) + pe + 2 * dh * dl;
    pxx = s;
    // eh*eh
    p = eh * eh;
    pe = ehl * ehl - (p - ehh * ehh - 2 * ehh * ehl);
    s = pyy + p;
    bb = s - pyy;
    cyy += pyy - (s - bb) + (p - bb) + pe + 2 * eh * el;
    pyy = s;
    // dh*eh
    p = dh * eh;
    pe = dhl * ehl - (p - dhh * ehh - dhl * ehh - dhh * ehl);
    s = pxy + p;
    bb = s - pxy;
    cxy += pxy - (s - bb) + (p - bb) + pe + (dh * el + dl * eh);
    pxy = s;
    // Compensated sums of the deviations, for the centering correction.
    s = ds + dh;
    bb = s - ds;
    dc += ds - (s - bb) + (dh - bb) + dl;
    ds = s;
    s = es + eh;
    bb = s - es;
    ec += es - (s - bb) + (eh - bb) + el;
    es = s;
  }
  const sd = ds + dc;
  const se = es + ec;
  return {
    sxx: twoSum(pxx, cxx - (sd * sd) / n),
    syy: twoSum(pyy, cyy - (se * se) / n),
    sxy: twoSum(pxy, cxy - (sd * se) / n),
  };
}

/**
 * Pearson correlation of two equal-length finite series, or NaN when either
 * has zero variance. Each series is rescaled by a power of two first (exact, so
 * the value is unchanged) so the result is right at any magnitude; the
 * centered sums are compensated and the denominator sqrt(vx) * sqrt(vy) is
 * formed in double-double, so it is rounded once. Clipped to [-1, 1].
 */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const sx = scaleOf(xs);
  const sy = scaleOf(ys);
  const a = sx === 1 ? (xs as number[]) : rescaled(xs, sx);
  const b = sy === 1 ? (ys as number[]) : rescaled(ys, sy);
  const { sxx, syy, sxy } = centeredMoments(a, b, mean2(a), mean2(b));
  if (!(sxx[0] > 0) || !(syy[0] > 0)) return NaN;
  const r = ddValue(ddDiv(sxy, ddMul(ddSqrt(sxx), ddSqrt(syy))));
  return r < -1 ? -1 : r > 1 ? 1 : r;
}

/**
 * Daily rate from an annual one, rate_daily = (1 + annual)^(1/periods) - 1,
 * evaluated as expm1(log1p(annual) / periods) so the small result keeps its
 * leading digits (the pow form loses them to the final subtraction of 1).
 */
export const periodicRate = (annual: number, periods: number): number => Math.expm1(Math.log1p(annual) / periods);

/**
 * Annualized growth from an equity ratio, ratio^(1/years) - 1, as
 * expm1(log(ratio) / years). The ratio may be passed as a double-double; its
 * low word enters the logarithm to first order.
 */
export function annualizedGrowth(ratio: DD | number, years: number): number {
  const [hi, lo] = typeof ratio === "number" ? [ratio, 0] : ratio;
  const l = lo === 0 || !Number.isFinite(hi) || hi <= 0 ? Math.log(hi) : Math.log(hi) + lo / hi;
  return Math.expm1(l / years);
}

/**
 * A compounding equity index held unrounded as a double-double. `grow(r)`
 * multiplies by (1 + r) with the factor formed exactly by twoSum. `value` is the correctly rounded current level.
 */
export class Compounder {
  private hi: number;
  private lo = 0;
  constructor(start = 1) {
    this.hi = start;
  }
  grow(r: number): void {
    this.mul(twoSum(1, r));
  }
  /** Multiply by (1 + r) for a double-double r (for example an unrounded mean). */
  growDD(r: DD): void {
    const [s, e] = twoSum(1, r[0]);
    this.mul(twoSum(s, e + r[1]));
  }
  /** Multiply by (1 - a * b), with the product a * b kept exact. */
  shrinkByProduct(a: number, b: number): void {
    const [p, pe] = twoProd(a, b);
    const [s, e] = twoSum(1, -p);
    this.mul(twoSum(s, e - pe));
  }
  private mul(f: DD): void {
    if (!Number.isFinite(this.hi) || !Number.isFinite(f[0])) {
      this.hi *= f[0];
      this.lo = 0;
      return;
    }
    const r = ddMul([this.hi, this.lo], f);
    if (!Number.isFinite(r[0]) || !Number.isFinite(r[1])) {
      this.hi = this.hi * f[0];
      this.lo = 0;
      return;
    }
    this.hi = r[0];
    this.lo = r[1];
  }
  get dd(): DD {
    return [this.hi, this.lo];
  }
  get value(): number {
    return this.hi + this.lo;
  }
}

/**
 * Annualized Sharpe ratio mean / sd * sqrt(periods), from double-double mean
 * and standard deviation, rounded once. sd must be positive.
 */
export function sharpeDD(mean: DD, sd: DD, periods: number): number {
  return ddValue(ddMul(ddDiv(mean, sd), ddSqrt([periods, 0])));
}

/**
 * Mean and sample standard deviation of a return series, for Sharpe ratios.
 * Finite inputs give compensated double-doubles; any non-finite input gives
 * NaN for both (what the plain loops returned).
 */
export function meanAndSampleSd(xs: readonly number[]): { mean: DD; sd: DD } {
  for (const x of xs) if (!Number.isFinite(x)) return { mean: [NaN, 0], sd: [NaN, 0] };
  const mean = meanDD(xs);
  if (xs.length < 2) return { mean, sd: [xs.length === 1 ? 0 : NaN, 0] };
  return { mean, sd: stdDD(xs, 1) };
}

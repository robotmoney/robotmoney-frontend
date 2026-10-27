// Test-only exact reference: every finite double is an integer multiple of
// 2^-1074, so sums, products and centered cross-products of doubles are exact
// BigInt integers, and a ratio of them is rounded to a double exactly once
// (ties to even). The SDK's compensated arithmetic (src/transform/exact.ts) is
// judged against these values, never against another floating-point code.
// Ported from rosemarys-baby src/lib/exact.ts (its "exact-rational reference").
const SCALE_BITS = 1074n; // every finite double is an integer multiple of 2^-1074

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

/** The double as an integer count of 2^-1074. Throws on NaN or infinity. */
export function toScaled(x: number): bigint {
  if (!Number.isFinite(x)) throw new Error(`exact reference needs finite input, got ${x}`);
  f64[0] = x;
  const bits = u64[0]!;
  const neg = bits >> 63n === 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  const m = exp === 0 ? frac : frac | (1n << 52n);
  const e = exp === 0 ? 0n : BigInt(exp - 1);
  const v = m << e;
  return neg ? -v : v;
}

const abs = (a: bigint): bigint => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
const bitLength = (a: bigint): number => (a === 0n ? 0 : abs(a).toString(2).length);

/** An exact rational, always normalised: positive denominator, lowest terms. */
export class Q {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error("division by zero in exact reference");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static of(x: number): Q {
    return new Q(toScaled(x), 1n << SCALE_BITS);
  }
  add(o: Q): Q {
    return new Q(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return new Q(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return new Q(this.n * o.n, this.d * o.d);
  }
  div(o: Q): Q {
    return new Q(this.n * o.d, this.d * o.n);
  }
  neg(): Q {
    return new Q(-this.n, this.d);
  }
  isZero(): boolean {
    return this.n === 0n;
  }
  cmpAbs(o: Q): number {
    const a = abs(this.n) * o.d;
    const b = abs(o.n) * this.d;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  /** Correctly rounded (nearest, ties to even) conversion to a double. */
  toNumber(): number {
    return ratioToNumber(this.n, this.d);
  }
}

/** Correctly rounded `n / d` as a double. */
export function ratioToNumber(n: bigint, d: bigint): number {
  if (n === 0n) return 0;
  const neg = n < 0n !== d < 0n;
  n = abs(n);
  d = abs(d);
  const shift = 66 - (bitLength(n) - bitLength(d)); // quotient gets 66 or 67 bits
  let q: bigint;
  let r: bigint;
  if (shift >= 0) {
    const nn = n << BigInt(shift);
    q = nn / d;
    r = nn % d;
  } else {
    const dd = d << BigInt(-shift);
    q = n / dd;
    r = n % dd;
  }
  q = (q << 1n) | (r !== 0n ? 1n : 0n); // sticky bit makes Number(q) round correctly
  let v = Number(q);
  const sh = shift + 1;
  // scale by 2^-sh in two steps so neither factor overflows
  const h = Math.trunc(sh / 2);
  v = v * 2 ** -h * 2 ** -(sh - h);
  return neg ? -v : v;
}

/** `sqrt(n/d)` correctly rounded to within half an ulp plus a sticky bit (the root is irrational in general). */
export function sqrtRatioToNumber(n: bigint, d: bigint): number {
  if (n === 0n) return 0;
  // want floor(sqrt(n/d) * 2^k) with at least 70 bits
  const k = BigInt(Math.max(0, 70 - Math.floor((bitLength(n) - bitLength(d)) / 2)));
  const target = (n << (2n * k)) / d;
  let x = 1n << BigInt(Math.ceil(bitLength(target) / 2) + 1);
  for (;;) {
    const y = (x + target / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return ratioToNumber((x << 1n) | 1n, 1n << (k + 1n)); // x + 1/2: midpoint avoids ties
}

/** Exact sum of doubles, rounded once. */
export function exactSum(xs: readonly number[]): number {
  let s = 0n;
  for (const x of xs) s += toScaled(x);
  return ratioToNumber(s, 1n << SCALE_BITS);
}

/** Exact mean of doubles, rounded once. */
export function exactMean(xs: readonly number[]): number {
  let s = 0n;
  for (const x of xs) s += toScaled(x);
  return ratioToNumber(s, BigInt(xs.length) << SCALE_BITS);
}

/** Exact dot product of doubles, rounded once. */
export function exactDot(a: readonly number[], b: readonly number[]): number {
  let s = 0n;
  for (let i = 0; i < a.length; i++) s += toScaled(a[i]!) * toScaled(b[i]!);
  return ratioToNumber(s, 1n << (2n * SCALE_BITS));
}

/** Exact centered sum of products `n*Sxy - Sx*Sy` over n, as a fraction with the 2^-2148 scale folded in. */
function covParts(x: readonly number[], y: readonly number[]): { num: bigint; den: bigint } {
  const n = BigInt(x.length);
  let sx = 0n;
  let sy = 0n;
  let sxy = 0n;
  for (let t = 0; t < x.length; t++) {
    const a = toScaled(x[t]!);
    const b = toScaled(y[t]!);
    sx += a;
    sy += b;
    sxy += a * b;
  }
  return { num: n * sxy - sx * sy, den: n << (2n * SCALE_BITS) };
}

/** Exact sample covariance `sum (x-mx)(y-my) / (n - ddof)` of the doubles, rounded once. */
export function exactCov(x: readonly number[], y: readonly number[], ddof = 1): number {
  const { num, den } = covParts(x, y);
  return ratioToNumber(num, den * BigInt(x.length - ddof));
}

/** Exact Pearson correlation of the doubles, rounded once (to within half an ulp). */
export function exactPearson(x: readonly number[], y: readonly number[]): number {
  const c = covParts(x, y);
  const vx = covParts(x, x);
  const vy = covParts(y, y);
  // r = c / sqrt(vx*vy) with all three over their own denominators; denominators are equal (n * 2^2148)
  const num = c.num * c.num;
  const den = vx.num * vy.num;
  const mag = sqrtRatioToNumber(num, den);
  return c.num < 0n ? -mag : mag;
}

/** Exact OLS slope cov(x, y) / var(x) of the doubles, rounded once; NaN when var(x) is 0. */
export function exactBeta(x: readonly number[], y: readonly number[]): number {
  const c = covParts(x, y);
  const v = covParts(x, x);
  return v.num === 0n ? NaN : ratioToNumber(c.num, v.num);
}

/** Exact population or sample standard deviation, rounded once. */
export function exactStd(x: readonly number[], ddof = 0): number {
  const v = covParts(x, x);
  return sqrtRatioToNumber(v.num, v.den * BigInt(x.length - ddof));
}


/** Exact product start * prod(1 + r_t), each factor formed in exact rationals, rounded once. */
export function exactCompound(returns: readonly number[], start = 1): number {
  // Every factor is dyadic, f / 2^1074: keep an odd integer numerator and a power-of-two exponent.
  let n = toScaled(start);
  let e = SCALE_BITS;
  const one = 1n << SCALE_BITS;
  for (const r of returns) {
    let f = one + toScaled(r);
    if (f === 0n) return 0;
    const tz = BigInt(bitLength(f & -f) - 1);
    f >>= tz;
    n *= f;
    e += SCALE_BITS - tz;
  }
  return e >= 0n ? ratioToNumber(n, 1n << e) : ratioToNumber(n << -e, 1n);
}

/** Exact product of rational factors, rounded once. */
export function exactProduct(factors: readonly Q[]): number {
  let n = 1n;
  let d = 1n;
  for (const f of factors) {
    n *= f.n;
    d *= f.d;
  }
  return ratioToNumber(n, d);
}

/** Exact 1 + r for a double r, as a rational. */
export const onePlus = (r: number): Q => new Q(1n).add(Q.of(r));

/**
 * Exact annualized Sharpe mean / sd * sqrt(periods) of doubles (sample sd,
 * n - 1), rounded once: sharpe^2 = Sx^2 * periods * (n - 1) / (n * (n * Sxx - Sx^2))
 * in the scaled integers, where the 2^-1074 scales cancel. 0 when the exact
 * variance is 0.
 */
export function exactSharpe(xs: readonly number[], periods = 365): number {
  const n = BigInt(xs.length);
  let sx = 0n;
  let sxx = 0n;
  for (const x of xs) {
    const v = toScaled(x);
    sx += v;
    sxx += v * v;
  }
  const s = n * sxx - sx * sx;
  if (s === 0n) return 0;
  const mag = sqrtRatioToNumber(sx * sx * BigInt(periods) * (n - 1n), n * s);
  return sx < 0n ? -mag : mag;
}

/** Relative error |got - want| / |want|; the absolute error when want is 0. */
export function relErr(got: number, want: number): number {
  return want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
}

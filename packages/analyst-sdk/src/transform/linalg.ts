// Linear algebra for the certified optimizers (allocate/optimize.ts) under
// decision D78: the covariance and correlation matrices and a refined linear
// solve that fails closed. Ported from rosemarys-baby src/lib/matrix.ts, with
// the ml-matrix LU replaced by a dependency-free port of the same algorithm
// (JAMA's left-looking LU with partial pivoting), so the package keeps
// installing alone (D57).
//
// Covariance and correlation: `series[i]` is one variable's observations. Each
// entry comes from compensated double-double parts (transform/exact.ts), each
// series first divided by a power of two (exact) so neither its products
// overflow nor their errors underflow; each covariance entry is the correctly
// rounded exact sample covariance of the doubles.
//
// Solve: rows, then columns, are balanced by powers of two (exact). The
// balanced matrix is factored by LU with partial pivoting. The factorization is
// only a preconditioner: every residual b - A x is formed on the original
// system by residual2 (compensated, rounded once), so x converges to the exact
// solution while cond1 * eps < 1. The call throws UnsupportedError when the
// matrix is singular, when the balanced 1-norm condition times eps is at least
// 1 (no digit is certain), and when refinement stalls above one rounding.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
import { centeredCrossDD, correlation as pairCorrelation, ddDivD, ddValue, mean2, residual2, scaleOf, stdDD, sum2 } from "./exact.ts";

/** A dense matrix, row-major: `m[i][j]` is row i, column j. */
export type Mat = readonly (readonly number[])[];
export type Vec = readonly number[];

/** One recognizable error for inputs the code refuses on purpose, so a caller never gets a silently wrong value. */
export class UnsupportedError extends Error {
  constructor(what: string, why: string) {
    super(`unsupported: ${what}: ${why}`);
    this.name = "UnsupportedError";
  }
}

/** Throw UnsupportedError(what, why). */
export function unsupported(what: string, why: string): never {
  throw new UnsupportedError(what, why);
}

const square = (k: number): number[][] => Array.from({ length: k }, () => new Array<number>(k).fill(0));

/**
 * Covariance matrix (ddof 1 by default): `series[i]` is the i-th variable's
 * observations. Returns k x k. Each series is divided by its `scaleOf` power of
 * two (exact) and each entry scaled back once, so magnitudes such as 1e160 or
 * 1e-155 are as accurate as ordinary ones, and ordinary inputs are bit-for-bit
 * unchanged.
 */
export function covarianceMatrix(series: readonly (readonly number[])[], ddof = 1): number[][] {
  const k = series.length;
  if (k === 0) return unsupported("covariance", "no series");
  const n = series[0]!.length;
  if (series.some((s) => s.length !== n)) return unsupported("covariance", "series of unequal length");
  if (n - ddof <= 0) return unsupported("covariance", `n=${n} with ddof=${ddof}`);
  if (series.some((s) => s.some((x) => !Number.isFinite(x)))) return unsupported("covariance", "non-finite input");
  const scales = series.map((s) => scaleOf(s));
  const scaled = series.map((s, i) => s.map((x) => x / scales[i]!));
  const means = scaled.map((s) => mean2(s));
  const out = square(k);
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const v = ddValue(ddDivD(centeredCrossDD(scaled[i]!, scaled[j]!, means[i], means[j]), n - ddof)) * scales[i]! * scales[j]!;
      out[i]![j] = v;
      out[j]![i] = v;
    }
  }
  return out;
}

/**
 * Correlation matrix: each entry is the compensated, scale-safe pairwise
 * `correlation` of transform/exact.ts (not cov / sd / sd, which rounds four
 * times). The diagonal is exactly 1 for a non-constant series, NaN for a
 * constant one.
 */
export function correlationMatrix(series: readonly (readonly number[])[]): number[][] {
  const k = series.length;
  const n = series[0]?.length ?? 0;
  if (series.some((s) => s.length !== n)) return unsupported("correlation", "series of unequal length");
  const out = square(k);
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const v = i === j ? (stdDD(series[i]!, 0)[0] === 0 ? Number.NaN : 1) : pairCorrelation(series[i]!, series[j]!);
      out[i]![j] = v;
      out[j]![i] = v;
    }
  }
  return out;
}

const EPS = Number.EPSILON;
const MAX_REFINE = 10;

/** The 1-norm of a square matrix: the largest compensated column sum of absolute values. */
const norm1 = (m: Mat): number => {
  let best = 0;
  for (let j = 0; j < m.length; j++) best = Math.max(best, sum2(m.map((row) => Math.abs(row[j]!))));
  return best;
};
const normInf = (v: Vec): number => v.reduce((a, x) => Math.max(a, Math.abs(x)), 0);

/** LU factors with partial pivoting: L (unit lower, below the diagonal) and U share `lu`; row i of P A is row `piv[i]` of A. */
interface Lu {
  lu: number[][];
  piv: number[];
}

/**
 * LU with partial pivoting, the left-looking (JAMA, Crout-Doolittle) order the
 * reference's ml-matrix LuDecomposition uses, step for step. The factor is a
 * preconditioner for refinement, never the answer itself.
 */
function luFactor(A: Mat): Lu {
  const n = A.length;
  const lu = A.map((row) => [...row]);
  const piv = Array.from({ length: n }, (_, i) => i);
  const col = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) col[i] = lu[i]![j]!;
    for (let i = 0; i < n; i++) {
      const kmax = Math.min(i, j);
      let s = 0;
      for (let k = 0; k < kmax; k++) s += lu[i]![k]! * col[k]!;
      col[i] = col[i]! - s;
      lu[i]![j] = col[i]!;
    }
    let p = j;
    for (let i = j + 1; i < n; i++) if (Math.abs(col[i]!) > Math.abs(col[p]!)) p = i;
    if (p !== j) {
      [lu[p], lu[j]] = [lu[j]!, lu[p]!];
      [piv[p], piv[j]] = [piv[j]!, piv[p]!];
    }
    if (lu[j]![j] !== 0) for (let i = j + 1; i < n; i++) lu[i]![j] = lu[i]![j]! / lu[j]![j]!;
  }
  return { lu, piv };
}

const isSingular = (f: Lu): boolean => f.lu.some((row, j) => row[j] === 0);

/** Solve L U x = P b by forward and back substitution, in the reference's order. */
function luSolve(f: Lu, b: Vec): number[] {
  const n = f.lu.length;
  const x = f.piv.map((p) => b[p]!);
  for (let k = 0; k < n; k++) for (let i = k + 1; i < n; i++) x[i] = x[i]! - x[k]! * f.lu[i]![k]!;
  for (let k = n - 1; k >= 0; k--) {
    x[k] = x[k]! / f.lu[k]![k]!;
    for (let i = 0; i < k; i++) x[i] = x[i]! - x[k]! * f.lu[i]![k]!;
  }
  return x;
}

/**
 * A square system balanced by powers of two: A' = diag(1/s) A diag(1/t), each
 * row of A, then each column of the row-scaled matrix, brought to a largest
 * entry in [1, 2). Dividing by a power of two is exact (barring underflow), so
 * A x = b is A' (t x) = b / s with nothing rounded, while the LU pivots and the
 * condition estimate see a balanced matrix: a badly scaled but easy matrix such
 * as diag(1, 1e-17) has condition 1, not 1e17.
 */
interface Balanced {
  rows: number[][];
  s: number[];
  t: number[];
  scaled: number[][];
  lu: Lu;
}

function balance(A: Mat): Balanced {
  const rows = A.map((row) => [...row]);
  const s = rows.map((row) => scaleOf(row));
  const rs = rows.map((row, i) => row.map((v) => v / s[i]!));
  const t = rs[0]!.map((_, j) => scaleOf(rs.map((row) => row[j]!)));
  const scaled = rs.map((row) => row.map((v, j) => v / t[j]!));
  return { rows, s, t, scaled, lu: luFactor(scaled) };
}

/** Largest componentwise relative size of the correction `d` to `x` (a zero component is measured against the largest). */
function relSize(d: Vec, x: Vec): number {
  const big = normInf(x) || 1;
  return d.reduce((m, di, i) => Math.max(m, Math.abs(di) / (Math.abs(x[i]!) || big)), 0);
}

/**
 * One solve of A x = b by LU of the balanced matrix and iterative refinement.
 * Each residual b - A x is computed on the original A in extended precision
 * (residual2, rounded once), so x converges to the exact solution while
 * cond(A') * eps < 1. A correction is applied only while it shrinks.
 * `converged` holds when the correction measured at the returned x is at most
 * eps relative on every component, so x is within about one rounding of the
 * exact solution.
 */
function refine(B: Balanced, b: Vec): { x: number[]; converged: boolean } {
  const solveScaled = (r: Vec): number[] => luSolve(B.lu, r.map((v, i) => v / B.s[i]!)).map((v, j) => v / B.t[j]!);
  let x = solveScaled(b);
  let prev = Infinity;
  for (let it = 0; ; it++) {
    const d = solveScaled(B.rows.map((row, i) => residual2(b[i]!, row, x)));
    const rel = relSize(d, x);
    if (rel <= EPS / 4) return { x: x.map((xi, i) => xi + d[i]!), converged: true }; // below half an ulp everywhere
    if (rel >= prev || it === MAX_REFINE) return { x, converged: rel <= EPS }; // d measures the error left in x
    x = x.map((xi, i) => xi + d[i]!);
    prev = rel;
  }
}

/**
 * A x = b for square A, refined to working precision. Rows and columns are
 * balanced by powers of two first (exact). Fails closed (UnsupportedError) when
 * A is not square or holds a non-finite entry, when A is singular, when the
 * 1-norm condition number of the balanced matrix (from its refined inverse)
 * times eps is at least 1, where no digit of x is certain, and when refinement
 * does not converge to within one rounding (near cond 1e15 it can stall at
 * thousands of ulps).
 */
export function solveRefined(A: Mat, b: Vec): number[] {
  const n = A.length;
  if (n === 0 || A.some((row) => row.length !== n)) return unsupported("solve", `${n}x${A[0]?.length ?? 0} is not square`);
  if (b.length !== n) return unsupported("solve", `right-hand side of length ${b.length} for ${n} rows`);
  if (A.some((row) => row.some((v) => !Number.isFinite(v))) || b.some((v) => !Number.isFinite(v))) return unsupported("solve", "non-finite input");
  const B = balance(A);
  if (isSingular(B.lu)) return unsupported("solve", "singular matrix");
  const unit: Balanced = { rows: B.scaled, s: B.s.map(() => 1), t: B.t.map(() => 1), scaled: B.scaled, lu: B.lu };
  const invNorm1 = Math.max(...B.s.map((_, j) => sum2(refine(unit, B.s.map((_, i) => (i === j ? 1 : 0))).x.map(Math.abs))));
  const cond1 = norm1(B.scaled) * invNorm1;
  if (!(cond1 * EPS < 1)) return unsupported("solve", `condition number ${cond1.toExponential(2)} is beyond 1/eps; no digit is certain`);
  const { x, converged } = refine(B, b);
  if (!converged) return unsupported("solve", `refinement did not converge (condition number ${cond1.toExponential(2)})`);
  return x;
}

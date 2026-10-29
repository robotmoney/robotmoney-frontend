// Certified portfolio optimizers under decision D78: each solver returns the
// true optimum together with a certificate, or throws UnsupportedError. There is
// no iterative fallback. Ported from rosemarys-baby src/lib/qp.ts with the same
// algorithms, tolerances, residual definitions and messages.
//
//   - Budgeted equal risk contribution (ercExact, ercCertified): damped Newton
//     on the strictly convex program min 1/2 w'Sw - sum b_i ln w_i (Spinu 2013),
//     to a relative gradient of machine size, then normalised, so each risk
//     contribution equals its budget to about 1e-15 relative, however small.
//   - Long-only minimum variance (minVarExact), long-only mean-variance with a
//     slack or binding budget and the all-cash optimum (meanVarExact), and
//     long-only maximum Sharpe (tangencyExact): exact active-set enumeration (at
//     most 2^n supports), each support solved by transform/linalg.ts
//     solveRefined, and the KKT conditions checked off the support. Maximum
//     Sharpe with no positive excess return is the best single asset.
//   - Ties between supports break deterministically: higher objective, then
//     fewer assets, then lower index (`supports` order).
//   - Each residual function adds the infeasibility of the point (a negative
//     weight, and a budget other than 1 where the problem is fully invested), so
//     only a feasible optimum scores at rounding size.
//
// Every sum, dot product and quadratic form is compensated and rounded once
// (transform/exact.ts sum2, dot2). Pure: no fs, env or network
// (scripts/tests/unit/analyst-sdk-purity.test.ts).
import { dot2, sum2 } from "../transform/exact.ts";
import { solveRefined, unsupported, UnsupportedError, type Mat, type Vec } from "../transform/linalg.ts";

export { UnsupportedError, type Mat, type Vec };

const matVec = (S: Mat, w: Vec): number[] => S.map((row) => dot2(row, w));

// NON-FINITE INPUT AND OUTPUT (SDK-11, D78 amendment: a certified optimum or a
// throw). A NaN makes every comparison false, so a KKT check written as
// `x < bound` passes on NaN. Every solver therefore checks its inputs here, and
// its result below, and every off-support check is written `!(x >= bound)`.
function assertFiniteInputs(what: string, S: Mat, ex?: Vec, lam?: number): void {
  const n = S.length;
  S.forEach((row, i) => {
    if (row.length !== n) unsupported(what, `covariance row ${i} has ${row.length} entries for ${n} assets`);
    row.forEach((v, j) => {
      if (!Number.isFinite(v)) unsupported(what, `covariance entry [${i}][${j}] is ${v}; every entry must be finite`);
    });
  });
  if (ex !== undefined) {
    if (ex.length !== n) unsupported(what, `${ex.length} excess returns for ${n} assets`);
    ex.forEach((e, i) => {
      if (!Number.isFinite(e)) unsupported(what, `excess return ${i} is ${e}; every excess return must be finite`);
    });
  }
  if (lam !== undefined && !Number.isFinite(lam)) unsupported(what, `risk aversion is ${lam}; it must be finite`);
}

function finiteResult(what: string, w: number[]): number[] {
  w.forEach((x, i) => {
    if (!Number.isFinite(x)) unsupported(what, `weight ${i} is ${x}; the solver produced a non-finite weight`);
  });
  return w;
}

/** Distance of `w` from the feasible set: max(-min w, 0), and with `fullyInvested` also |sum w - 1| (compensated). */
function infeasibility(w: Vec, fullyInvested: boolean): number {
  const neg = Math.max(-Math.min(...w), 0);
  return fullyInvested ? Math.max(neg, Math.abs(sum2([...w, -1]))) : neg;
}

/**
 * Subsets of 0..n-1 as index lists, ordered by size then lexicographically by
 * index (the fixed tie-break order). The comparison is numeric element by
 * element: comparing joined strings would put "0,10" before "0,2".
 */
export function supports(n: number): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const s: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s.push(i);
    out.push(s);
  }
  const byIndex = (a: readonly number[], b: readonly number[]): number => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k]! - b[k]!;
    return 0;
  };
  return out.sort((a, b) => a.length - b.length || byIndex(a, b));
}

const sub = (S: Mat, idx: readonly number[]): number[][] => idx.map((i) => idx.map((j) => S[i]![j]!));

/** Solve S_sub z = rhs on a support; null when the sub-matrix is singular or ill-conditioned beyond 1/eps. */
function solveSupport(S: Mat, idx: readonly number[], rhs: Vec): number[] | null {
  try {
    return solveRefined(sub(S, idx), idx.map((i) => rhs[i]!));
  } catch {
    return null;
  }
}

function scatter(n: number, idx: readonly number[], vals: Vec): number[] {
  const w = new Array<number>(n).fill(0);
  idx.forEach((i, k) => (w[i] = vals[k]!));
  return w;
}

// ------------------------------------------------------------------ budgeted equal risk contribution

/** Risk contributions w_i (Sw)_i / w'Sw. */
export function riskContributions(S: Mat, w: Vec): number[] {
  const Sw = matVec(S, w);
  const rc = w.map((x, i) => x * Sw[i]!);
  const t = sum2(rc);
  return rc.map((x) => x / t);
}

/**
 * Largest relative violation of the risk budgets: max_i |rc_i / b_i - 1| with b
 * normalised to sum 1 (equal budgets when absent). Relative, so a budget of 1e-9
 * missed by 1e-8 of itself counts as 1e-8, not as an absolute 1e-17.
 */
export function ercResidual(S: Mat, w: Vec, budgets?: Vec): number {
  const n = S.length;
  const tot = budgets ? sum2(budgets) : 1;
  const b = budgets ? budgets.map((x) => x / tot) : new Array<number>(n).fill(1 / n);
  const rc = riskContributions(S, w);
  return rc.reduce((m, x, i) => Math.max(m, Math.abs(x / b[i]! - 1)), 0);
}

export interface ErcResult {
  w: number[];
  /** max |rc_i / b_i - 1| at the returned weights. */
  residual: number;
  iterations: number;
}

/**
 * The exact budgeted ERC portfolio (weights sum to 1) by damped Newton on the
 * strictly convex program. Budgets are normalised to sum 1; every budget must be
 * positive and finite, or UnsupportedError names the budget index.
 */
export function ercExact(S: Mat, budgets?: Vec): ErcResult {
  assertFiniteInputs("ercExact", S);
  const n = S.length;
  const tot = budgets ? sum2(budgets) : 1;
  const b = budgets ? budgets.map((x) => x / tot) : new Array<number>(n).fill(1 / n);
  // the program needs every budget positive: a zero budget puts its log barrier at w_i = 0, where Newton cannot start
  b.forEach((bi, i) => {
    if (!(bi > 0 && Number.isFinite(bi))) unsupported("ercExact", `risk budget ${i} is ${budgets?.[i]}; every budget must be positive and finite`);
  });
  const f = (w: Vec): number => 0.5 * dot2(w, matVec(S, w)) - dot2(b, w.map(Math.log));
  // merit: the scale-free gradient w_i g_i / b_i = w_i (Sw)_i / b_i - 1 of the program, relative to each budget so a
  // tiny budget is met as tightly as a large one (f itself is flat near the optimum, so f can no longer decrease in
  // floating point long before the gradient is at rounding size)
  const grad = (w: Vec): number[] => {
    const Sw = matVec(S, w);
    return w.map((wi, i) => (wi * Sw[i]!) / b[i]! - 1);
  };
  const gn = (g: Vec): number => Math.max(...g.map(Math.abs));
  let w = b.map((bi, i) => Math.sqrt(bi / S[i]![i]!));
  let iterations = 0;
  for (let it = 0; it < 200; it++) {
    const Sw = matVec(S, w);
    const g = w.map((wi, i) => Sw[i]! - b[i]! / wi);
    const merit = gn(grad(w));
    // only an exact zero stops here: the merit is a difference of doubles near 1, so its smallest nonzero value is
    // an ulp of 1 (1.1e-16). In practice the loop ends on the no-decrease exit below.
    if (merit === 0) break;
    const H = S.map((row, i) => row.map((v, j) => v + (i === j ? b[i]! / (w[i]! * w[i]!) : 0)));
    const d = solveRefined(H, g.map((x) => -x));
    let step = 1;
    let next = w;
    let ok = false;
    for (let bt = 0; bt < 60; bt++) {
      next = w.map((wi, i) => wi + step * d[i]!);
      if (next.every((x) => x > 0) && (gn(grad(next)) < merit || f(next) < f(w))) {
        ok = true;
        break;
      }
      step /= 2;
    }
    if (!ok) break; // neither the gradient nor f can decrease: at the optimum to rounding
    w = next;
    iterations = it + 1;
  }
  const total = sum2(w);
  const wn = finiteResult("ercExact", w.map((x) => x / total));
  return { w: wn, residual: ercResidual(S, wn, b), iterations };
}

/**
 * Certificate bar for ERC: relative budget violation max |rc_i / b_i - 1| of 18
 * ulps of 1. Evaluating the violation alone rounds about six times, and the
 * weights are doubles, so a few ulps is the floor (rosemarys-baby
 * docs/numerics.md, "Known limits").
 */
export const ERC_TOL = 4e-15;

/**
 * The exact ERC weights, certified: relative budget violation at rounding size
 * (<= ERC_TOL). Throws UnsupportedError otherwise. Limit: the Newton iterate
 * stalls a few ulps from the budgets, and the stall grows with the covariance's
 * condition number and with hedging. A budget orders of magnitude below the
 * others carried by a large hedged weight cannot be met in doubles and throws.
 */
export function ercCertified(S: Mat, budgets?: Vec): number[] {
  const e = ercExact(S, budgets);
  if (!(e.residual <= ERC_TOL)) unsupported("ercCertified", `Newton stopped at relative budget violation ${e.residual.toExponential(2)}`);
  return e.w;
}

// ------------------------------------------------------------------ long-only minimum variance

/**
 * KKT residual of min w'Sw on the simplex, relative to the budget multiplier nu
 * (the mean of the gradient 2Sw over the support): on the support the gradient
 * must equal nu, off it not be below nu; each gap is divided by |nu|, so scaling
 * w does not shrink it. The infeasibility max(-min w, 0) and |sum w - 1| is
 * added (max).
 */
export function minVarResidual(S: Mat, w: Vec, tol = 0): number {
  const g = matVec(S, w).map((x) => 2 * x);
  const sup = w.map((x) => x > tol);
  const nu = sum2(g.filter((_, i) => sup[i])) / sup.filter(Boolean).length;
  const gap = g.reduce((m, x, i) => Math.max(m, sup[i] ? Math.abs(x - nu) : Math.max(nu - x, 0)), 0) / Math.abs(nu);
  return Math.max(Number.isNaN(gap) ? Infinity : gap, infeasibility(w, true));
}

/**
 * Exact long-only minimum-variance portfolio on the simplex (fully invested).
 * Throws when no support satisfies KKT, which for a positive definite
 * covariance cannot happen.
 */
export function minVarExact(S: Mat): number[] {
  assertFiniteInputs("minVarExact", S);
  const n = S.length;
  const ones = new Array<number>(n).fill(1);
  let best: { w: number[]; v: number; size: number } | null = null;
  for (const idx of supports(n)) {
    const z = solveSupport(S, idx, ones);
    if (!z) continue;
    const t = sum2(z);
    if (!(t > 0) || z.some((x) => !(x > 0))) continue;
    const w = scatter(n, idx, z.map((x) => x / t));
    const lam = 1 / t; // the common gradient/2 on the support: w'Sw
    const Sw = matVec(S, w);
    if (Sw.some((x, j) => !idx.includes(j) && !(x >= lam * (1 - 1e-12)))) continue; // off-support gradient must not be lower
    const v = dot2(w, Sw);
    if (best === null || v < best.v * (1 - 1e-14)) best = { w, v, size: idx.length };
  }
  return best ? finiteResult("minVarExact", best.w) : unsupported("minVarExact", "no support satisfies KKT (covariance not positive definite)");
}

// ------------------------------------------------------------------ long-only mean-variance, budget at most 1

/**
 * Budget multiplier of max ex'w - lam/2 w'Sw, w >= 0, sum w <= 1 at w: zero
 * when the budget is slack, else the mean of ex_i - lam (Sw)_i over the support.
 */
function budgetMultiplier(S: Mat, ex: Vec, lam: number, w: Vec): number {
  if (sum2(w) < 1 - 1e-12) return 0;
  const Sw = matVec(S, w);
  const g = w.flatMap((x, i) => (x > 0 ? [ex[i]! - lam * Sw[i]!] : []));
  return Math.max(sum2(g) / g.length, 0);
}

/**
 * KKT residual of max ex'w - lam/2 w'Sw, w >= 0, sum w <= 1: with nu the budget
 * multiplier, the gradient ex - lam Sw - nu is 0 on the support and <= 0 off
 * it, nu >= 0, and nu is 0 unless the budget binds. The infeasibility
 * max(-min w, 0) and max(sum w - 1, 0) is added (max).
 */
export function meanVarResidual(S: Mat, ex: Vec, lam: number, w: Vec): number {
  const Sw = matVec(S, w);
  const nu = budgetMultiplier(S, ex, lam, w);
  const over = Math.max(sum2([...w, -1]), infeasibility(w, false)); // feasibility: the budget and the sign
  return w.reduce((m, x, i) => {
    const g = ex[i]! - lam * Sw[i]! - nu;
    return Math.max(m, x > 0 ? Math.abs(g) : Math.max(g, 0));
  }, over);
}

/**
 * Exact long-only mean-variance weights argmax ex'w - lam/2 w'Sw subject to
 * w >= 0 and sum w <= 1 (the rest is cash). Each support is tried with the
 * budget slack (S_s z = ex_s / lam, sum at most 1) and binding
 * ([lam S_s 1; 1' 0] [z; nu] = [ex_s; 1], nu >= 0); the empty support is the
 * all-cash optimum when no excess return is positive. Throws when nothing
 * passes KKT (covariance not positive definite).
 */
export function meanVarExact(S: Mat, ex: Vec, lam: number): number[] {
  assertFiniteInputs("meanVarExact", S, ex, lam);
  const n = S.length;
  const tol = (j: number): number => 1e-14 * (Math.abs(ex[j]!) + 1);
  const rhs = ex.map((x) => x / lam);
  let best: { w: number[]; u: number } | null = ex.every((e) => e <= 0) ? { w: new Array<number>(n).fill(0), u: 0 } : null;
  const consider = (idx: readonly number[], z: Vec, nu: number): void => {
    if (z.some((x) => !(x > 0))) return;
    const w = scatter(n, idx, z);
    const Sw = matVec(S, w);
    if (ex.some((e, j) => !idx.includes(j) && !(e - lam * Sw[j]! - nu <= tol(j)))) return; // off-support gradient must not be positive
    const u = dot2(ex, w) - 0.5 * lam * dot2(w, Sw);
    if (best === null || u > best.u + 1e-14 * Math.abs(best.u) + 1e-300) best = { w, u };
  };
  for (const idx of supports(n)) {
    const z = solveSupport(S, idx, rhs);
    if (z && sum2(z) <= 1) consider(idx, z, 0);
    const k = idx.length;
    const A = idx.map((i) => [...idx.map((j) => lam * S[i]![j]!), 1]).concat([[...new Array<number>(k).fill(1), 0]]);
    try {
      const zn = solveRefined(A, [...idx.map((i) => ex[i]!), 1]);
      const nu = zn[k]!;
      if (nu >= -1e-14 * (Math.max(...ex.map(Math.abs)) + 1)) consider(idx, zn.slice(0, k), Math.max(nu, 0));
    } catch {
      // singular bordered system on this support: no candidate
    }
  }
  return best ? finiteResult("meanVarExact", best.w) : unsupported("meanVarExact", "no support satisfies KKT (covariance not positive definite)");
}

// ------------------------------------------------------------------ long-only maximum Sharpe

/** Sharpe ratio ex'w / sqrt(w'Sw). */
export const sharpeRatio = (S: Mat, ex: Vec, w: Vec): number => dot2(ex, w) / Math.sqrt(dot2(w, matVec(S, w)));

/**
 * Projected-gradient residual of the Sharpe ratio on the simplex, relative to
 * |ex| / sigma: the gradient must vanish on the support and be non-positive off
 * it. The Sharpe ratio is scale-free, so the infeasibility max(-min w, 0) and
 * |sum w - 1| is added (max).
 */
export function sharpeResidual(S: Mat, ex: Vec, w: Vec): number {
  const Sw = matVec(S, w);
  const m = dot2(ex, w);
  const s = Math.sqrt(dot2(w, Sw));
  const g = ex.map((e, i) => e / s - (m * Sw[i]!) / (s * s * s));
  const scale = Math.max(...ex.map(Math.abs)) / s || 1;
  const kkt = w.reduce((r, x, i) => Math.max(r, x > 0 ? Math.abs(g[i]!) : Math.max(g[i]!, 0)), 0) / scale;
  return Math.max(kkt, infeasibility(w, true));
}

/**
 * Exact long-only maximum-Sharpe portfolio (weights sum to 1).
 *  - Some excess return positive: on the optimum's support w is proportional to
 *    S_s^-1 ex_s. Every support is tried; a candidate must have positive weights
 *    and satisfy KKT off the support (ex_j - (ex'w / w'Sw) (Sw)_j <= 0, to
 *    rounding).
 *  - No excess return positive: the best single asset by ex_i / sigma_i. For
 *    w >= 0, sum w = 1 the volatility is at most sum w_i sigma_i (positive
 *    semidefinite S), so with a nonpositive numerator
 *    ex'w / sigma(w) <= sum w_i ex_i / sum w_i sigma_i <= max_i ex_i / sigma_i.
 * Throws when nothing passes (covariance singular on every positive-Sharpe support).
 */
export function tangencyExact(S: Mat, ex: Vec): number[] {
  assertFiniteInputs("tangencyExact", S, ex);
  const n = S.length;
  if (ex.every((e) => e <= 0)) {
    let k = 0;
    for (let i = 1; i < n; i++) if (ex[i]! / Math.sqrt(S[i]![i]!) > ex[k]! / Math.sqrt(S[k]![k]!)) k = i;
    return scatter(n, [k], [1]);
  }
  let best: { w: number[]; sh: number } | null = null;
  for (const idx of supports(n)) {
    const z = solveSupport(S, idx, ex);
    if (!z) continue;
    const t = sum2(z);
    if (!(t > 0)) continue;
    const wz = z.map((x) => x / t);
    if (wz.some((x) => !(x > 0))) continue;
    const w = scatter(n, idx, wz);
    const Sw = matVec(S, w);
    const m = dot2(ex, w);
    if (!(m > 0)) continue;
    const k = m / dot2(w, Sw);
    if (ex.some((e, j) => !idx.includes(j) && !(e - k * Sw[j]! <= 1e-12 * (Math.abs(e) + Math.abs(k * Sw[j]!))))) continue; // off-support gradient positive: not the maximiser
    const sh = sharpeRatio(S, ex, w);
    if (best === null || sh > best.sh * (1 + 1e-14)) best = { w, sh };
  }
  return best ? finiteResult("tangencyExact", best.w) : unsupported("tangencyExact", "no support satisfies KKT (covariance singular)");
}

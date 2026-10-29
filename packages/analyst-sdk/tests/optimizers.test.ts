// Optimality of the certified solvers (src/allocate/optimize.ts) and the
// shrunk covariance (src/allocate/covariance.ts). Each solution is graded by
// its KKT / projected-gradient / budget-violation residual; a 0.001 grid over
// the 3-asset feasible set is the independent check that the answer is the
// global optimum, and exact rationals check the risk budgets. Each residual
// also counts infeasibility, so only a feasible optimum scores small. Ported
// from rosemarys-baby src/tests/precision/optimizers.test.ts; the fixed
// matrices are tests/fixtures/optimizers/matrices.json (rosemarys-baby
// src/tests/fourbucket.cases.ts).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as O from "../src/allocate/optimize.ts";
import { annualCov, shrinkToDiagonal, shrunkCov, SHRINK } from "../src/allocate/covariance.ts";
import { covarianceMatrix, solveRefined, UnsupportedError } from "../src/transform/linalg.ts";
import { Q } from "./support/exact-reference.ts";

setDefaultTimeout(60_000);

type M = readonly (readonly number[])[];
interface Fixture {
  engines: { S: number[][] }[];
  diagonal: { S: number[][] };
  shrunk: { hist: number[][] };
}
const FB = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/optimizers/matrices.json"), "utf8")) as Fixture;

const maxOf = (xs: readonly number[]): number => xs.reduce((a, b) => Math.max(a, b), 0);
const quad = (S: M, w: readonly number[]): number => w.reduce((a, x, i) => a + x * S[i]!.reduce((t, y, j) => t + y * w[j]!, 0), 0);
const sum = (w: readonly number[]): number => w.reduce((a, b) => a + b, 0);

/** The exact relative budget miss max |rc_i / b_i - 1| of the doubles w, in rationals, rounded once. */
function exactBudgetMiss(S: M, w: readonly number[], b: readonly number[]): number {
  const W = w.map((x) => Q.of(x));
  const Sw = S.map((row) => row.reduce((a, s, j) => a.add(Q.of(s).mul(W[j]!)), new Q(0n)));
  const total = W.reduce((a, x, i) => a.add(x.mul(Sw[i]!)), new Q(0n));
  const bt = b.reduce((a, x) => a.add(Q.of(x)), new Q(0n));
  return Math.max(...W.map((x, i) => Math.abs(x.mul(Sw[i]!).div(total).div(Q.of(b[i]!).div(bt)).sub(new Q(1n)).toNumber())));
}

/** The best value of f on every point of the 3-asset simplex on a 0.001 grid (fully invested), plus, with cash, the points with the third weight 0. */
function grid3(f: (w: number[]) => number, withCash = false): number {
  let best = -Infinity;
  for (let i = 0; i <= 1000; i++) {
    for (let j = 0; i + j <= 1000; j++) {
      best = Math.max(best, f([i / 1000, j / 1000, (1000 - i - j) / 1000]));
      if (withCash) best = Math.max(best, f([i / 1000, j / 1000, 0]));
    }
  }
  return best;
}

describe("budgeted ERC: the Newton solution meets every risk budget to rounding", () => {
  const budgets = [undefined, [0.5, 0.25, 0.25], [0.6, 0.2, 0.2]] as const;
  const cases = FB.engines.flatMap((c) => budgets.map((b) => ({ S: c.S, b })));
  test("worst relative residual max |rc_i / b_i - 1| over the 9 fixed cases is at most 4 ulps of 1", () => {
    expect(maxOf(cases.map((c) => O.ercResidual(c.S, O.ercCertified(c.S, c.b), c.b)))).toBeLessThanOrEqual(4 * Number.EPSILON);
    for (const c of cases) {
      const w = O.ercCertified(c.S, c.b);
      expect(sum(w)).toBeCloseTo(1, 15);
      expect(Math.min(...w)).toBeGreaterThan(0);
      expect(O.ercExact(c.S, c.b).w).toEqual(w);
    }
  });
  test("tiny budgets [1, 1e-9, 1e-9]: each risk contribution is its budget to 4 ulps relative (exact rationals), or the call throws", () => {
    const b = [1, 1e-9, 1e-9];
    const outcome = { certified: 0, refused: 0 };
    for (const c of FB.engines) {
      let w: number[];
      try {
        w = O.ercCertified(c.S, b);
      } catch (e) {
        expect(e).toBeInstanceOf(UnsupportedError);
        expect(String(e)).toMatch(/relative budget violation/);
        outcome.refused++;
        continue;
      }
      outcome.certified++;
      expect(exactBudgetMiss(c.S, w, b)).toBeLessThanOrEqual(4 * Number.EPSILON);
      expect(Math.min(...w)).toBeGreaterThan(0);
    }
    // matrix 1 is hedged: the doubles nearest its optimum miss a 1e-9 budget by 7e-8 relative, so the certificate refuses it
    expect(outcome).toEqual({ certified: 2, refused: 1 });
  });
  test("a zero or negative risk budget fails closed with a message naming the budget", () => {
    const S3 = FB.engines[0]!.S;
    expect(() => O.ercCertified(S3, [1, 0, 1])).toThrow(/risk budget 1 is 0/);
    expect(() => O.ercCertified(S3, [1, -0.1, 1])).toThrow(/risk budget 1/);
    expect(() => O.ercExact(S3, [1, NaN, 1])).toThrow(UnsupportedError);
    expect(O.ERC_TOL).toBe(4e-15);
  });
});

describe("long-only minimum variance", () => {
  test("KKT residual below 2e-15, and no point of a 0.001 grid has lower variance", () => {
    for (const S of [...FB.engines.map((c) => c.S), FB.diagonal.S]) {
      const w = O.minVarExact(S);
      expect(O.minVarResidual(S, w)).toBeLessThan(2e-15);
      expect(quad(S, w)).toBeLessThanOrEqual(-grid3((v) => -quad(S, v)) + 1e-15);
    }
  });
});

describe("mean-variance and tangency", () => {
  const S = [[0.3, 0.02, 0.005], [0.02, 0.03, 0.004], [0.005, 0.004, 0.02]];
  const rf = 0.04;
  test("mean-variance with the budget slack: residual below 1e-15, cash held, interior and corner, no grid point does better", () => {
    for (const mu of [[0.234, 0.075, 0.055], [0.01, 0.075, 0.055]]) {
      const ex = mu.map((m) => m - rf);
      const w = O.meanVarExact(S, ex, 4);
      expect(O.meanVarResidual(S, ex, 4, w)).toBeLessThan(1e-15);
      expect(sum(w)).toBeLessThan(1);
      const u = (v: readonly number[]): number => v.reduce((a, x, i) => a + ex[i]! * x, 0) - 2 * quad(S, v);
      expect(u(w)).toBeGreaterThanOrEqual(grid3((v) => Math.max(u(v), u(v.map((x) => x / 2))), true) - 1e-15);
    }
    expect(O.meanVarExact(S, [0.01 - rf, 0.075 - rf, 0.055 - rf], 4)[0]).toBe(0); // negative excess return: no weight
  });
  test("mean-variance with a binding budget: fully invested, residual below 1e-14, and no point of a 0.001 grid does better", () => {
    for (const [ex, lam] of [[[5, 5, 5], 0.1], [[0.6, 0.5, 0.4], 4], [[0.43, 0.02, 0.0], 1]] as const) {
      const w = O.meanVarExact(S, ex, lam);
      expect(sum(w)).toBeCloseTo(1, 14);
      expect(O.meanVarResidual(S, ex, lam, w)).toBeLessThan(1e-14);
      const u = (v: readonly number[]): number => v.reduce((a, x, i) => a + ex[i]! * x, 0) - 0.5 * lam * quad(S, v);
      expect(u(w)).toBeGreaterThanOrEqual(grid3(u, true) - 1e-15);
    }
  });
  test("tangency: residual below 1e-15, and no point of a 0.001 grid has a higher Sharpe ratio", () => {
    const ex = [0.234, 0.075, 0.055].map((m) => m - rf);
    const w = O.tangencyExact(S, ex);
    expect(O.sharpeResidual(S, ex, w)).toBeLessThan(1e-15);
    expect(O.sharpeRatio(S, ex, w)).toBeGreaterThanOrEqual(grid3((v) => O.sharpeRatio(S, ex, v)) - 1e-15);
    expect(O.tangencyExact(S, [0.01 - rf, 0.075 - rf, 0.02 - rf])).toEqual([0, 1, 0]); // a corner solution
  });
  test("ties break deterministically: identical assets give the lower-index corner", () => {
    const T = [[0.04, 0.04], [0.04, 0.04]];
    expect(O.tangencyExact(T, [0.05, 0.05])).toEqual([1, 0]);
    expect(O.minVarExact(T)).toEqual([1, 0]);
  });
  test("no positive excess return: mean-variance is all cash, max Sharpe the best single asset by ex_i / sigma_i", () => {
    expect(O.meanVarExact(S, [-0.01, -0.02, 0], 4)).toEqual([0, 0, 0]);
    expect(O.tangencyExact(S, [-0.1, -0.2, -0.3])).toEqual([1, 0, 0]); // -0.1/0.548 = -0.18 beats -1.15 and -2.12
    expect(O.tangencyExact(S, [-0.3, -0.01, -0.2])).toEqual([0, 1, 0]); // -0.01/0.173 = -0.058 is best
  });
  test("supports(11) has 2047 entries ordered by size, then by index compared numerically", () => {
    const s = O.supports(11);
    expect(s.length).toBe(2047);
    expect(s.filter((x) => x.length === 2).slice(0, 10)).toEqual([[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9], [0, 10]]);
    for (let i = 1; i < s.length; i++) {
      const [a, b] = [s[i - 1]!, s[i]!];
      const k = a.findIndex((v, j) => v !== b[j]);
      expect(a.length < b.length || (a.length === b.length && k >= 0 && a[k]! < b[k]!)).toBe(true);
    }
  });
  test("a zero covariance fails closed with UnsupportedError instead of an uncertified answer", () => {
    const Z = [[0, 0], [0, 0]];
    expect(() => O.minVarExact(Z)).toThrow(/unsupported/);
    expect(() => O.tangencyExact(Z, [0.1, 0.2])).toThrow(/unsupported/);
    // mean-variance with no risk is a linear program whose binding-budget vertex is a true optimum, so it is not refused
    expect(O.meanVarExact(Z, [0.1, 0.2], 4)).toEqual([0, 1]);
  });
});

describe("residuals reject infeasible points", () => {
  const S = [[0.3, 0.02, 0.005], [0.02, 0.03, 0.004], [0.005, 0.004, 0.02]];
  const S2 = [[0.04, 0.05, 0.0], [0.05, 0.09, 0.0], [0.0, 0.0, 0.0625]]; // its unconstrained optima are short asset 0 or 1
  const ex = [0.01, 0.08, 0.03];
  const half = (w: readonly number[]): number[] => w.map((x) => x / 2);
  const budgeted = (z: readonly number[]): number[] => z.map((x) => x / sum(z));
  test("minimum variance: half the optimum, the long-short optimum and a negative weight score at least their infeasibility", () => {
    for (const T of [S, S2]) {
      const w = O.minVarExact(T);
      expect(O.minVarResidual(T, w)).toBeLessThanOrEqual(Number.EPSILON);
      expect(O.minVarResidual(T, half(w))).toBeCloseTo(0.5, 15); // the budget is missed by one half; the KKT gap is scale-free
    }
    const ls = budgeted(solveRefined(S2, [1, 1, 1])); // [0.84, -0.21, 0.37]
    expect(Math.min(...ls)).toBeLessThan(-0.2);
    expect(O.minVarResidual(S2, ls)).toBeGreaterThanOrEqual(-Math.min(...ls));
    expect(O.minVarResidual(S, [1.2, -0.2, 0])).toBeGreaterThanOrEqual(0.2);
  });
  test("maximum Sharpe: the ratio is scale-free, so the budget and sign reject half the optimum and a short", () => {
    for (const T of [S, S2]) {
      const w = O.tangencyExact(T, ex);
      expect(O.sharpeResidual(T, ex, w)).toBeLessThanOrEqual(Number.EPSILON);
      expect(O.sharpeResidual(T, ex, half(w))).toBeCloseTo(0.5, 15);
    }
    expect(O.sharpeResidual(S2, ex, budgeted(solveRefined(S2, ex)))).toBeGreaterThanOrEqual(24); // [-24.2, 21.1, 4.1]
    expect(O.sharpeResidual(S, ex, budgeted(solveRefined(S, ex)))).toBeGreaterThanOrEqual(0.045); // asset 0 short 4.6%
    expect(O.sharpeResidual(S, ex, [1.2, -0.2, 0])).toBeGreaterThanOrEqual(0.2);
  });
  test("mean-variance: half the optimum, the unconstrained optimum and a negative weight score large", () => {
    for (const T of [S, S2]) {
      for (const lam of [4, 0.1]) {
        const w = O.meanVarExact(T, ex, lam);
        expect(O.meanVarResidual(T, ex, lam, w)).toBe(0);
        expect(O.meanVarResidual(T, ex, lam, half(w))).toBeGreaterThan(0.03); // feasible, but the gradient is far from zero
        const u = solveRefined(T, ex.map((e) => e / lam)); // S^-1 ex / lam: short asset 0
        expect(Math.min(...u)).toBeLessThan(-0.03);
        expect(O.meanVarResidual(T, ex, lam, u)).toBeGreaterThanOrEqual(-Math.min(...u));
      }
    }
    expect(O.meanVarResidual(S, ex, 4, [0.5, -0.2, 0.3])).toBeGreaterThanOrEqual(0.2);
  });
  test("ERC: half the optimum and a negative weight are far from the budgets", () => {
    const T = FB.engines[0]!.S;
    const w = O.ercCertified(T);
    expect(O.ercResidual(T, w)).toBeLessThanOrEqual(4 * Number.EPSILON);
    expect(O.ercResidual(T, [1.2, -0.2, 0])).toBeGreaterThanOrEqual(0.2);
    expect(O.riskContributions(T, w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
  });
});

describe("shrunk covariance", () => {
  const hist = FB.shrunk.hist;
  test("annualCov equals covarianceMatrix of the columns times 252, entry by entry", () => {
    const C = covarianceMatrix([0, 1, 2].map((j) => hist.map((r) => r[j]!)));
    expect(annualCov(hist)).toEqual(C.map((row) => row.map((x) => x * 252)));
    expect(annualCov(hist, 365)).toEqual(C.map((row) => row.map((x) => x * 365)));
  });
  test("shrinkToDiagonal keeps every diagonal entry bit for bit and multiplies off-diagonals by 1 - s; shrunkCov composes the two", () => {
    const A = annualCov(hist);
    for (const s of [SHRINK, 0, 0.5, 1]) {
      const B = shrinkToDiagonal(A, s);
      A.forEach((row, i) => row.forEach((x, j) => expect(B[i]![j]).toBe(i === j ? x : (1 - s) * x)));
    }
    expect(SHRINK).toBe(0.2);
    expect(shrunkCov(hist)).toEqual(shrinkToDiagonal(annualCov(hist), 0.2));
    expect(shrunkCov(hist, 0.3, 365)).toEqual(shrinkToDiagonal(annualCov(hist, 365), 0.3));
    expect(() => shrinkToDiagonal(A, 1.5)).toThrow(UnsupportedError);
    expect(() => annualCov([])).toThrow(UnsupportedError);
  });
  test("the solvers reach rounding-size residuals on the shrunk covariance of the fixture returns", () => {
    const S3 = shrunkCov(hist);
    expect(O.ercResidual(S3, O.ercCertified(S3))).toBeLessThanOrEqual(4 * Number.EPSILON);
    expect(O.minVarResidual(S3, O.minVarExact(S3))).toBeLessThan(2e-15);
    const ex = [0.2, 0.035, 0.015];
    expect(O.meanVarResidual(S3, ex, 4, O.meanVarExact(S3, ex, 4))).toBeLessThan(1e-14);
    expect(O.sharpeResidual(S3, ex, O.tangencyExact(S3, ex))).toBeLessThan(1e-15);
  });
});

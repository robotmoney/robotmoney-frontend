// Decision D78 for the linear algebra the certified optimizers use
// (src/transform/linalg.ts, dot2 and residual2 in src/transform/exact.ts).
// Every expectation is an exact BigInt rational value of the same doubles
// (support/exact-reference.ts), rounded once. Real data: simple daily returns
// of the committed SPX, ETH, DXY and VIX levels on their common dates. Ported
// from rosemarys-baby src/tests/precision/linalg.test.ts and covariance.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { dot2, residual2 } from "../src/transform/exact.ts";
import { correlationMatrix, covarianceMatrix, solveRefined, UnsupportedError } from "../src/transform/linalg.ts";
import { exactCov, exactDot, exactPearson, exactSolve, Q, relErr } from "./support/exact-reference.ts";

const history = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));

/** Simple daily returns of the given series on the dates every one of them has a level (consecutive common dates). */
function commonReturns(ids: readonly string[]): number[][] {
  const maps = ids.map((id) => new Map(history[id]!.map((p) => [p.date, p.value])));
  const days = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return maps.map((m) => days.slice(1).map((d, i) => m.get(d)! / m.get(days[i]!)! - 1));
}

const R3 = commonReturns(["SPX", "ETH", "DXY"]);
const R4 = commonReturns(["SPX", "ETH", "DXY", "VIX"]);
const ONE_ROUNDING = 2 ** -52;
const hilbert = (n: number): number[][] => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => 1 / (i + j + 1)));
/** The 4x4 annualized covariance of the real returns, each entry the exact value rounded once, then times 252. */
const covA = (): number[][] => R4.map((a) => R4.map((b) => exactCov(a, b) * 252));

describe("dot2 and residual2", () => {
  test("dot2 and residual2 are the exact values of the doubles rounded once", () => {
    const [a, b] = [R3[0]!, R3[1]!];
    expect(dot2(a, b)).toBe(exactDot(a, b));
    const rhs = 1e-3;
    const exact = Q.of(rhs).sub(a.reduce((s, x, i) => s.add(Q.of(x).mul(Q.of(b[i]!))), new Q(0n))).toNumber();
    expect(residual2(rhs, a, b)).toBe(exact);
    // the plain loop misses on the same data, so these assertions have teeth
    expect(a.reduce((s, x, i) => s + x * b[i]!, 0)).not.toBe(exactDot(a, b));
  });
});

describe("covarianceMatrix and correlationMatrix", () => {
  test("every covariance entry of the SPX, ETH and DXY returns is the exact sample covariance, bit for bit", () => {
    expect(R3[0]!.length).toBeGreaterThan(1000);
    const C = covarianceMatrix(R3);
    R3.forEach((a, i) => R3.forEach((b, j) => expect(C[i]![j]).toBe(exactCov(a, b))));
  });
  test("every off-diagonal correlation is the exact Pearson value; the diagonal is exactly 1", () => {
    const P = correlationMatrix(R3);
    R3.forEach((a, i) => R3.forEach((b, j) => expect(P[i]![j]).toBe(i === j ? 1 : exactPearson(a, b))));
    expect(correlationMatrix([[1, 1, 1], [1, 2, 3]])[0]![0]).toBeNaN(); // a constant series
  });
  test("the same returns times 1e160 and times 1e-155 give the scaled exact values", () => {
    for (const k of [1e160, 1e-155]) {
      const xs = R3.map((r) => r.map((v) => v * k));
      const C = covarianceMatrix(xs);
      xs.forEach((a, i) => xs.forEach((b, j) => expect(C[i]![j]).toBe(exactCov(a, b))));
      const P = correlationMatrix(xs);
      xs.forEach((a, i) => xs.forEach((b, j) => i !== j && expect(P[i]![j]).toBe(exactPearson(a, b))));
    }
  });
  test("refusals: no series, unequal lengths, too few observations, non-finite input", () => {
    expect(() => covarianceMatrix([])).toThrow(UnsupportedError);
    expect(() => covarianceMatrix([[1, 2], [1]])).toThrow(/unequal length/);
    expect(() => covarianceMatrix([[1]])).toThrow(/n=1 with ddof=1/);
    expect(() => covarianceMatrix([[1, NaN, 2]])).toThrow(/non-finite/);
    expect(() => correlationMatrix([[1, 2], [1]])).toThrow(/unequal length/);
  });
});

/** U diag(sigma) V' for random orthonormal U, V (fixed LCG): a dense n x n matrix of 2-norm condition 10^logc. */
function conditioned(n: number, logc: number, rnd: () => number): number[][] {
  const orth = (): number[][] => {
    const Qs: number[][] = [];
    while (Qs.length < n) {
      let v = Array.from({ length: n }, rnd);
      for (const q of Qs) {
        const d = v.reduce((s, x, i) => s + x * q[i]!, 0);
        v = v.map((x, i) => x - d * q[i]!);
      }
      const nr = Math.hypot(...v);
      Qs.push(v.map((x) => x / nr));
    }
    return Qs;
  };
  const U = orth();
  const V = orth();
  const sigma = Array.from({ length: n }, (_, i) => 10 ** ((-logc * i) / (n - 1)));
  return U.map((u) => V.map((v) => u.reduce((a, ui, k) => a + ui * sigma[k]! * v[k]!, 0)));
}

describe("solveRefined", () => {
  test("the 4x4 real covariance: the correctly rounded exact solution", () => {
    const A = covA();
    const b = [1, 2, 3, 4];
    expect(solveRefined(A, b)).toEqual(exactSolve(A, b));
  });
  test("Hilbert 8 (cond1 about 3e10): the correctly rounded exact solution, which the plain LU misses", () => {
    const H = hilbert(8);
    const b = H.map((_, i) => 1 + i / 7);
    const want = exactSolve(H, b);
    expect(solveRefined(H, b)).toEqual(want);
    // teeth: one LU solve without refinement is thousands of ulps out
    const plain = gaussPlain(H, b);
    expect(Math.max(...plain.map((x, i) => relErr(x, want[i]!)))).toBeGreaterThan(1e-10);
  });
  test("a badly scaled but easy matrix is balanced by powers of two and solved, not refused", () => {
    expect(solveRefined([[1, 0], [0, 1e-17]], [1, 1])).toEqual(exactSolve([[1, 0], [0, 1e-17]], [1, 1]));
    const f = [1e-12, 1, 1e10, 3e-7];
    const A = covA().map((row, i) => row.map((v, j) => v * f[i]! * f[j]!));
    const b = [1e-12, 2, 3e10, 4e-7];
    const x = solveRefined(A, b);
    exactSolve(A, b).forEach((want, i) => expect(relErr(x[i]!, want)).toBeLessThanOrEqual(ONE_ROUNDING));
  });
  test("fails closed: Hilbert 14, a singular matrix, a non-square matrix and a NaN entry throw UnsupportedError", () => {
    expect(() => solveRefined(hilbert(14), new Array<number>(14).fill(1))).toThrow(UnsupportedError);
    expect(() => solveRefined(hilbert(14), new Array<number>(14).fill(1))).toThrow(/condition number|did not converge/);
    expect(() => solveRefined([[1, 2], [2, 4]], [1, 2])).toThrow(/singular/);
    expect(() => solveRefined([[1, 2, 3], [4, 5, 6]], [1, 2])).toThrow(/not square/);
    expect(() => solveRefined([[1, 2, 3], [4, 5, 6]], [1, 2])).toThrow(UnsupportedError);
    expect(() => solveRefined([[1, NaN], [0, 1]], [1, 2])).toThrow(/non-finite/);
    expect(() => solveRefined([[1, 0], [0, 1]], [1, 2, 3])).toThrow(/right-hand side/);
  });
  test("near cond 1e14 to 3e15, every returned solution is within one rounding of the exact one; the rest throw", () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const outcome = { returned: 0, notConverged: 0, illConditioned: 0 };
    for (let t = 0; t < 120; t++) {
      const A = conditioned(5, 14 + (t % 12) * 0.125, rnd);
      const b = Array.from({ length: 5 }, rnd);
      let x: number[];
      try {
        x = solveRefined(A, b);
      } catch (e) {
        expect(e).toBeInstanceOf(UnsupportedError);
        if (/did not converge/.test(String(e))) outcome.notConverged++;
        else if (/condition number/.test(String(e))) outcome.illConditioned++;
        else throw e;
        continue;
      }
      outcome.returned++;
      exactSolve(A, b).forEach((want, i) => expect(relErr(x[i]!, want)).toBeLessThanOrEqual(ONE_ROUNDING));
    }
    expect(outcome.returned).toBeGreaterThan(100);
    expect(outcome.notConverged).toBeGreaterThan(0); // the fail-closed branch is exercised
  });
});

/** Gaussian elimination with partial pivoting and plain arithmetic, no refinement: the teeth baseline. */
function gaussPlain(A: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j] = M[r]![j]! - f * M[c]![j]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

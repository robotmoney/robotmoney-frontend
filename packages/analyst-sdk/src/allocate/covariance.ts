// The shrunk covariance the optimizers take (decision D78): the annualized
// sample covariance of daily return rows, shrunk toward its diagonal. Ported
// from rosemarys-baby src/computations/fourbucket.ts (annualCov,
// shrinkToDiagonal, shrunkCov, SHRINK). The sample covariance is
// transform/linalg.ts covarianceMatrix, each entry the correctly rounded exact
// value; annualizing and shrinking each round once more.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
import { covarianceMatrix, unsupported, type Mat } from "../transform/linalg.ts";

/** Default shrinkage toward the diagonal: 20 percent. */
export const SHRINK = 0.2;

/** Default periods per year for annualizing daily returns: 252 trading days. */
export const PERIODS_PER_YEAR = 252;

/**
 * Annualized sample covariance (ddof 1) of `rows` = days x variables: entry by
 * entry, covarianceMatrix of the columns times `periodsPerYear` (one rounding).
 */
export function annualCov(rows: Mat, periodsPerYear = PERIODS_PER_YEAR): number[][] {
  if (rows.length === 0) return unsupported("annualCov", "no return rows");
  if (!(Number.isFinite(periodsPerYear) && periodsPerYear > 0)) return unsupported("annualCov", `periodsPerYear ${periodsPerYear} must be positive and finite`);
  const k = rows[0]!.length;
  if (rows.some((r) => r.length !== k)) return unsupported("annualCov", "return rows of unequal length");
  return covarianceMatrix(Array.from({ length: k }, (_, j) => rows.map((row) => row[j]!))).map((row) => row.map((x) => x * periodsPerYear));
}

/**
 * S shrunk `s` toward its diagonal: each off-diagonal entry times (1 - s), one
 * rounding; the diagonal is kept exactly ((1 - s) x + s x differs from x by an
 * ulp for about a third of x).
 */
export function shrinkToDiagonal(S: Mat, s = SHRINK): number[][] {
  if (!(Number.isFinite(s) && s >= 0 && s <= 1)) return unsupported("shrinkToDiagonal", `shrinkage ${s} must lie in [0, 1]`);
  return S.map((row, i) => row.map((x, j) => (i === j ? x : (1 - s) * x)));
}

/** Annualized sample covariance of `rows` = days x variables, shrunk `s` (default SHRINK) toward its diagonal. */
export function shrunkCov(rows: Mat, s = SHRINK, periodsPerYear = PERIODS_PER_YEAR): number[][] {
  return shrinkToDiagonal(annualCov(rows, periodsPerYear), s);
}

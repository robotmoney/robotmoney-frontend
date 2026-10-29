// Issue 1513 (tunable backtests): the building blocks a client tunes a backtest
// with are exported from the package entry, src/index.ts, and return plain data.
import { describe, expect, test } from "bun:test";
import * as sdk from "../src/index.ts";

describe("package entry exports the tunable building blocks", () => {
  test("markowitzBooks, markowitzSchedule, simulateDrift and periodStats are functions on the package entry", () => {
    for (const name of ["markowitzBooks", "markowitzSchedule", "simulateDrift", "periodStats"] as const) {
      expect(typeof sdk[name]).toBe("function");
    }
  });
  test("the solvers, the shrunk covariance, the linear algebra and the rest of the Markowitz workflow are exported too", () => {
    for (const name of [
      "markowitzSizing", "markowitzBacktest", "simulatePortfolio", "ercExact", "ercCertified", "minVarExact", "meanVarExact",
      "tangencyExact", "supports", "ercResidual", "minVarResidual", "meanVarResidual", "sharpeResidual", "annualCov",
      "shrinkToDiagonal", "shrunkCov", "covarianceMatrix", "correlationMatrix", "solveRefined", "UnsupportedError",
    ] as const) {
      expect(typeof sdk[name]).toBe("function");
    }
    expect([sdk.SHRINK, sdk.ERC_TOL, sdk.MIN_OBS, sdk.LAMBDA, sdk.ZERO_TOL]).toEqual([0.2, 4e-15, 252, 4, 1e-12]);
  });
  test("markowitzBooks returns plain data that survives a JSON round trip", () => {
    const rows = [[0.01, -0.02], [-0.005, 0.03], [0.002, 0.001], [0.004, -0.01]];
    const books = sdk.markowitzBooks({ returns: rows, assets: ["a", "b"], rf: 0.01, mu: { a: 0.06, b: 0.08 }, lambdas: [4] });
    expect(JSON.parse(JSON.stringify(books))).toEqual(books);
  });
});

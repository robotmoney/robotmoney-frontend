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

// Issue 1655: the fill-policy and day-completeness API is on the package entry,
// and MAX_FORWARD_FILL_DAYS stays exported as the value every registry row declares.
describe("package entry exports the fill-policy and complete-day API", () => {
  test("fill policies, day completeness and the incomplete result are exported; MAX_FORWARD_FILL_DAYS stays 120", () => {
    for (const name of ["fillPolicyOf", "fillMaxAgeDays", "FillPolicyError", "latestCompleteDay", "missingOnDay", "requireComplete", "IncompleteDayError", "forwardFillAge"] as const) {
      expect(typeof sdk[name]).toBe("function");
    }
    expect(sdk.MAX_FORWARD_FILL_DAYS).toBe(120);
  });
});

// Issue 1554: the backtest client surface a client copies is on the package
// entry; forwardFillDaily and computeBacktestWithFill stay off it.
describe("package entry exports the backtest client helpers", () => {
  test("parsePlainDecimal, PLAIN_DECIMAL, referenceStrategies and REFERENCE_FILL_POLICIES are exported", () => {
    for (const name of ["parsePlainDecimal", "referenceStrategies"] as const) expect(typeof sdk[name]).toBe("function");
    expect(sdk.PLAIN_DECIMAL).toBeInstanceOf(RegExp);
    expect(Object.keys(sdk.REFERENCE_FILL_POLICIES)).toEqual(["spx", "eth", "tbill3m"]);
    expect(sdk.UNKNOWN_LABEL_RULE).toBe("refuse");
    expect(sdk.DEFAULT_SIMULATOR_FILL).toEqual({ kind: "forward", maxAgeDays: null, reason: "Reproduces the undeclared carry" });
    expect("forwardFillDaily" in sdk).toBe(false);
    expect("computeBacktestWithFill" in sdk).toBe(false);
  });
});

// Issue 1751: the options and building blocks a downstream regime model needs
// are on the package entry.
describe("package entry exports the downstream regime model surface (issue 1751)", () => {
  test("fitPanelWeights and weightedMeanOnDay are functions on the package entry", () => {
    for (const name of ["fitPanelWeights", "weightedMeanOnDay"] as const) expect(typeof sdk[name]).toBe("function");
  });
  test("the rules, the derived series, the report functions and the archive member read are exported", () => {
    for (const name of [
      "regimeRulesOf", "deriveSeries", "DerivedSeriesError", "StoredRatioOnlyError", "selectPublications", "publishesOver", "canonicalStringify",
      "shapeRegimeSnapshots", "rowToSnapshot", "forHistory", "computeRegimeSnapshotStaleness", "buildRichIndicators", "monthlySparkline",
      "runVintageMembers", "CalendarError", "calendarOf",
    ] as const) {
      expect(typeof sdk[name], name).toBe("function");
    }
    expect(Object.keys(sdk.REGIME_RULES)).toEqual(["v3", "v4", "v5"]);
    expect(sdk.REGIME_KNOWLEDGE_TIME).toEqual({ v3: false, v4: true, v5: false });
    expect(sdk.REGIME_OBSERVATION_WINDOWS).toEqual({ v3: false, v4: true, v5: false });
    expect(sdk.REGIME_MISSING_PANEL).toEqual({ v3: "rebase", v4: "nan", v5: "rebase" });
    expect(sdk.REGIME_LABEL_CUT).toEqual({ v3: "percentile", v4: "series", v5: "series" });
  });
});

// Issue 1753: methodology v5 and its kept record are on the package entry.
describe("package entry exports methodology v5 and the kept record (issue 1753)", () => {
  test("the kept-record functions and the building blocks they read are functions on the package entry", () => {
    for (const name of [
      "computeKeptRegime", "keptRegimeRows", "withDerivedSeries", "scoreDays", "fitDay", "keptDayOf", "walkForward", "deriveKeptRecord",
      "panelMean", "smoothRegimes", "bucketFn", "derivedInputIds", "seriesMappingFor", "storedUnderFor",
    ] as const) {
      expect(typeof sdk[name], name).toBe("function");
    }
  });
  test("the v5 declarations are exported: the line, the registry, the derived series and the backtest rules", () => {
    expect(sdk.REGIME_LINE).toEqual({ v3: "main", v4: "main", v5: "beside" });
    expect(sdk.BESIDE_REGIME_VERSIONS).toEqual(["v5"]);
    expect(sdk.REGIME_COMPOSITE_NORMALISATION).toEqual({ v3: "none", v4: "none", v5: "percentile" });
    expect(sdk.REGIME_KEPT_HISTORY).toEqual({ v3: false, v4: false, v5: true });
    expect(sdk.REGIME_REGISTRY.v4).toBe(sdk.INDICATORS);
    expect(sdk.REGIME_REGISTRY.v5).toBe(sdk.V5_INDICATORS);
    expect(sdk.REGIME_DERIVED_SERIES.v5).toBe(sdk.V5_DERIVED_SERIES);
    expect(Object.keys(sdk.REGIME_BACKTEST_RULES)).toEqual(["v3", "v4", "v5"]);
    expect(Object.keys(sdk.V5_INPUT_IDS)).toEqual(["deficit", "gdp", "vix3m", "vix", "skew", "volume", "close"]);
  });
});

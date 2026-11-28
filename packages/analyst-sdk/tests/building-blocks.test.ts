// Issue 1765 (decision D95; proposal section 6.5): the package entry '.'
// (src/index.ts) exports every building block the workbench imports by deep
// path, so a downstream model reaches none of them through a path into src/.
//
// The names below are the workbench's imports from
// @robotmoney/analyst-sdk-0.7.0/<path> and -0.8.0/<path> at workbench commit
// 15c2918 (robotmoney/workbench, read only; it is never a dependency):
//   rg -o 'import \{[^}]*\} from "@robotmoney/analyst-sdk-0\.[78]\.0/[^"]*"' src
// plus the multi-line and `import type` forms of the same, the members it reads
// through `import * as Q from .../allocate/optimize.ts`, and the SDK names it
// reads through `export * from .../transform/exact.ts` (its src/lib/exact.ts).
// Each name is listed under the src module the workbench imports it from, and
// '.' must export that same binding (a type: the same declaration).
//
// Left out on purpose:
//   - bin/ paths: openBackupsDir and readSupplementary touch the file system,
//     and the fs edge is './node', never '.'.
//   - forwardFillDaily: issue 1554 keeps it off the entry (tests/exports.test.ts).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import * as sdk from "../src/index.ts";
import * as covariance from "../src/allocate/covariance.ts";
import * as engine from "../src/allocate/engine.ts";
import * as markowitz from "../src/allocate/markowitz.ts";
import * as optimize from "../src/allocate/optimize.ts";
import * as allocateTypes from "../src/allocate/types.ts";
import * as backtest from "../src/analyze/backtest.ts";
import * as compute from "../src/analyze/compute.ts";
import * as correlations from "../src/analyze/correlations.ts";
import * as indicators from "../src/analyze/indicators.ts";
import * as load from "../src/input/load.ts";
import * as supplementary from "../src/input/supplementary.ts";
import * as prepare from "../src/prepare.ts";
import * as run from "../src/run.ts";
import * as seriesIds from "../src/series-ids.ts";
import * as exact from "../src/transform/exact.ts";
import * as grid from "../src/transform/grid.ts";
import * as linalg from "../src/transform/linalg.ts";
import * as math from "../src/transform/math.ts";
import * as ratios from "../src/transform/ratios.ts";
import * as transforms from "../src/transform/transforms.ts";

const SRC = join(import.meta.dir, "..", "src");

// The values, by the src module the workbench imports them from.
const VALUES: ReadonlyArray<readonly [string, Record<string, unknown>, readonly string[]]> = [
  ["allocate/covariance.ts", covariance, ["SHRINK", "annualCov", "shrinkToDiagonal", "shrunkCov"]],
  ["allocate/engine.ts", engine, ["tiltWeight"]],
  ["allocate/markowitz.ts", markowitz, ["LAMBDA", "MIN_OBS", "canonZero", "markowitzBacktest", "markowitzBooks", "markowitzSchedule"]],
  ["allocate/optimize.ts", optimize, [
    "ercCertified", "ercResidual", "meanVarExact", "meanVarResidual", "minVarExact", "minVarResidual", "sharpeResidual", "tangencyExact", "sharpeRatio", "supports",
  ]],
  ["allocate/types.ts", allocateTypes, ["RULE_STATES"]],
  ["analyze/backtest.ts", backtest, [
    "BACKTEST_COST_PER_REBALANCE", "BACKTEST_IN_SAMPLE_END", "PORTFOLIO_SPECS", "REFERENCE_FILL_POLICIES", "YEAR_MS", "combineAggressiveN",
    "combineConservativeN", "computeBacktest", "driftedWeight", "periodStats", "referenceStrategies", "scheduleFromLabels", "simulateDrift",
    "simulatePortfolio", "stripDailyFromSnapshot",
  ]],
  ["analyze/compute.ts", compute, ["bucketFn", "computeRegime", "smoothRegimes"]],
  ["analyze/correlations.ts", correlations, ["computeCorrelations", "spearman"]],
  ["analyze/indicators.ts", indicators, ["INDICATORS", "MAX_FORWARD_FILL_DAYS", "PANELS", "ROLLING_WINDOW_DAYS", "fillMaxAgeDays", "fillPolicyOf", "isRatioIndicator"]],
  ["index.ts", sdk, ["requireComplete", "runRegime", "toHistory"]],
  ["input/load.ts", load, ["inputHistory", "isCalendarDate", "parseRawJson"]],
  ["input/supplementary.ts", supplementary, ["formatSupplementaryCsv", "openSupplementary", "parseSupplementaryCsv", "serializeSupplementaryManifest", "supplementaryPaths"]],
  ["prepare.ts", prepare, ["cutAtAsof", "prepareRegimeInputs"]],
  ["run.ts", run, ["BACKFILL_START", "EXTRA_IDS"]],
  ["series-ids.ts", seriesIds, ["ratioLegSourceId", "resolveInputHistory"]],
  ["transform/exact.ts", exact, [
    "Compounder", "correlation", "ddDiv", "ddDivD", "ddValue", "dotDD", "mean2", "meanAndSampleSd", "median", "periodicRate", "quantile", "sharpeDD",
    "stdDD", "sumDD", "twoSum",
    // Read through the workbench's `export * from .../transform/exact.ts`.
    "annualizedGrowth", "centeredCrossDD", "dot2", "residual2", "sum2", "twoProd",
  ]],
  ["transform/grid.ts", grid, ["mergeRatioSeries"]],
  ["transform/linalg.ts", linalg, ["correlationMatrix", "covarianceMatrix", "solveRefined", "unsupported"]],
  ["transform/math.ts", math, [
    "MAX_FORWARD_FILL_DAYS", "alignDailyForwardFill", "buildDateAxis", "forwardFillAge", "inverseCorrelationWeights", "lcg", "rollingBeta", "rollingPercentileRank",
  ]],
  ["transform/ratios.ts", ratios, ["ratiosFromLegs"]],
  ["transform/transforms.ts", transforms, ["applyTransform"]],
];

// The types, by the src module the workbench imports them from.
const TYPES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["allocate/markowitz.ts", ["Book", "CovFn", "MarkowitzRebalance"]],
  ["allocate/optimize.ts", ["Mat"]],
  ["analyze/backtest.ts", [
    "BacktestExtras", "BacktestLabels", "BacktestMetrics", "BacktestPayload", "DriftOptions", "Schedule", "SimulationResult", "SimulatorFill", "TradeEvidence", "Weights",
  ]],
  ["analyze/compute.ts", ["RegimeComputeResult"]],
  ["analyze/correlations.ts", ["CorrelationsPayload"]],
  ["analyze/indicators.ts", ["Indicator", "Panel"]],
  ["index.ts", ["RawIndicatorHistory"]],
  ["input/supplementary.ts", ["SupplementaryManifest", "SupplementaryReader"]],
  ["transform/exact.ts", ["DD"]],
  ["types.ts", ["Point", "RawIndicatorHistory"]],
];

// Off the entry on purpose (see the header).
const NOT_ON_ENTRY = ["openBackupsDir", "readSupplementary", "forwardFillDaily"];

const entry = sdk as Record<string, unknown>;

describe("'.' exports every building block the workbench imports by deep path (workbench 15c2918)", () => {
  for (const [path, mod, names] of VALUES) {
    test(`the values the workbench imports from ${path} are the same bindings on '.'`, () => {
      for (const name of names) {
        expect(Object.hasOwn(mod, name), `${path} no longer exports ${name}`).toBe(true);
        expect(Object.hasOwn(entry, name), `'.' does not export ${name}`).toBe(true);
        expect(entry[name], `'.' exports another ${name} than ${path}`).toBe(mod[name]);
      }
    });
  }

  test("the types the workbench imports are exported from '.', each the declaration of the deep module", () => {
    const options: ts.CompilerOptions = {
      noEmit: true, allowImportingTsExtensions: true, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext, skipLibCheck: true, types: [],
    };
    const files = [...new Set(["index.ts", ...TYPES.map(([p]) => p)])].map((p) => join(SRC, p));
    const program = ts.createProgram(files, options);
    const checker = program.getTypeChecker();
    const resolve = (s: ts.Symbol): ts.Symbol => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
    const exportsOf = (path: string): Map<string, ts.Symbol> => {
      const file = program.getSourceFile(join(SRC, path));
      if (!file) throw new Error(`no source file ${path}`);
      return new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(file)!).map((s) => [s.name, resolve(s)]));
    };
    const onEntry = exportsOf("index.ts");
    expect(onEntry.size).toBeGreaterThan(400);
    for (const [path, names] of TYPES) {
      const deep = exportsOf(path);
      for (const name of names) {
        expect(deep.has(name), `${path} no longer exports the type ${name}`).toBe(true);
        expect(onEntry.has(name), `'.' does not export the type ${name}`).toBe(true);
        expect(onEntry.get(name) === deep.get(name), `'.' exports another ${name} than ${path}`).toBe(true);
      }
    }
    // Red control: a name '.' does not export is reported missing.
    expect(onEntry.has("NoSuchBuildingBlock")).toBe(false);
  });

  test("the file-system edge and forwardFillDaily stay off '.'", () => {
    for (const name of NOT_ON_ENTRY) expect(Object.hasOwn(entry, name), name).toBe(false);
  });
});

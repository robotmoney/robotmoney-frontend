export * from "./types.ts";
export * from "./input/load.ts";
export * from "./run.ts";
export { prepareRegimeInputs, type PreparedRegimeInputs } from "./prepare.ts";
export { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
export { INDICATORS, PANELS, type Indicator, type Panel } from "./analyze/indicators.ts";
export { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
export {
  computeBacktest, stripDailyFromSnapshot, simulatePortfolio, simulateDrift, periodStats, scheduleFromLabels, PORTFOLIO_SPECS,
  BACKTEST_COST_PER_REBALANCE, BACKTEST_IN_SAMPLE_END, YEAR_MS,
  type BacktestPayload, type BacktestMetrics, type Weights, type Schedule, type SimulateOptions, type SimulationResult,
  type TradeEvidence, type PeriodStatsOptions, type DriftOptions, type RebalanceFrequency,
} from "./analyze/backtest.ts";
export * from "./input/manifest.ts";
export {
  parseCopyCsv, toObjects, selectBackups, listedFiles, verifyFile, seriesForStorageKey, serializeInputs, RunInputCollector,
  ArchiveError, INPUT_TABLES, type BackupRecord, type FileRecord, type GeneratedRow, type RunIdentity, type RunInputs,
} from "./archive/format1.ts";
export {
  openArchive, collectRunInputs, type ArchiveFiles, type LocalCopy, type RevisedTable, type LatestValue,
} from "./archive/local-copy.ts";
export type { Row as ArchiveRow } from "./archive/format1.ts";
export { CURRENT_REGIME_VERSION } from "./analyze/regime-versions.ts";
export { forwardFillAge, MAX_FORWARD_FILL_DAYS } from "./transform/math.ts";
export { quantile, median } from "./transform/exact.ts";
export { LEDGER_EXTRA_KEYS, type LedgerExtra } from "./extras.ts";
export * from "./series-ids.ts";
export { CoverageError, assertRequiredCoverage } from "./coverage.ts";
export * from "./allocate/universe.ts";
export * from "./allocate/types.ts";
export * from "./allocate/rules.ts";
export {
  loadInventory, requireCoverage, collectedByInventory, InventoryError, InventoryCoverageError, CALENDAR_SLACK_DAYS, INVENTORY_FIELDS,
  type Inventory, type InventorySeries, type InventoryProxy, type CoverageGap,
} from "./inventory.ts";
export * from "./allocate/labels.ts";
export * from "./allocate/signals.ts";
export {
  computeChannelDivergence, computeLateCycle, TOP7, type ChannelInputs, type LateCycleInputs,
} from "./analyze/research-signals.ts";
export type { Gauge, ResearchPayload } from "./analyze/research.ts";
export * from "./allocate/engine.ts";
export { covarianceMatrix, correlationMatrix, solveRefined, UnsupportedError, type Mat, type Vec } from "./transform/linalg.ts";
export {
  ercExact, ercCertified, ERC_TOL, minVarExact, meanVarExact, tangencyExact, supports, riskContributions, ercResidual,
  minVarResidual, meanVarResidual, sharpeRatio, sharpeResidual, type ErcResult,
} from "./allocate/optimize.ts";
export { SHRINK, PERIODS_PER_YEAR, annualCov, shrinkToDiagonal, shrunkCov } from "./allocate/covariance.ts";
export {
  markowitzBooks, markowitzSizing, markowitzSchedule, markowitzBacktest, canonZero, ZERO_TOL, MIN_OBS, LAMBDA,
  type Book, type MarkowitzBooksInput, type MarkowitzBooks, type MarkowitzSizingInput, type MarkowitzSizing,
  type Reoptimise, type MuFn, type CovFn, type SolveFn, type ExpandFn, type MarkowitzScheduleOptions,
  type MarkowitzRebalance, type MarkowitzScheduleResult, type Simulator, type MarkowitzBacktestOptions,
  type MarkowitzBacktestResult,
} from "./allocate/markowitz.ts";

export * from "./types.ts";
export * from "./input/load.ts";
export * from "./run.ts";
export {
  prepareRegimeInputs, latestCompleteDay, missingOnDay, knowledgeTimeHistory, cutAtAsof, type PreparedRegimeInputs, type MissingIndicator,
} from "./prepare.ts";
export {
  PublicationRuleError, publicationRuleOf, publishedOn, knownOn, isProvisional, knowledgeTimeSeries,
  type PublicationRule, type VersionedPoint, type KnownPoint,
} from "./transform/knowledge-time.ts";
export {
  deriveSeries, derivedInputIds, DerivedSeriesError, V5_DERIVED_SERIES,
  type DerivedSeries, type DerivedLevel, type DerivedRatio, type DerivedRollingSumOverKnownLevel, type DerivedUpVolumeShare,
} from "./transform/derived.ts";
export { computeRegime, regimeLabels, fitPanelWeights, weightedMeanOnDay, panelMean, smoothRegimes, bucketFn, WeightAnchorOutOfRangeError, type RegimeComputeResult } from "./analyze/compute.ts";
// The kept record of a methodology that keeps its history (v5, issue 1753).
export {
  computeKeptRegime, keptRegimeRows, withDerivedSeries, scoreDays, fitDay, keptDayOf, walkForward, deriveKeptRecord,
  type KeptDay, type DayScores, type DayFit, type KeptRecord, type KeptOptions, type KeptRegimeRun,
} from "./analyze/kept-regime.ts";
export {
  INDICATORS, PANELS, ALL_PANELS, PANEL_MEMBERSHIP, FillPolicyError, fillPolicyOf, fillMaxAgeDays, DAY_RULE, DAY_RULES,
  CalendarError, calendarOf, V5_INDICATORS, V5_INPUT_IDS, ROLLING_WINDOW_DAYS, isRatioIndicator,
  type Indicator, type Panel, type PanelMembership, type FillPolicy, type DayRule, type Calendar,
} from "./analyze/indicators.ts";
// The report functions the backend shares (issue 1751): one copy, pure.
export { selectPublications, publishesOver, type PublicationCandidate } from "./report/publication.ts";
export { canonicalStringify, canonicalArtifactBytes, type RegimeSnapshotRow } from "./report/canonical.ts";
export {
  rowToSnapshot, forHistory, shapeRegimeSnapshots, computeRegimeSnapshotStaleness, computeRegimeStaleness, panelObservationDates,
  overallObservationDate, REGIME_STALE_THRESHOLD_DAYS,
  type RegimeSnapshot, type RegimeHistoryPoint, type RegimeStaleness, type RegimeIndicator,
} from "./report/regime-snapshots.ts";
export { buildRichIndicators, monthlySparkline } from "./report/indicator-rows.ts";
// One snapshot column table (issue 1765): every row mapper reads it.
export { SNAPSHOT_COLUMNS, type SnapshotColumn, type SnapshotColumnKind, type SnapshotKey } from "./report/snapshot-columns.ts";
// The replay module (issue 1765): the row builder, the comparison and the replay of a published run.
export * from "./replay/index.ts";
export { computeCorrelations, spearman, type CorrelationsPayload, type CorrelationInput } from "./analyze/correlations.ts";
export {
  computeBacktest, stripDailyFromSnapshot, simulatePortfolio, simulateDrift, periodStats, scheduleFromLabels, PORTFOLIO_SPECS,
  combineConservativeN, combineAggressiveN, driftedWeight, type BacktestExtras,
  BACKTEST_COST_PER_REBALANCE, BACKTEST_IN_SAMPLE_END, REGIME_BACKTEST_RULES, YEAR_MS,
  referenceStrategies, REFERENCE_FILL_POLICIES, REFERENCE_CALENDARS, discountToYield, SparseSeriesError, MAX_DAILY_MEDIAN_GAP_DAYS, splitSamples, DEFAULT_SIMULATOR_FILL, UNKNOWN_LABEL_RULE,
  type BacktestLabels, type DeclaredFill, type SimulatorFill, type UnknownLabelRule,
  type BacktestPayload, type BacktestMetrics, type Weights, type Schedule, type SimulateOptions, type SimulationResult,
  type TradeEvidence, type PeriodStatsOptions, type SampleBlock, type ReferenceBacktestOptions, type MarketCalendar, type CostBps, type DriftOptions, type RebalanceFrequency,
  type CashBasis, type SharpeBasis,
} from "./analyze/backtest.ts";
export * from "./input/manifest.ts";
export {
  parseCopyCsv, toObjects, selectBackups, listedFiles, verifyFile, seriesForStorageKey, serializeInputs, RunInputCollector,
  ArchiveError, INPUT_TABLES, type BackupRecord, type FileRecord, type GeneratedRow, type RunIdentity, type RunInputs,
} from "./archive/format1.ts";
export {
  openArchive, collectRunInputs, runVintageMembers, type ArchiveFiles, type Archive, type RevisedTable, type LatestValue,
} from "./archive/reader.ts";
export type { Row as ArchiveRow } from "./archive/format1.ts";
export {
  CURRENT_REGIME_VERSION,
  REGIME_LOOKBACK,
  REGIME_VERSIONS,
  REGIME_WEIGHT_REFRESH,
  REGIME_KNOWLEDGE_TIME,
  REGIME_OBSERVATION_WINDOWS,
  REGIME_MISSING_PANEL,
  REGIME_LABEL_CUT,
  REGIME_LINE,
  BESIDE_REGIME_VERSIONS,
  REGIME_ARTIFACT_KIND,
  REGIME_PUBLISHED_PANELS,
  regimeArtifactKindOf,
  type RegimeArtifactKind,
  REGIME_REGISTRY,
  REGIME_DERIVED_SERIES,
  REGIME_COMPOSITE_NORMALISATION,
  REGIME_KEPT_HISTORY,
  REGIME_RULES,
  regimeRulesOf,
  isRefreshDate,
  isRegimeVersion,
  refreshDateOn,
  adoptionDate,
  AdoptionDateError,
  REGIME_ADOPTION_DATE,
  type WeightRefresh,
  type MissingPanelRule,
  type LabelCut,
  type RegimeLine,
  type CompositeNormalisation,
  type RegimeRules,
  type LookbackWindow,
  type RegimeLookback,
  type RegimeVersion,
} from "./analyze/regime-versions.ts";
// The model value (issue 1765): the published presets, modelOf, and each preset's storage.
export {
  MODELS, modelOf, seriesMappingFor, storedUnderFor, type RegimeModel, type ModelFacts, type ModelHistory, type ModelPanels,
} from "./model/index.ts";
export {
  forwardFillAge, MAX_FORWARD_FILL_DAYS, alignDailyForwardFill, buildDateAxis, inverseCorrelationWeights, lcg, rollingBeta, rollingPercentileRank,
} from "./transform/math.ts";
export {
  quantile, median, Compounder, correlation, ddDiv, ddDivD, ddValue, dotDD, mean2, meanAndSampleSd, periodicRate, sharpeDD, stdDD, sumDD, twoSum,
  annualizedGrowth, centeredCrossDD, dot2, residual2, sum2, twoProd, type DD,
} from "./transform/exact.ts";
// Building blocks the workbench imports by deep path (issue 1765, D95; tests/building-blocks.test.ts).
export { applyTransform } from "./transform/transforms.ts";
export { mergeRatioSeries } from "./transform/grid.ts";
export { ratiosFromLegs } from "./transform/ratios.ts";
export {
  supplementaryPaths, formatSupplementaryCsv, parseSupplementaryCsv, serializeSupplementaryManifest, openSupplementary,
  type SupplementaryManifest, type SupplementaryReader,
} from "./input/supplementary.ts";
export { LEDGER_EXTRA_KEYS, type LedgerExtra } from "./extras.ts";
export * from "./series-ids.ts";
export { CoverageError, assertRequiredCoverage } from "./coverage.ts";
export * from "./allocate/universe.ts";
export * from "./allocate/types.ts";
export * from "./allocate/rules.ts";
export {
  loadInventory, loadResearchSeriesInventory, inventoryCollection, COLLECTION_START, requireCoverage, collectedByInventory, InventoryError, InventoryCoverageError, CALENDAR_SLACK_DAYS, INVENTORY_FIELDS,
  type Inventory, type InventorySeries, type InventoryProxy, type CoverageGap,
} from "./inventory.ts";
export * from "./allocate/labels.ts";
export * from "./allocate/signals.ts";
export {
  computeChannelDivergence, computeLateCycle, TOP7, type ChannelInputs, type LateCycleInputs,
} from "./analyze/research-signals.ts";
export type { Gauge, ResearchPayload } from "./analyze/research.ts";
export * from "./allocate/engine.ts";
export { covarianceMatrix, correlationMatrix, solveRefined, UnsupportedError, unsupported, type Mat, type Vec } from "./transform/linalg.ts";
export {
  ercExact, ercCertified, ERC_TOL, minVarExact, meanVarExact, tangencyExact, supports, riskContributions, ercResidual,
  minVarResidual, meanVarResidual, sharpeRatio, sharpeResidual, type ErcResult,
} from "./allocate/optimize.ts";
export { SHRINK, PERIODS_PER_YEAR, annualCov, shrinkToDiagonal, shrunkCov } from "./allocate/covariance.ts";
export {
  markowitzBooks, markowitzSizing, markowitzSchedule, markowitzBacktest, canonZero, ZERO_TOL, MIN_OBS, LAMBDA,
  type Book, type MarkowitzBooksInput, type MarkowitzBooks, type MarkowitzSizingInput, type MarkowitzSizing,
  type Reoptimise, type RebalanceContext, type MuFn, type CovFn, type SolveFn, type ExpandFn, type MarkowitzScheduleOptions,
  type MarkowitzRebalance, type MarkowitzScheduleResult, type Simulator, type MarkowitzBacktestOptions,
  type MarkowitzBacktestResult,
} from "./allocate/markowitz.ts";

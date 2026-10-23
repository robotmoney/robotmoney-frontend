export * from "./types.ts";
export * from "./input/load.ts";
export * from "./run.ts";
export { prepareRegimeInputs, type PreparedRegimeInputs } from "./prepare.ts";
export { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
export { INDICATORS, PANELS, type Indicator, type Panel } from "./analyze/indicators.ts";
export { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
export { computeBacktest, stripDailyFromSnapshot, type BacktestPayload } from "./analyze/backtest.ts";
export { CURRENT_REGIME_VERSION } from "./analyze/regime-versions.ts";
export { forwardFillAge, MAX_FORWARD_FILL_DAYS } from "./transform/math.ts";
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

// The regime engine (issue 1765, phase 2; proposal section 6.3). Pure: no fs,
// env, db or network.
//
//   prepare.ts    the model's input through prepareRegimeInputs (the D59 seam)
//   score.ts      every registry indicator scored once per axis
//   fit.ts        panel weights on the days a driver fits
//   combine.ts    panel indices, the composite over `included`, its normalisation, percentiles, labels
//   history.ts    the drivers: recompute (every day) and kept (the D96 kept record)
//   cache.ts      the caller-owned stage cache
//   run-model.ts  runModel: one model over one input, the RunResult shape
//
// computeRegime (analyze/compute.ts), computeKeptRegime (analyze/kept-regime.ts)
// and runRegime (run.ts) are thin wrappers over these.
export { prepareModel, withDerivedSeries, type PrepareModel } from "./prepare.ts";
export { scoreIndicators, lookbackDays, engineWindows, observationMask, type ScoreOptions, type StageScores } from "./score.ts";
export { fitPanels, fitPanelWeights, refitDays, fitInForce, panelIndicators, WeightAnchorOutOfRangeError, type PanelFit } from "./fit.ts";
export {
  combinePanels, panelIndexSeries, weightedMeanOnDay, panelMean, regimeLabels, smoothRegimes, bucketFn, CONFIRMATION_DAYS, FAST_TRACK_SIGMA, SIGMA_LOOKBACK_DAYS,
  type CombineOptions, type Combined,
} from "./combine.ts";
export {
  recomputeHistory, keptHistory, keptRecord, keptScores, keptFits, keptDay, keptComputeResult, assertKeptRules,
  type RegimeComputeResult, type RecomputeInputs, type RecomputeOptions, type KeptDay, type DayScores, type DayFit, type KeptRecord,
  type KeptRegimeRun, type KeptSettings, type StageMemo, type StageName,
} from "./history.ts";
export { stageCache, stageKey, inputDigest, cacheMemo, STAGES, type StageCache } from "./cache.ts";
export {
  runModel, BACKFILL_START, EXTRA_IDS, type RunModelOptions, type ModelRun, type PanelSetRun, type RunResult, type RunPrepared, type InSampleEnd,
} from "./run-model.ts";

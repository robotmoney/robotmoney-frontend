// The published regime rows of a run, for every methodology version (issue
// 1765, phase 1). Pure. The one place a run's rows are built: the producer
// freezes these rows as the run's regime artifact, and a replay builds them
// again to compare. Ported from the backend's buildSnapshotRows (recomputing
// versions) and the SDK's keptRegimeRows (versions that keep their history),
// which is now a thin wrapper over this.
//
// A recomputing run (v3, v4) publishes a row for every day with a label
// (result.regime[i] set). A kept run (v5) publishes a row for every day it
// computed that has a composite mean; its composite and label are null before
// the record holds enough means, and it has no trailing percentile. Every row
// carries the panel indices and labels and the sign-aligned score of each
// indicator of the run's registry, rounded to six places. The as-of row also
// carries the indicator details, the panel weights (with their fit date, unless
// the version refits on the run's last day), the panels, the backtest and the
// correlations: exactly the 21 keys the builder writes, never bucketThresholds
// or extras (SNAPSHOT_COLUMNS, builderEmits).
import type { RegimeSnapshotRow } from "../report/canonical.ts";
import { buildRichIndicators } from "../report/indicator-rows.ts";
import { ALL_PANELS, INDICATORS, type Indicator, type Panel } from "../analyze/indicators.ts";
import { REGIME_REGISTRY, REGIME_WEIGHT_REFRESH } from "../analyze/regime-versions.ts";
import type { KeptRegimeRun } from "../analyze/kept-regime.ts";
import type { RunPrepared, RunResult } from "../run.ts";

/** The dashboard-level blobs and the provenance a run's rows carry. */
export interface PublishedRowsOptions {
  /** The row provenance (the run's source label: live, hermetic, fixture, seed). Default null. */
  source?: string | null;
  /** The as-of row's backtest. Default the run's own (RunResult.backtest), else null. */
  backtest?: unknown | null;
  /** The as-of row's correlations. Default the run's own (RunResult.correlations), else null. */
  correlations?: unknown | null;
  /** A kept run: its scoring registry (default REGIME_REGISTRY of its version). A recomputing run: overrides the registry it carries. */
  indicators?: readonly Indicator[];
  /** A kept run: every panel it computed and publishes (default ALL_PANELS). */
  panels?: readonly Panel[];
  /** A recomputing run: its prepared inputs, when the run does not carry them (a run copied by spreading). */
  prepared?: Omit<RunPrepared, "indicators"> & { indicators?: readonly Indicator[] };
}

const nn = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const isKeptRun = (run: RunResult | KeptRegimeRun): run is KeptRegimeRun => "record" in run && "computed" in run;

/** The sign-aligned score of each registry indicator on a day, rounded to six places: the row's percentiles. */
function percentilesOf(indicators: readonly Indicator[], scoreOf: (id: string) => number | undefined): Record<string, number> {
  const percentiles: Record<string, number> = {};
  for (const ind of indicators) {
    const s = scoreOf(ind.id);
    if (typeof s === "number" && Number.isFinite(s)) percentiles[ind.id] = Number(s.toFixed(6));
  }
  return percentiles;
}

/**
 * The rows a run publishes, in the stored row shape and the builder's key
 * order. `run` is a RunResult from runRegime (factor: true), or a
 * KeptRegimeRun from computeKeptRegime. A RunResult under rules that keep their
 * history carries its kept run, and gets the kept rows.
 */
export function publishedRows(run: RunResult | KeptRegimeRun, opts: PublishedRowsOptions = {}): RegimeSnapshotRow[] {
  if (isKeptRun(run)) return keptRows(run, opts);
  if (run.keptRun) {
    const panels = opts.panels ?? (Object.keys(run.keptRun.record.panelIndices) as Panel[]);
    return keptRows(run.keptRun, { ...opts, indicators: opts.indicators ?? run.registry ?? INDICATORS, panels, ...blobsOf(run, opts) });
  }
  return recomputedRows(run, opts);
}

const blobsOf = (run: RunResult, opts: PublishedRowsOptions) => ({
  backtest: opts.backtest !== undefined ? opts.backtest : (run.backtest ?? null),
  correlations: opts.correlations !== undefined ? opts.correlations : (run.correlations ?? null),
});

// A recomputing run (backend buildSnapshotRows, verbatim): `r2` the run over its
// panels (the composite), `r3` the run over every panel (the factor figures).
function recomputedRows(run: RunResult, opts: PublishedRowsOptions): RegimeSnapshotRow[] {
  const r2 = run.result;
  const r3 = run.factor;
  if (!r3) throw new RangeError("publishedRows reads the factor panel of a run made with factor: true; this run has none");
  const prepared = opts.prepared ?? run.prepared;
  if (!prepared) throw new RangeError("publishedRows needs the run's prepared inputs: pass a run as runRegime returned it, or opts.prepared");
  const { transformed, lastRaw, ages } = prepared;
  const indicators = opts.indicators ?? prepared.indicators ?? run.registry ?? REGIME_REGISTRY[run.version];
  const { backtest, correlations } = blobsOf(run, opts);
  const { dateAxis, version } = run;
  const source = opts.source ?? null;
  const rows: RegimeSnapshotRow[] = [];
  const lastIdx = dateAxis.length - 1;
  for (let i = 0; i < dateAxis.length; i++) {
    if (!r2.regime[i]) continue; // days without enough history to classify are skipped
    const isLatest = i === lastIdx;
    // The rich per-indicator objects (with sparkline and point-in-time panel
    // weight) and the panel weights are the as-of view; history rows carry the
    // numeric columns and the percentiles map.
    const panelWeights = isLatest
      ? {
          macro: r2.weightsByPanel.macro!,
          onchain: r2.weightsByPanel.onchain!,
          factor: r3.weightsByPanel.factor!,
          // The fit date of those weights (issue 1739). v3 keeps its stored payload byte for byte.
          ...(REGIME_WEIGHT_REFRESH[version].refitOnLastDay ? {} : { weightFitDate: r2.weightFitDate }),
        }
      : null;
    rows.push({
      date: dateAxis[i]!,
      composite: nn(r2.composite[i]),
      compositePercentile: nn(r2.compositePercentile[i]),
      regime: r2.regime[i] ?? null,
      macroRegime: r2.macroRegime?.[i] ?? null,
      onchainRegime: r2.onchainRegime?.[i] ?? null,
      factorRegime: r3.factorRegime?.[i] ?? null,
      macroIndex: nn(r2.macroIndex?.[i]),
      onchainIndex: nn(r2.onchainIndex?.[i]),
      factorIndex: nn(r3.factorIndex?.[i]),
      macroPercentile: nn(r2.macroPercentile?.[i]),
      onchainPercentile: nn(r2.onchainPercentile?.[i]),
      factorPercentile: nn(r3.factorPercentile?.[i]),
      panelWeights,
      version,
      source,
      percentiles: percentilesOf(indicators, (id) => r2.signed[id]?.[i]),
      indicators: isLatest ? buildRichIndicators(i, r2, r3, transformed, lastRaw, dateAxis, ages, indicators) : [],
      // Every panel's index card, included in the composite or not (ALL_PANELS, D89).
      panels: isLatest ? [...ALL_PANELS] : null,
      backtest: isLatest ? backtest : null,
      correlations: isLatest ? correlations : null,
    });
  }
  return rows;
}

// A kept run (the former body of keptRegimeRows, verbatim).
function keptRows(run: KeptRegimeRun, opts: PublishedRowsOptions): RegimeSnapshotRow[] {
  const indicators = opts.indicators ?? REGIME_REGISTRY[run.version];
  const panels = opts.panels ?? ALL_PANELS;
  const { record, dateAxis, scores, prepared } = run;
  const at = new Map(dateAxis.map((d, i) => [d, i]));
  const lastIdx = dateAxis.length - 1;
  const asofScores = { ranks: scores.ranks, signed: scores.signed, weightsByPanel: run.fit.weightsByPanel };
  const rows: RegimeSnapshotRow[] = [];
  for (const day of run.computed) {
    const i = at.get(day.date)!;
    if (!Number.isFinite(record.compositeMean[i])) continue;
    const isAsof = i === lastIdx;
    rows.push({
      date: day.date,
      composite: nn(record.composite[i]),
      compositePercentile: null,
      regime: record.regime[i] ?? null,
      macroRegime: record.panelRegimes.macro?.[i] ?? null,
      onchainRegime: record.panelRegimes.onchain?.[i] ?? null,
      factorRegime: record.panelRegimes.factor?.[i] ?? null,
      macroIndex: nn(record.panelIndices.macro?.[i]),
      onchainIndex: nn(record.panelIndices.onchain?.[i]),
      factorIndex: nn(record.panelIndices.factor?.[i]),
      macroPercentile: null,
      onchainPercentile: null,
      factorPercentile: null,
      panelWeights: isAsof ? { ...Object.fromEntries(panels.map((p) => [p, run.fit.weightsByPanel[p]!])), weightFitDate: day.date } : null,
      version: run.version,
      source: opts.source ?? null,
      percentiles: percentilesOf(indicators, (id) => day.signed?.[id]),
      indicators: isAsof ? buildRichIndicators(i, asofScores, asofScores, prepared.transformed, prepared.lastRaw, dateAxis, prepared.ages, indicators) : [],
      panels: isAsof ? [...panels] : null,
      backtest: isAsof ? (opts.backtest ?? null) : null,
      correlations: isAsof ? (opts.correlations ?? null) : null,
    });
  }
  return rows;
}

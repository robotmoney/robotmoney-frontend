// The compute stage of an analytics run (issue 1765, phase 3; proposal section
// 6.4). Committed data only: nothing here calls a source.
//
// One model, one engine call: computeModel runs the SDK's runModel once over
// the model's input (inputs.ts) and builds its published rows with the SDK's
// one row builder, publishedRows, once. The model value says everything the
// run does: its registry and derived series, its rules, whether it keeps its
// history (model.history picks the engine: a kept model reads its kept days
// before the as-of day and computes only that day, or walks every day on its
// first run), its panels and its backtest rules. No version is compared here.
//
// The correlations and the backtest stay on the platform, over the run's
// composite and the price extras the run collected, so a failure there
// degrades the run to a warning and the rows carry no blob, as before
// (runModel's own extras step skips them when a price series is empty, which
// would change the rows of a run whose extras are empty).
//
// computeResearch computes the two research signals (channel divergence, late
// cycle) from the research inputs extract collected.
import { assertRequiredCoverage } from "./coverage.ts";
import { cutAtAsof } from "./prepare.ts";
import { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestPayload } from "./analyze/backtest.ts";
import { computeChannelDivergence, computeLateCycle } from "./analyze/research-signals.ts";
import { REGIME_LINE, type RegimeVersion } from "./analyze/regime-versions.ts";
import type { Panel } from "./analyze/indicators.ts";
import { runModel } from "../../../packages/analyst-sdk/src/engine/run-model.ts";
import type { KeptDay } from "../../../packages/analyst-sdk/src/engine/history.ts";
import type { RegimeModel } from "../../../packages/analyst-sdk/src/model/models.ts";
// The one row builder of every methodology version lives in the SDK (issue 1765).
import { publishedRows } from "./report/published-rows.ts";
import { canonicalStringify } from "./output-snapshots.ts";
import { sha256Hex } from "./run-ledger.ts";
import { BACKFILL_START } from "../../../packages/analyst-sdk/src/engine/run-model.ts";
import type { AnalyticsPersistence } from "./persistence.ts";
import type { Logger, ResearchInputs } from "./access/data-source.ts";
import type { ModelInputs, StageLog } from "./inputs.ts";
import type { LedgerRun } from "./publish.ts";
import type { RawIndicatorHistory } from "./types.ts";

const nn = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface ComputeModelInput {
  /** The tag the run is stamped with (every row's `version`). */
  version: RegimeVersion;
  model: RegimeModel;
  /** The day the regime scores (the day rule's answer; the as-of day by default). */
  day: string;
  inputs: ModelInputs;
  /** The panels the composite averages, 1/n each (default model.panels.included). */
  panels?: readonly Panel[];
  /** Reads the kept days of a model that keeps its history. */
  persistence: AnalyticsPersistence;
  logger: Logger;
}

/**
 * Compute one model's regime for its run: one runModel call and one
 * publishedRows call. The rows are captured on the run for its terminal
 * package and published nowhere else (issue #978 AC2: the single publisher of
 * regime_snapshots is applyCurrentProjections, inside the terminal package's
 * transaction, for a run that reached a usable outcome), and the run's
 * `results.regime` is its report.
 */
export async function computeModel(run: LedgerRun, x: ComputeModelInput): Promise<void> {
  const { version, model, day, inputs, logger } = x;
  const log: StageLog = run.collector;
  const { registry } = inputs;
  // With no composite panel holding any observation nothing can be
  // classified: a named coverage error, never a fetch (issue 1421).
  assertRequiredCoverage(registry, day, undefined, model.registry);

  let t0 = new Date();
  // A model that keeps its history (v5, issue 1753): the kept days before the
  // as-of day are the published line itself. With none this is the first run:
  // it walks forward from its own inputs.
  const keeps = model.history === "kept";
  let kept: KeptDay[] = [];
  let keptRead: Awaited<ReturnType<NonNullable<AnalyticsPersistence["loadKeptRegimeDays"]>>> | null = null;
  if (keeps) {
    keptRead = await x.persistence.loadKeptRegimeDays!(version, day);
    kept = keptRead.days.map((d) => ({
      date: d.date,
      panelIndices: { macro: d.macroIndex ?? NaN, onchain: d.onchainIndex ?? NaN, factor: d.factorIndex ?? NaN },
    }));
  }
  let extras = inputs.extras;
  if (day !== run.asof) extras = { spx: cutAtAsof(extras.spx, day), eth: cutAtAsof(extras.eth, day), tbill3m: cutAtAsof(extras.tbill3m, day) };
  const included = x.panels ?? model.panels.included;
  const panels = model.panels.all;
  // The engine (the SDK's runModel): the composite over `included`, and every
  // panel in the same fit (factor). `ages` keeps the global-cap mask of a
  // recomputing model; a kept model reads none.
  const result = runModel(model, registry, {
    asof: day,
    start: BACKFILL_START,
    version,
    included: [...included],
    panels: [...panels],
    factor: true,
    kept,
    extras: false,
    droppedRatios: inputs.droppedRatios,
  });
  const { dateAxis } = result;
  const composite = result.result;
  log.stage("transform", "ok", `built ${dateAxis.length}-day date axis and aligned/transformed ${model.registry.length} indicator(s)`, t0);

  t0 = new Date();
  // Predictive correlations + regime backtest, from the composite (the run
  // over the included panels) and the chart-overlay extras. Baked onto the
  // as-of row. The backtest runs under the model's rule row
  // (REGIME_BACKTEST_RULES, issue 1753).
  let backtest: BacktestPayload | null = null;
  let correlations: CorrelationsPayload | null = null;
  let analyzeStatus: "ok" | "warn" = "ok";
  try {
    correlations = computeCorrelations(dateAxis, composite, extras);
    backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, composite, extras, model.backtest));
  } catch (e: any) {
    logger.error?.(`[analytics] backtest/correlations failed: ${e?.message ?? e}`);
    log.warn("analyze", `backtest/correlations failed: ${e?.message ?? e}`);
    analyzeStatus = "warn";
  }
  const last = dateAxis.length - 1;
  const figure = {
    composite: nn(composite.composite[last]),
    compositePercentile: nn(composite.compositePercentile[last]),
    regime: composite.regime[last] ?? null,
  };
  log.stage("analyze", analyzeStatus, `computed regime ${version} composite=${figure.composite} regime=${figure.regime ?? "insufficient_history"}`, t0);
  log.artifact("analyze", "regime-composite", figure);

  t0 = new Date();
  // The SDK's one row builder: a recomputing run's rows from its composite,
  // its every-panel run and its prepared inputs; a kept run's from its kept
  // record (the run carries both as non-enumerable properties).
  const rows = publishedRows(result, { source: run.sourceLabel, backtest, correlations, panels });
  log.stage("report", "ok", `built ${rows.length} snapshot row(s) for persistence`, t0);
  t0 = new Date();
  run.regimeRows = rows;
  log.stage("store", "ok", `captured ${rows.length} regime snapshot row(s) for the terminal run package`, t0);

  run.results.regime = {
    asof: day,
    rows: rows.length,
    ...figure,
    // A kept run's report names its methodology and what its kept days were
    // read from, so the run replays from its vintage plus these frozen
    // artifacts: the kept days are their rows dated before the as-of day, a
    // later artifact's row replacing an earlier one's for the same date.
    ...(keptRead ? { methodology: version, kept: { days: kept.length, artifactIds: keptRead.artifactIds, sha256: sha256Hex(canonicalStringify(keptRead.days)) } } : {}),
  };
  // `regime asof D` is the line the standing soak check reads for the main line
  // (scripts/lib/gate/standing.ts R8.x); a line beside it names its version.
  const tag = REGIME_LINE[version] === "main" ? "" : ` ${version}`;
  const tail = keptRead ? `${rows.length} rows, ${kept.length} kept days` : `${rows.length} rows`;
  logger.log?.(`[analytics] regime${tag} asof ${day}: composite=${figure.composite} regime=${figure.regime ?? "insufficient_history"} (${tail})`);
}

/** Which research signals a run computes. */
export interface ResearchWanted {
  channelDivergence: boolean;
  lateCycle: boolean;
}

/**
 * The two research signals, from the research inputs extract collected. The
 * payloads are captured on the run for its terminal package (issue #978 AC2)
 * and its results. STABLES is a registry indicator: it comes from the regime's
 * committed input when the run computed one, else from the persisted floor.
 */
export function computeResearch(
  run: LedgerRun,
  x: { inputs: ResearchInputs; floor: RawIndicatorHistory; regimeInput: RawIndicatorHistory | null; wanted: ResearchWanted; logger: Logger },
): void {
  const { inputs, logger } = x;
  const log: StageLog = run.collector;
  const asof = run.asof;
  let t0 = new Date();
  if (x.wanted.channelDivergence) {
    t0 = new Date();
    // STABLES is a registry indicator → source it from the committed raw
    // floor (matching channel-divergence.js, which reads raw-indicator-history.csv).
    const stables = x.regimeInput?.STABLES ?? x.floor.STABLES ?? [];
    const bundle = { btc: inputs.btc, qqq: inputs.qqq, spy: inputs.spy, stables };
    log.stage(
      "transform",
      "ok",
      `assembled channel-divergence input bundle (btc=${bundle.btc.length}, qqq=${bundle.qqq.length}, spy=${bundle.spy.length}, stables=${bundle.stables.length} points)`,
      t0,
    );

    t0 = new Date();
    const payload = computeChannelDivergence(bundle, asof);
    log.stage("analyze", "ok", "computed channel-divergence signal", t0);
    log.artifact("report", "channel-divergence-signal", payload);

    // Captured, not published (issue #978 AC2).
    t0 = new Date();
    run.researchSignals.push({ key: "channel-divergence", date: asof, payload });
    log.stage("store", "ok", "captured channel-divergence research signal for the terminal run package", t0);

    run.results["channel-divergence"] = payload;
  }

  if (x.wanted.lateCycle) {
    const refresh = inputs.mnaRefresh;
    if (refresh) {
      // `tier=` and `degrade=` are load-bearing, not decoration (issue
      // #509): without them there is no way — from a log or from the
      // persisted telemetry — to answer "did the weekly reconciliation
      // sweep ever actually run, and if it degraded, why?". Producer
      // downtime across the single full-sweep weekday, or a weekday-only
      // PRODUCER_RESEARCH_CRON, otherwise disables reconciliation
      // indefinitely, silently and with no catch-up.
      logger.log?.(
        `[analytics] EDGAR MNA refresh: status=${refresh.status} tier=${refresh.tier}` +
          (refresh.fellBackFromFullSweep ? " (fell back from the full sweep)" : "") +
          (refresh.degradeKind ? ` degrade=${refresh.degradeKind}` : "") +
          ` planned=${refresh.plannedMonths} ` +
          `new=${refresh.newMonths} revised=${refresh.revisedMonths} fetched=${refresh.fetchedMonths} ` +
          `missing=${refresh.missingMonths} rejected=${refresh.rejectedMonths}`,
      );
      // Persisted checkpoint: research_pipeline_artifacts row, queryable
      // per asof through the admin telemetry projection — the durable
      // record of WHICH tier this asof actually executed.
      log.artifact("access", "edgar-refresh", {
        asof,
        tier: refresh.tier,
        status: refresh.status,
        degradeKind: refresh.degradeKind ?? null,
        fellBackFromFullSweep: refresh.fellBackFromFullSweep ?? false,
        plannedMonths: refresh.plannedMonths,
        fetchedMonths: refresh.fetchedMonths,
        missingMonths: refresh.missingMonths,
        rejectedMonths: refresh.rejectedMonths,
        reason: refresh.reason ?? null,
      });
    }
    t0 = new Date();
    const bundle = { spy: inputs.spy, rsp: inputs.rsp, top7: inputs.top7, mna: inputs.mna, margin: inputs.margin, conf: inputs.conf };
    log.stage("transform", "ok", `assembled late-cycle-signals input bundle (mna=${bundle.mna.length} points)`, t0);

    if (refresh?.status === "degraded") {
      // HONESTY (issue #109 AC5): an incomplete incremental refresh must
      // NEVER turn into a recomputed/published late-cycle signal — no
      // partial history, no partial signal. Retain the last-good
      // persisted floor AND signal untouched this run.
      logger.warn?.(
        `[analytics] late-cycle-signals: EDGAR refresh degraded (${refresh.reason}) — ` +
          "retaining last-good signal, NOT recomputing/publishing this run",
      );
      log.warn("analyze", `EDGAR MNA refresh degraded (tier=${refresh.tier} degrade=${refresh.degradeKind}: ${refresh.reason}) — retaining last-good signal, not recomputing`);
      log.stage("analyze", "warn", `skipped recompute: EDGAR refresh degraded (${refresh.reason})`, t0);
      log.stage("store", "warn", "skipped — retained last-good persisted signal, nothing new written", new Date());
      run.results["late-cycle-signals"] = { skipped: true, reason: refresh.reason };
    } else {
      // The fresh MNA rows were persisted in the extract stage.
      t0 = new Date();
      const payload = computeLateCycle(bundle, asof);
      log.stage("analyze", "ok", "computed late-cycle-signals signal", t0);
      log.artifact("report", "late-cycle-signals-signal", payload);

      // Captured, not published (issue #978 AC2).
      t0 = new Date();
      run.researchSignals.push({ key: "late-cycle-signals", date: asof, payload });
      log.stage("store", "ok", "captured late-cycle-signals research signal for the terminal run package", t0);
      run.results["late-cycle-signals"] = payload;
    }
  }
}

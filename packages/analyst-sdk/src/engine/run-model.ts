// runModel: one run of one regime model (issue 1765, phase 2; proposal sections
// 6.2 and 6.3). Pure: no fs, env, db or network.
//
// The model value says everything the run does: its registry and derived
// series (the prepare stage), its rules (every stage), whether it keeps its
// history (the driver), its panels and its backtest rules. runModel prepares
// the input once, runs the model's driver (engine/history.ts) over every panel
// set asked for, and adds the correlations and the backtest the way runRegime
// always has. runRegime (run.ts) is runModel behind its option checks, its
// input resolution and its day rule; replayRun (replay/replay.ts) calls it with
// a run's kept days.
//
// The input is the run's input under the ids the model reads (its registry
// ids, the raw inputs of its derived series, and the price extras SPX, ETH and
// TBILL3M): what computeKeptRegime takes, after the ratio step. Rows dated
// after the as-of day are never read.
//
// With `cache` (engine/cache.ts), each stage's value is stored and reused by a
// later run of the same input whose stage params are the same, so a research
// variant recomputes only the stages it changes.
import type { Point, RawIndicatorHistory } from "../types.ts";
import { ALL_PANELS, INDICATORS, type Indicator, type Panel } from "../analyze/indicators.ts";
import { CURRENT_REGIME_VERSION, REGIME_VERSIONS, isRegimeVersion, type RegimeVersion } from "../analyze/regime-versions.ts";
import { computeCorrelations, type CorrelationsPayload } from "../analyze/correlations.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestPayload } from "../analyze/backtest.ts";
import { LEDGER_EXTRA_KEYS } from "../extras.ts";
import { cutAtAsof, type PreparedRegimeInputs } from "../prepare.ts";
import { modelOf, type RegimeModel } from "../model/models.ts";
import { cacheMemo, type StageCache } from "./cache.ts";
import { prepareModel } from "./prepare.ts";
import { keptComputeResult, keptHistory, recomputeHistory, type KeptDay, type KeptRegimeRun, type RegimeComputeResult, type StageMemo } from "./history.ts";

/** The first day of every published regime axis (the regime backfill start). */
export const BACKFILL_START = "2018-01-01";
// Indicator ids in the input that carry price levels for correlations/backtest.
export const EXTRA_IDS = {
  spx: LEDGER_EXTRA_KEYS.spx.inputId,
  eth: LEDGER_EXTRA_KEYS.eth.inputId,
  tbill3m: LEDGER_EXTRA_KEYS.tbill3m.inputId,
} as const;

/**
 * The in-sample end of the backtest (issue 1751). "current-version" (the
 * default, decision D94 item 3): the split the model's backtest rules state.
 * "computed-version": the adoption date of the model's rules.
 */
export type InSampleEnd = "current-version" | "computed-version";

/** What publishedRows (src/replay/rows.ts) reads of a recomputing run's prepared inputs (issue 1765). */
export interface RunPrepared extends Pick<PreparedRegimeInputs, "transformed" | "lastRaw" | "ages"> {
  // The scoring registry the run computed.
  readonly indicators: readonly Indicator[];
}

export interface RunResult {
  kind: "complete";
  // The methodology version the run is stamped with (RunOptions.version).
  version: RegimeVersion;
  dateAxis: string[];
  result: RegimeComputeResult;
  // The run over every panel (ALL_PANELS), present only when the run was made
  // with factor: true. Its factor_* figures are the factor panel's. `result`
  // keeps the composite and labels over the run's panels. When those panels
  // are ALL_PANELS in order (the default, D89) the two are one computation,
  // and `factor` is `result` itself (issue 1765, D-e).
  factor?: RegimeComputeResult;
  correlations?: CorrelationsPayload;
  backtest?: BacktestPayload;
  // Coverage entry (issue 1751): the id of each ratio declared ratioInput
  // "legs" that the run dropped (weight 0) because the input carries its stored
  // ratio and neither selected leg. Empty when none was dropped.
  droppedRatios: string[];
  // The scoring registry of the run, only when it is not INDICATORS (a v5 run,
  // issue 1753): buildReport lists these indicators.
  registry?: readonly Indicator[];
  // What the row builder (publishedRows, src/replay/rows.ts) reads besides the
  // result (issue 1765). Both are non-enumerable properties, so no JSON, report
  // or CLI byte of a run changes, and a copy made by spreading drops them.
  // `prepared`: a recomputing run's prepared inputs and its scoring registry.
  readonly prepared?: RunPrepared;
  // `keptRun`: a run under rules that keep their history, the kept run itself.
  readonly keptRun?: KeptRegimeRun;
}

/** The result of one panel set of a run. */
export interface PanelSetRun {
  readonly panels: readonly Panel[];
  readonly result: RegimeComputeResult;
}

/**
 * One run of a model: the RunResult shape (the same JSON bytes runRegime
 * gives) plus, as non-enumerable properties, the model, the prepared inputs and
 * one result per distinct panel set (`included` first).
 */
export interface ModelRun extends RunResult {
  readonly model: RegimeModel;
  readonly prepared: RunPrepared & PreparedRegimeInputs;
  readonly panelSets: readonly PanelSetRun[];
}

export interface RunModelOptions {
  /** The last day of the axis (YYYY-MM-DD). Input rows dated after it are never read. */
  asof: string;
  /** The first day of the axis (default BACKFILL_START). */
  start?: string;
  /** A model that keeps its history: the kept days before `asof`. With none the run is a first run and walks every day. */
  kept?: readonly KeptDay[];
  /** The panels the composite averages, 1/n each, in this order (default model.panels.included). `result` is the run over them. */
  included?: readonly Panel[];
  /** Every panel computed (default model.panels.all); it holds `included`. A kept model's record and fits cover exactly these. */
  panels?: readonly Panel[];
  /** Also set RunResult.factor, the run over `panels`. It is `result` itself when the two lists are equal. */
  factor?: boolean;
  /** A recomputing model: mask a day whose forward-fill age passes the global cap before the rank (default true). A kept model reads no ages. */
  ages?: boolean;
  /** Compute the correlations and the backtest from the price extras of the input, when present (default true). */
  extras?: boolean;
  /** The stage cache to read and fill (engine/cache.ts). Without it every stage is computed. */
  cache?: StageCache;
  /** The tag the run is stamped with (RunResult.version). Default the model's id when it is a published tag, else the current version. */
  version?: RegimeVersion;
  /** The backtest's in-sample end (default "current-version"). */
  inSampleEnd?: InSampleEnd;
  /** The ratios the caller's ratio step dropped, carried as RunResult.droppedRatios (default none). */
  droppedRatios?: readonly string[];
}

const KNOWN_OPTIONS: readonly string[] = ["asof", "start", "kept", "included", "panels", "factor", "ages", "extras", "cache", "version", "inSampleEnd", "droppedRatios"];

// A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-45, "").
export function assertIsoDate(name: string, v: unknown): asserts v is string {
  const ok = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!ok) throw new RangeError(`${name} must be a real date in YYYY-MM-DD form, got ${JSON.stringify(v)}`);
}

/** A non-empty list of distinct panels, each one of ALL_PANELS; a RangeError names `name` otherwise. */
export function assertPanelList(name: string, panels: unknown): asserts panels is readonly Panel[] {
  if (!Array.isArray(panels) || panels.length === 0 || new Set(panels).size !== panels.length || panels.some((p) => !ALL_PANELS.includes(p))) {
    throw new RangeError(`${name} must be a non-empty list of distinct panels from ${ALL_PANELS.join(", ")}, got ${JSON.stringify(panels)}`);
  }
}

const samePanels = (a: readonly Panel[], b: readonly Panel[]): boolean => a.length === b.length && a.every((p, i) => p === b[i]);

// Attach a value a run carries without it being serialised.
export function hidden<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, { value, enumerable: false });
  return target;
}

/**
 * Run `model` (a published tag, or a RegimeModel checked by modelOf) over
 * `input` as of `opts.asof`. A RangeError names a bad option, a kept day that
 * is not before the as-of day, kept days given to a model that recomputes, or
 * rules the kept record cannot run.
 */
export function runModel(model: RegimeVersion | RegimeModel, input: RawIndicatorHistory, opts: RunModelOptions): ModelRun {
  const m = modelOf(model);
  if (opts === null || typeof opts !== "object") throw new RangeError("runModel needs options with at least { asof }");
  for (const k of Object.keys(opts)) {
    if (!KNOWN_OPTIONS.includes(k)) throw new RangeError(`unknown option ${JSON.stringify(k)}; expected ${KNOWN_OPTIONS.join(", ")}`);
  }
  const { asof } = opts;
  const start = opts.start ?? BACKFILL_START;
  assertIsoDate("asof", asof);
  assertIsoDate("start", start);
  if (asof < start) throw new RangeError(`asof ${asof} is before start ${start}`);
  const version = opts.version ?? (isRegimeVersion(m.id) ? m.id : CURRENT_REGIME_VERSION);
  if (!isRegimeVersion(version)) throw new RangeError(`version must be one of ${REGIME_VERSIONS.join(", ")}, got ${JSON.stringify(opts.version)}`);
  const included = opts.included ?? m.panels.included;
  const panels = opts.panels ?? m.panels.all;
  assertPanelList("included", included);
  assertPanelList("panels", panels);
  const outside = included.filter((p) => !panels.includes(p));
  if (outside.length > 0) throw new RangeError(`included panels ${outside.join(", ")} are not in panels ${panels.join(", ")}`);
  for (const k of ["factor", "ages", "extras"] as const) {
    if (opts[k] !== undefined && typeof opts[k] !== "boolean") throw new RangeError(`${k} must be a boolean, got ${JSON.stringify(opts[k])}`);
  }
  const inSampleEnd = opts.inSampleEnd ?? "current-version";
  if (inSampleEnd !== "current-version" && inSampleEnd !== "computed-version") {
    throw new RangeError(`inSampleEnd must be "current-version" or "computed-version", got ${JSON.stringify(opts.inSampleEnd)}`);
  }
  const kept = opts.kept ?? [];
  if (!Array.isArray(kept)) throw new RangeError("kept must be a list of kept days");
  const keeps = m.history === "kept";
  if (!keeps && kept.length > 0) throw new RangeError(`model ${m.id} recomputes its history: it reads no kept days`);
  if (keeps && opts.ages === true) throw new RangeError(`model ${m.id} keeps its history: its scores read no forward-fill ages`);
  for (const d of kept) if (!(d.date < asof)) throw new RangeError(`kept day ${d.date} is not before the as-of day ${asof}`);

  // The prepare stage's params: what prepareRegimeInputs and withDerivedSeries read.
  const prepareParams = { start, asof, registry: m.registry, derived: m.derived, knowledgeTime: m.rules.knowledgeTime, observationWindows: m.rules.observationWindows };
  const memo: StageMemo = opts.cache ? cacheMemo(opts.cache, input, prepareParams) : (_stage, _params, compute) => compute();
  const prepared = memo("prepare", () => ({}), () => prepareModel(input, m, { start, asof }));
  const { dateAxis } = prepared;

  let result: RegimeComputeResult;
  let factor: RegimeComputeResult | undefined;
  let sets: PanelSetRun[];
  let keptRun: KeptRegimeRun | undefined;
  const inc = [...included];
  if (keeps) {
    keptRun = keptHistory(prepared, { version, rules: m.rules, indicators: m.registry, panels, included, kept, memo });
    result = keptComputeResult(keptRun, inc);
    const all = samePanels(included, panels) ? null : keptComputeResult(keptRun, [...panels]);
    sets = [{ panels: included, result }, ...(all ? [{ panels, result: all }] : [])];
    if (opts.factor) factor = all ?? keptComputeResult(keptRun, [...panels]);
  } else {
    const same = samePanels(included, panels);
    // Over one list the second set would repeat the first (D-e): `factor` is `result` itself.
    const over = same ? [inc] : [inc, [...panels]];
    const results = recomputeHistory(
      { dateAxis, transformed: prepared.transformed, ...(opts.ages === false ? {} : { ages: prepared.ages }), carried: prepared.carried },
      { rules: m.rules, indicators: m.registry, panelSets: over, memo },
    );
    result = results[0]!;
    sets = over.map((p, i) => ({ panels: p, result: results[i]! }));
    if (opts.factor) factor = same ? result : results[1]!;
  }

  const head = { kind: "complete" as const, version, dateAxis, result, droppedRatios: [...(opts.droppedRatios ?? [])] };
  // A kept run names its registry when it is not INDICATORS (buildReport lists it); a recomputing run never has.
  const out: RunResult = keeps && m.registry !== INDICATORS ? { ...head, registry: m.registry } : head;
  if (factor) out.factor = factor;
  if (opts.extras !== false) {
    const cut = (id: string): Point[] => cutAtAsof(input[id] ?? [], asof);
    const spx = cut(EXTRA_IDS.spx);
    const eth = cut(EXTRA_IDS.eth);
    const tbill3m = cut(EXTRA_IDS.tbill3m);
    if (spx.length && eth.length) {
      out.correlations = computeCorrelations(dateAxis, result, { spx, eth });
      if (tbill3m.length) {
        const rules = inSampleEnd === "computed-version" ? { ...m.backtest, splitDate: m.rules.adoptionDate } : m.backtest;
        out.backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, result, { spx, eth, tbill3m }, rules));
      }
    }
  }
  hidden(out, "prepared", { ...prepared, indicators: m.registry });
  if (keptRun) hidden(out, "keptRun", keptRun);
  hidden(out, "model", m);
  hidden(out, "panelSets", sets);
  return out as ModelRun;
}

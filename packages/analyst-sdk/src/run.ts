// Replay raw indicator history through the regime pipeline. This is the same
// path backend/tests/regime-fidelity.test.ts replays: prepareRegimeInputs (the
// seam production shares: align each registry indicator, forward-fill or
// zero-fill, apply its transform and its fill policy), then the regime engine
// (src/engine/, issue 1765): runRegime checks its options, resolves the input
// names, sets each ratio from its legs, applies the day rule and calls runModel.
// Run semantics (as-of, fill policy, complete days, replay):
// docs/technical/regime-engine.md section 8.1; the seam is D59 in docs/decisions.md.
// Optional SPX, ETH and TBILL3M price series in
// the same input add the correlation and backtest output.
import type { RawIndicatorHistory } from "./types.ts";
import { ALL_PANELS, DAY_RULE, DAY_RULES, INDICATORS, PANELS, type DayRule, type Indicator, type Panel } from "./analyze/indicators.ts";
import type { RegimeComputeResult } from "./analyze/compute.ts";
import { CURRENT_REGIME_VERSION, REGIME_VERSIONS, isRegimeVersion, regimeRulesOf, type RegimeRules, type RegimeVersion } from "./analyze/regime-versions.ts";
import { cutAtAsof, latestCompleteDay, missingOnDay, type MissingIndicator } from "./prepare.ts";
import { StoredRatioOnlyError, resolveInputHistory } from "./series-ids.ts";
import { MODELS, modelOf, type RegimeModel } from "./model/models.ts";
import { derivedInputIds, type DerivedSeries } from "./transform/derived.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "./transform/ratios.ts";
import { assertRequiredCoverage } from "./coverage.ts";
import { withDerivedSeries } from "./engine/prepare.ts";
import { BACKFILL_START, EXTRA_IDS, assertIsoDate, assertPanelList, runModel, type InSampleEnd, type RunResult } from "./engine/run-model.ts";

// The run constants and the run shape live with runModel (src/engine/run-model.ts, issue 1765).
export { BACKFILL_START, EXTRA_IDS, type InSampleEnd, type RunPrepared, type RunResult } from "./engine/run-model.ts";

// The ids a run reads: its scoring registry and the price extras, and under a
// model with derived series (v5, issue 1753) their raw inputs in place of the
// derived ids, which no input carries.
const readIds = (indicators: readonly Indicator[], derived: readonly DerivedSeries[] = []): ReadonlySet<string> => {
  const computed = new Set(derived.map((d) => d.id));
  return new Set([...indicators.map((i) => i.id).filter((id) => !computed.has(id)), ...Object.values(EXTRA_IDS), ...derived.flatMap(derivedInputIds)]);
};
const READ_IDS = readIds(INDICATORS);

// The as-of day is not complete (issue 1655): some indicator has neither a
// real observation on it nor a value its fill policy allows. No figure is
// produced. `missing` names each such indicator and the date of its last real
// observation on or before the day. What a pipeline does with an incomplete
// day is its caller's concern: the SDK knows nothing of persistence or reports.
export interface IncompleteDay {
  kind: "incomplete";
  asof: string;
  missing: MissingIndicator[];
}

export type RunOutcome = RunResult | IncompleteDay;

// Thrown by requireComplete. Its message names each missing indicator and its
// last observation date.
export class IncompleteDayError extends Error {
  constructor(readonly incomplete: IncompleteDay) {
    super(`as-of ${incomplete.asof} is not complete: missing ${incomplete.missing.map((m) => `${m.id} (last ${m.lastObserved})`).join(", ")}`);
    this.name = "IncompleteDayError";
  }
}

/** The run's figure, or IncompleteDayError when the day was incomplete. For callers that fail as a whole. */
export function requireComplete(outcome: RunOutcome): RunResult {
  if (outcome.kind === "incomplete") throw new IncompleteDayError(outcome);
  return outcome;
}

export interface RunOptions {
  // What to do with a day that is not complete (issue 1655). Default DAY_RULE
  // ("score-newest": the day given or the newest input row, as before).
  // "require-complete": without an as-of day score the latest complete day; an
  // explicit incomplete day returns IncompleteDay and no figure.
  dayRule?: DayRule;
  start?: string;
  // Last day of the date axis (YYYY-MM-DD). Input rows dated after it are
  // ignored. Default: the newest date of any input series the run reads.
  asof?: string;
  // Also return the run over every panel (ALL_PANELS) as RunResult.factor.
  // The composite and labels stay the ones over `panels`. A second computation
  // runs only when `panels` is not ALL_PANELS in order (issue 1765, D-e).
  factor?: boolean;
  // The panels the composite averages, 1/n each (issue 1708). Default PANELS,
  // the included entries of PANEL_MEMBERSHIP. A caller replaying an older
  // composite (e.g. the two-panel originals) passes its panel set explicitly.
  panels?: readonly Panel[];
  // The model to run (issue 1765): a published tag, or a RegimeModel (a
  // research model) checked by modelOf. Its registry, derived series, rules,
  // history, storage and backtest rules decide the run. Given with `rules` or
  // `indicators`, it is a RangeError: the model states both. Given with
  // `version`, a tag must be that version; a model object's run is stamped
  // with it.
  model?: RegimeVersion | RegimeModel;
  // The methodology version to compute (issue 1652). Default
  // CURRENT_REGIME_VERSION. A published run replays under the version it was
  // stamped with: "v3" cuts the labels on the rolling percentile, "v4" on the
  // composite and panel indices.
  version?: RegimeVersion;
  // Every engine rule as one full RegimeRules object (issue 1765, D-g).
  // Default REGIME_RULES of `version`. It is checked whole (regimeRulesOf) and
  // never merged onto a preset: the v3 and v4 presets leave out
  // compositeNormalisation and keptHistory, so a partial object would inherit
  // another version's. rules.keptHistory picks the engine: true runs the kept
  // record (analyze/kept-regime.ts), absent or false recomputes every day.
  rules?: RegimeRules;
  // The scoring registry (issue 1653). Default INDICATORS. A list holding a
  // collected series (extract/collected-series.ts) with its scoring fields
  // scores it, with no edit to the registry.
  indicators?: readonly Indicator[];
  // The in-sample end of the backtest (issue 1751). "current-version" (the
  // default, decision D94 item 3): the adoption date of the current
  // methodology version. "computed-version": the adoption date of the rules
  // in force (rules.adoptionDate; the preset of `version` by default).
  inSampleEnd?: InSampleEnd;
  // A ratio declared ratioInput "legs" whose input carries only the stored
  // ratio (issue 1751). "drop" (the default): it gets no weight and is listed
  // in droppedRatios. "error": the run throws StoredRatioOnlyError naming it.
  storedOnlyRatio?: StoredOnlyRatio;
}

export type StoredOnlyRatio = "drop" | "error";

const KNOWN_OPTIONS: readonly string[] = ["start", "asof", "factor", "model", "version", "rules", "dayRule", "indicators", "panels", "inSampleEnd", "storedOnlyRatio"];

// The model a run's options name, and the tag its run is stamped with. Without
// `model` it is the preset of `version`, or, with other rules or another
// registry, that preset with them (its history read from rules.keptHistory).
function modelOfOptions(opts: RunOptions): { model: RegimeModel; version: RegimeVersion } {
  if (opts.version !== undefined && !isRegimeVersion(opts.version)) {
    throw new RangeError(`version must be one of ${REGIME_VERSIONS.join(", ")}, got ${JSON.stringify(opts.version)}`);
  }
  if (opts.model !== undefined) {
    if (opts.rules !== undefined || opts.indicators !== undefined) throw new RangeError("model states its rules and its registry: pass model, or rules and indicators, not both");
    const model = modelOf(opts.model);
    if (typeof opts.model === "string" && opts.version !== undefined && opts.version !== opts.model) {
      throw new RangeError(`model ${opts.model} and version ${opts.version} name two methodologies`);
    }
    return { model, version: opts.version ?? (isRegimeVersion(model.id) ? model.id : CURRENT_REGIME_VERSION) };
  }
  const version = opts.version ?? CURRENT_REGIME_VERSION;
  const preset = MODELS[version];
  // The rules in force (issue 1765, D-g): opts.rules checked whole, else the preset of `version`.
  const rules = regimeRulesOf(version, opts.rules);
  // The registry of the version computed (issue 1753): INDICATORS for v3 and v4.
  const registry = opts.indicators ?? preset.registry;
  if (rules === preset.rules && registry === preset.registry) return { model: preset, version };
  const history = rules.keptHistory === true ? "kept" : "recompute";
  return { model: modelOf({ ...preset, id: `${version}+options`, rules, registry, history }), version };
}

export function runRegime(input: RawIndicatorHistory, opts: RunOptions = {}): RunOutcome {
  // An option this version does not know is an error, never silently ignored
  // (a misspelled option would otherwise silently fall back to its default).
  for (const k of Object.keys(opts)) {
    if (!KNOWN_OPTIONS.includes(k)) {
      throw new RangeError(`unknown option ${JSON.stringify(k)}; expected ${KNOWN_OPTIONS.join(", ")}`);
    }
  }
  if (opts.factor !== undefined && typeof opts.factor !== "boolean") {
    throw new RangeError(`factor must be a boolean, got ${JSON.stringify(opts.factor)}`);
  }
  const panels = opts.panels ?? PANELS;
  assertPanelList("panels", panels);
  const dayRule = opts.dayRule ?? DAY_RULE;
  if (!DAY_RULES.includes(dayRule)) throw new RangeError(`dayRule must be one of ${DAY_RULES.join(", ")}, got ${JSON.stringify(opts.dayRule)}`);
  if (opts.indicators !== undefined && !Array.isArray(opts.indicators)) {
    throw new RangeError(`indicators must be an array of registry entries, got ${JSON.stringify(opts.indicators)}`);
  }
  const { model, version } = modelOfOptions(opts);
  const { rules, registry: indicators } = model;
  const read = indicators === INDICATORS ? READ_IDS : readIds(indicators, model.derived);
  // Input names (input id, storage key or source id, D74) -> the ids read
  // below, and each ratio the input does not store from its legs (4.3).
  const inSampleEnd = opts.inSampleEnd ?? "current-version";
  if (inSampleEnd !== "current-version" && inSampleEnd !== "computed-version") {
    throw new RangeError(`inSampleEnd must be "current-version" or "computed-version", got ${JSON.stringify(opts.inSampleEnd)}`);
  }
  const storedOnlyRatio = opts.storedOnlyRatio ?? "drop";
  if (storedOnlyRatio !== "drop" && storedOnlyRatio !== "error") {
    throw new RangeError(`storedOnlyRatio must be "drop" or "error", got ${JSON.stringify(opts.storedOnlyRatio)}`);
  }
  const droppedRatios: string[] = [];
  const rawIn = ratiosFromLegs(input, resolveInputHistory(input, model.seriesMapping, model.storedUnder), ratioDeclarationsFor(rules), (id) => {
    if (storedOnlyRatio === "error") throw new StoredRatioOnlyError(id);
    droppedRatios.push(id);
  });
  const start = opts.start ?? BACKFILL_START;
  let asof = opts.asof;
  assertIsoDate("start", start);
  if (asof !== undefined) assertIsoDate("asof", asof);
  if (asof !== undefined) {
    if (asof < start) throw new RangeError(`asof ${asof} is before start ${start}`);
    let anyOnOrBefore = false;
    for (const id in rawIn) {
      if (!read.has(id)) continue;
      for (const r of rawIn[id]!) {
        if (r.date <= asof) anyOnOrBefore = true;
      }
    }
    if (!anyOnOrBefore) throw new RangeError(`asof ${asof} is before every input row`);
  }
  // Never mutate the caller's input: with asof, build a filtered copy.
  let raw: RawIndicatorHistory = {};
  for (const id in rawIn) raw[id] = asof === undefined ? rawIn[id]! : cutAtAsof(rawIn[id]!, asof);
  // Only series the run reads set the date axis (analytics requirements 4.2),
  // so an input that also carries other source data (the model portfolio
  // inputs, issue 1398) gives the same regime numbers.
  let maxDate = start;
  for (const id in raw) {
    if (!read.has(id)) continue;
    const rows = raw[id]!;
    if (rows.length && rows[rows.length - 1]!.date > maxDate) maxDate = rows[rows.length - 1]!.date;
  }
  // An input with nothing the run reads, or a start after every row it reads,
  // is an error rather than an all-null report (issue 1404, SDK-8).
  let newestRead: string | null = null;
  for (const id in raw) {
    if (!read.has(id)) continue;
    const rows = raw[id]!;
    if (rows.length && (newestRead === null || rows[rows.length - 1]!.date > newestRead)) newestRead = rows[rows.length - 1]!.date;
  }
  if (newestRead === null) throw new RangeError("the input has no series the run reads (registry indicator ids, or SPX, ETH, TBILL3M)");
  if (newestRead < start) throw new RangeError(`start ${start} is after every input row the run reads (newest ${newestRead})`);
  // Required data is supplied or the run stops with a named error; a
  // downstream run never fetches (issue 1421, src/coverage.ts).
  assertRequiredCoverage(raw, asof ?? maxDate, panels, indicators);
  // The model's history picks the engine, not the version (issue 1765, D-g).
  const kept = model.history === "kept";
  // The day rule reads the registry's series, so the derived ones are computed first, as known on the newest day.
  const forDayRule = kept && dayRule !== "score-newest" ? withDerivedSeries(raw, asof ?? maxDate, model.derived) : raw;
  // Issue 1655, the day rule. score-newest (declared): the day given, or the
  // newest row the run reads, as before. require-complete: without an as-of day
  // the latest complete day on or before that newest row; an explicit
  // incomplete day is a typed IncompleteDay, never a figure.
  if (dayRule === "score-newest") {
    asof ??= maxDate;
  } else if (asof === undefined) {
    const day = latestCompleteDay(forDayRule, { notAfter: maxDate, notBefore: start, indicators, version, rules });
    if (day === null) return { kind: "incomplete", asof: maxDate, missing: missingOnDay(forDayRule, maxDate, indicators, version, rules) };
    asof = day;
    if (asof < maxDate) {
      const cut: RawIndicatorHistory = {};
      for (const id in raw) cut[id] = cutAtAsof(raw[id]!, asof);
      raw = cut;
    }
  } else {
    const missing = missingOnDay(forDayRule, asof, indicators, version, rules);
    if (missing.length > 0) return { kind: "incomplete", asof, missing };
  }
  // The engine (issue 1765): one runModel call. The composite averages `panels`;
  // with `factor` every panel is computed too, in the same fit. A kept model
  // holds no kept days in an SDK run, so it is a first run: every day from
  // `start` is computed one by one from this input, each fit on its own day.
  // The fill policy already masked `transformed`; scoring with the ages keeps
  // the global-cap mask too, which leaves a policy-masked series unchanged.
  const factor = opts.factor === true;
  return runModel(model, raw, { asof, start, version, included: [...panels], panels: factor ? ALL_PANELS : [...panels], factor, inSampleEnd, droppedRatios });
}

function factorBlock(f: RegimeComputeResult, last: number, full: boolean) {
  const idx = f.panelIndices.factor ?? [];
  const pct = f.panelPercentiles.factor ?? [];
  const reg = f.panelRegimes.factor ?? [];
  const num = (xs: ArrayLike<number>, i: number) => (i >= 0 && i < xs.length ? xs[i]! : null);
  return {
    index: num(idx, last),
    percentile: num(pct, last),
    regime: reg[last] ?? null,
    weights: f.weightsByPanel.factor ?? null,
    ...(full
      ? { series: f.dateAxis.map((date, i) => ({ date, index: idx[i]!, percentile: pct[i]!, regime: reg[i] ?? null })) }
      : {}),
  };
}

// JSON-ready report. NaN serialises to null. `full` adds the per-day series.
export function buildReport(run: RunResult, opts: { full?: boolean } = {}) {
  const { dateAxis, result } = run;
  const last = dateAxis.length - 1;
  const at = (xs: ArrayLike<number> | undefined) => (xs && last >= 0 ? xs[last]! : null);
  const panels: Record<string, { index: number | null; percentile: number | null; regime: string | null }> = {};
  for (const p of result.panels) {
    panels[p] = {
      index: at(result.panelIndices[p]),
      percentile: at(result.panelPercentiles[p]),
      regime: result.panelRegimes[p]?.[last] ?? null,
    };
  }
  const indicators = (run.registry ?? INDICATORS).map((ind) => ({
    id: ind.id,
    panel: ind.panel,
    sign: ind.sign,
    rank: at(result.ranks[ind.id]),
    signed: at(result.signed[ind.id]),
    weight: result.weightsByPanel[ind.panel]?.[ind.id] ?? null,
  }));
  return {
    version: run.version,
    asof: dateAxis[last] ?? null,
    days: dateAxis.length,
    regime: {
      label: result.regime[last] ?? null,
      composite: at(result.composite),
      compositePercentile: at(result.compositePercentile),
      panels,
    },
    indicators,
    correlations: run.correlations ?? null,
    backtest: run.backtest ?? null,
    ...(run.factor ? { factor: factorBlock(run.factor, last, opts.full === true) } : {}),
    ...(opts.full
      ? {
          series: dateAxis.map((date, i) => ({
            date,
            composite: result.composite[i]!,
            compositePercentile: result.compositePercentile[i]!,
            regime: result.regime[i] ?? null,
          })),
        }
      : {}),
  };
}

// Replay raw indicator history through the regime pipeline. This is the same
// path backend/tests/regime-fidelity.test.ts replays: prepareRegimeInputs (the
// seam production shares: align each registry indicator, forward-fill or
// zero-fill, apply its transform and its fill policy), then computeRegime.
// Run semantics (as-of, fill policy, complete days, replay):
// docs/technical/regime-engine.md section 8.1; the seam is D59 in docs/decisions.md.
// Optional SPX, ETH and TBILL3M price series in
// the same input add the correlation and backtest output.
import type { Point, RawIndicatorHistory } from "./types.ts";
import { ALL_PANELS, DAY_RULE, DAY_RULES, INDICATORS, PANELS, type DayRule, type Indicator, type Panel } from "./analyze/indicators.ts";
import { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
import { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestPayload } from "./analyze/backtest.ts";
import { CURRENT_REGIME_VERSION, REGIME_VERSIONS, isRegimeVersion, type RegimeVersion } from "./analyze/regime-versions.ts";
import { cutAtAsof, latestCompleteDay, missingOnDay, prepareRegimeInputs, type MissingIndicator } from "./prepare.ts";
import { LEDGER_EXTRA_KEYS } from "./extras.ts";
import { resolveInputHistory } from "./series-ids.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "./transform/ratios.ts";
import { assertRequiredCoverage } from "./coverage.ts";

export const BACKFILL_START = "2018-01-01";
// Indicator ids in the input that carry price levels for correlations/backtest.
export const EXTRA_IDS = {
  spx: LEDGER_EXTRA_KEYS.spx.inputId,
  eth: LEDGER_EXTRA_KEYS.eth.inputId,
  tbill3m: LEDGER_EXTRA_KEYS.tbill3m.inputId,
} as const;
// The ids a run reads: its scoring registry and the price extras.
const readIds = (indicators: readonly Indicator[]): ReadonlySet<string> => new Set([...indicators.map((i) => i.id), ...Object.values(EXTRA_IDS)]);
const READ_IDS = readIds(INDICATORS);

export interface RunResult {
  kind: "complete";
  // The methodology version the run computed (RunOptions.version).
  version: RegimeVersion;
  dateAxis: string[];
  result: RegimeComputeResult;
  // Production's second computeRegime call (ALL_PANELS), present only when
  // runRegime ran with factor: true. Display-only: result keeps the composite
  // and labels over the run's panels.
  factor?: RegimeComputeResult;
  correlations?: CorrelationsPayload;
  backtest?: BacktestPayload;
}

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
  // Also run a second computeRegime call over every panel (ALL_PANELS) and
  // return its factor_* figures. The composite and labels stay the ones over
  // `panels`.
  factor?: boolean;
  // The panels the composite averages, 1/n each (issue 1708). Default PANELS,
  // the included entries of PANEL_MEMBERSHIP. A caller replaying an older
  // composite (e.g. the two-panel originals) passes its panel set explicitly.
  panels?: readonly Panel[];
  // The methodology version to compute (issue 1652). Default
  // CURRENT_REGIME_VERSION. A published run replays under the version it was
  // stamped with: "v3" cuts the labels on the rolling percentile, "v4" on the
  // composite and panel indices.
  version?: RegimeVersion;
  // The scoring registry (issue 1653). Default INDICATORS. A list holding a
  // collected series (extract/collected-series.ts) with its scoring fields
  // scores it, with no edit to the registry.
  indicators?: readonly Indicator[];
}

// A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-45, "").
function assertIsoDate(name: string, v: string): void {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!ok) throw new RangeError(`${name} must be a real date in YYYY-MM-DD form, got ${JSON.stringify(v)}`);
}

const KNOWN_OPTIONS: readonly string[] = ["start", "asof", "factor", "version", "dayRule", "indicators", "panels"];

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
  if (!Array.isArray(panels) || panels.length === 0 || new Set(panels).size !== panels.length || panels.some((p) => !ALL_PANELS.includes(p))) {
    throw new RangeError(`panels must be a non-empty list of distinct panels from ${ALL_PANELS.join(", ")}, got ${JSON.stringify(opts.panels)}`);
  }
  const dayRule = opts.dayRule ?? DAY_RULE;
  if (!DAY_RULES.includes(dayRule)) throw new RangeError(`dayRule must be one of ${DAY_RULES.join(", ")}, got ${JSON.stringify(opts.dayRule)}`);
  if (opts.indicators !== undefined && !Array.isArray(opts.indicators)) {
    throw new RangeError(`indicators must be an array of registry entries, got ${JSON.stringify(opts.indicators)}`);
  }
  const indicators = opts.indicators ?? INDICATORS;
  const read = opts.indicators === undefined ? READ_IDS : readIds(indicators);
  const version = opts.version ?? CURRENT_REGIME_VERSION;
  if (!isRegimeVersion(version)) {
    throw new RangeError(`version must be one of ${REGIME_VERSIONS.join(", ")}, got ${JSON.stringify(opts.version)}`);
  }
  // Input names (input id, storage key or source id, D74) -> the ids read
  // below, and each ratio the input does not store from its legs (4.3).
  const rawIn = ratiosFromLegs(input, resolveInputHistory(input), ratioDeclarationsFor(version));
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
  assertRequiredCoverage(raw, asof ?? maxDate, panels);
  // Issue 1655, the day rule. score-newest (declared): the day given, or the
  // newest row the run reads, as before. require-complete: without an as-of day
  // the latest complete day on or before that newest row; an explicit
  // incomplete day is a typed IncompleteDay, never a figure.
  if (dayRule === "score-newest") {
    asof ??= maxDate;
  } else if (asof === undefined) {
    const day = latestCompleteDay(raw, { notAfter: maxDate, notBefore: start, indicators, version });
    if (day === null) return { kind: "incomplete", asof: maxDate, missing: missingOnDay(raw, maxDate, indicators, version) };
    asof = day;
    if (asof < maxDate) {
      const cut: RawIndicatorHistory = {};
      for (const id in raw) cut[id] = cutAtAsof(raw[id]!, asof);
      raw = cut;
    }
  } else {
    const missing = missingOnDay(raw, asof, indicators, version);
    if (missing.length > 0) return { kind: "incomplete", asof, missing };
  }
  // The fill policy already masked `transformed`; passing `ages` keeps the
  // global-cap mask too, which leaves a policy-masked series unchanged.
  const { dateAxis, transformed, ages } = prepareRegimeInputs(raw, { start, asof, indicators, version });
  const result = computeRegime(transformed, dateAxis, [...panels], ages, undefined, version, undefined, indicators);
  const out: RunResult = { kind: "complete", version, dateAxis, result };
  if (opts.factor) out.factor = computeRegime(transformed, dateAxis, ALL_PANELS, ages, undefined, version, undefined, indicators);
  const spx: Point[] | undefined = raw[EXTRA_IDS.spx];
  const eth: Point[] | undefined = raw[EXTRA_IDS.eth];
  const tbill3m: Point[] | undefined = raw[EXTRA_IDS.tbill3m];
  if (spx?.length && eth?.length) {
    out.correlations = computeCorrelations(dateAxis, result, { spx, eth });
    if (tbill3m?.length) out.backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, result, { spx, eth, tbill3m }));
  }
  return out;
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
  const indicators = INDICATORS.map((ind) => ({
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

// Replay raw indicator history through the regime pipeline. This is the same
// path backend/tests/regime-fidelity.test.ts replays: prepareRegimeInputs (the
// seam production shares: align each registry indicator, forward-fill or
// zero-fill, apply its transform, forward-fill ages), then computeRegime.
// Run semantics (as-of, forward-fill, replay): docs/technical/regime-engine.md
// section 8.1; the seam is D59 in docs/decisions.md.
// Optional SPX, ETH and TBILL3M price series in
// the same input add the correlation and backtest output.
import type { Point, RawIndicatorHistory } from "./types.ts";
import { INDICATORS, PANELS } from "./analyze/indicators.ts";
import { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
import { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestPayload } from "./analyze/backtest.ts";
import { CURRENT_REGIME_VERSION } from "./analyze/regime-versions.ts";
import { prepareRegimeInputs } from "./prepare.ts";
import { LEDGER_EXTRA_KEYS } from "./extras.ts";

export const BACKFILL_START = "2018-01-01";
// Indicator ids in the input that carry price levels for correlations/backtest.
export const EXTRA_IDS = {
  spx: LEDGER_EXTRA_KEYS.spx.inputId,
  eth: LEDGER_EXTRA_KEYS.eth.inputId,
  tbill3m: LEDGER_EXTRA_KEYS.tbill3m.inputId,
} as const;

export interface RunResult {
  dateAxis: string[];
  result: RegimeComputeResult;
  // Production's second computeRegime call (macro, onchain, factor), present
  // only when runRegime ran with factor: true. Display-only: result keeps the
  // two-panel composite and labels.
  factor?: RegimeComputeResult;
  correlations?: CorrelationsPayload;
  backtest?: BacktestPayload;
}

export interface RunOptions {
  start?: string;
  // Last day of the date axis (YYYY-MM-DD). Input rows dated after it are
  // ignored. Default: the newest date in the input.
  asof?: string;
  // Also run production's second computeRegime call (macro, onchain, factor)
  // and return its factor_* figures. The composite and labels stay the
  // two-panel ones the published table uses.
  factor?: boolean;
}

// A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-45, "").
function assertIsoDate(name: string, v: string): void {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!ok) throw new RangeError(`${name} must be a real date in YYYY-MM-DD form, got ${JSON.stringify(v)}`);
}

const KNOWN_OPTIONS: readonly string[] = ["start", "asof", "factor"];

export function runRegime(rawIn: RawIndicatorHistory, opts: RunOptions = {}): RunResult {
  // An option this version does not know is an error, never silently ignored
  // (a caller passing the former `panels` would otherwise get no factor output).
  for (const k of Object.keys(opts)) {
    if (!KNOWN_OPTIONS.includes(k)) {
      const hint = k === "panels" ? " (use factor: true for the factor_* figures)" : "";
      throw new RangeError(`unknown option ${JSON.stringify(k)}${hint}; expected start, asof, factor`);
    }
  }
  if (opts.factor !== undefined && typeof opts.factor !== "boolean") {
    throw new RangeError(`factor must be a boolean, got ${JSON.stringify(opts.factor)}`);
  }
  const start = opts.start ?? BACKFILL_START;
  const asof = opts.asof;
  assertIsoDate("start", start);
  if (asof !== undefined) assertIsoDate("asof", asof);
  if (asof !== undefined) {
    if (asof < start) throw new RangeError(`asof ${asof} is before start ${start}`);
    let anyOnOrBefore = false;
    for (const id in rawIn) {
      for (const r of rawIn[id]!) {
        if (r.date <= asof) anyOnOrBefore = true;
      }
    }
    if (!anyOnOrBefore) throw new RangeError(`asof ${asof} is before every input row`);
  }
  // Never mutate the caller's input: with asof, build a filtered copy.
  const raw: RawIndicatorHistory = {};
  for (const id in rawIn) raw[id] = asof === undefined ? rawIn[id]! : rawIn[id]!.filter((r) => r.date <= asof);
  let maxDate = start;
  for (const id in raw) {
    const rows = raw[id]!;
    if (rows.length && rows[rows.length - 1]!.date > maxDate) maxDate = rows[rows.length - 1]!.date;
  }
  const { dateAxis, transformed, ages } = prepareRegimeInputs(raw, { start, asof: asof ?? maxDate });
  const result = computeRegime(transformed, dateAxis, PANELS, ages);
  const out: RunResult = { dateAxis, result };
  if (opts.factor) out.factor = computeRegime(transformed, dateAxis, ["macro", "onchain", "factor"], ages);
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
    version: CURRENT_REGIME_VERSION,
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

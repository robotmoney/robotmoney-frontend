// Replay raw indicator history through the regime pipeline. This is the same
// path backend/tests/regime-fidelity.test.ts replays: align each registry
// indicator (forward-fill, or zero-fill when the registry says so), apply its
// transform, then computeRegime. Optional SPX, ETH and TBILL3M price series in
// the same input add the correlation and backtest output.
import type { Point, RawIndicatorHistory } from "./types.ts";
import { INDICATORS, PANELS, type Panel } from "./analyze/indicators.ts";
import { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
import { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestPayload } from "./analyze/backtest.ts";
import { CURRENT_REGIME_VERSION } from "./analyze/regime-versions.ts";
import { alignDailyForwardFill, alignDailyZeroFill, buildDateAxis, forwardFillAge } from "./transform/math.ts";
import { applyTransform } from "./transform/transforms.ts";

export const BACKFILL_START = "2018-01-01";
// Indicator ids in the input that carry price levels for correlations/backtest.
export const EXTRA_IDS = { spx: "SPX", eth: "ETH", tbill3m: "TBILL3M" } as const;

export interface RunResult {
  dateAxis: string[];
  result: RegimeComputeResult;
  correlations?: CorrelationsPayload;
  backtest?: BacktestPayload;
}

export interface RunOptions {
  start?: string;
  // Last day of the date axis (YYYY-MM-DD). Input rows dated after it are
  // ignored. Default: the newest date in the input.
  asof?: string;
  // Panels computeRegime scores. Default PANELS (macro, onchain). Pass
  // ["macro","onchain","factor"] to also get factor_* (display-only in production).
  panels?: Panel[];
}

const ALL_PANELS: readonly string[] = ["macro", "onchain", "factor"];

// A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-45, "").
function assertIsoDate(name: string, v: string): void {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!ok) throw new RangeError(`${name} must be a real date in YYYY-MM-DD form, got ${JSON.stringify(v)}`);
}

export function runRegime(rawIn: RawIndicatorHistory, opts: RunOptions = {}): RunResult {
  const start = opts.start ?? BACKFILL_START;
  const asof = opts.asof;
  assertIsoDate("start", start);
  if (asof !== undefined) assertIsoDate("asof", asof);
  if (opts.panels !== undefined) {
    const ps = opts.panels as readonly string[];
    if (ps.length === 0) throw new RangeError("panels must not be empty");
    const bad = ps.filter((p) => !ALL_PANELS.includes(p));
    if (bad.length) throw new RangeError(`unknown panel(s): ${bad.join(",")} (expected macro,onchain,factor)`);
    if (new Set(ps).size !== ps.length) throw new RangeError(`duplicate panel(s) in ${JSON.stringify(ps)}`);
  }
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
  const dateAxis = buildDateAxis(start, asof ?? maxDate);
  const nanSeries = new Array<number>(dateAxis.length).fill(NaN);
  const transformed: Record<string, number[]> = {};
  // Forward-fill age per non-zero_fill indicator, as backend/src/analytics/index.ts.
  const ages: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const series = raw[ind.id] ?? [];
    if (ind.align !== "zero_fill") ages[ind.id] = forwardFillAge(series, dateAxis);
    if (series.length === 0) {
      transformed[ind.id] = nanSeries.slice();
      continue;
    }
    const aligner = ind.align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(series, dateAxis));
  }
  const result = computeRegime(transformed, dateAxis, opts.panels ?? PANELS, ages);
  const out: RunResult = { dateAxis, result };
  const spx: Point[] | undefined = raw[EXTRA_IDS.spx];
  const eth: Point[] | undefined = raw[EXTRA_IDS.eth];
  const tbill3m: Point[] | undefined = raw[EXTRA_IDS.tbill3m];
  if (spx?.length && eth?.length) {
    out.correlations = computeCorrelations(dateAxis, result, { spx, eth });
    if (tbill3m?.length) out.backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, result, { spx, eth, tbill3m }));
  }
  return out;
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

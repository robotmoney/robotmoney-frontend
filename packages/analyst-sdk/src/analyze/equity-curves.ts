// Equity curves of a multi-portfolio regime backtest (issue 1766; analytics
// requirements section 5.4): one curve shape (EquityCurve), measured since
// inception and over trailing windows that end on the last axis day
// (evaluateEquityCurve), and the label strategies on every PORTFOLIO_SPECS
// market (labelStrategyCurves). Every figure is periodStats's; every
// simulation is simulateDrift's. Pure: no file, no HTTP.
import type { Point } from "../types.ts";
import {
  PORTFOLIO_SPECS,
  periodStats,
  referenceStrategies,
  samplingOf,
  scheduleFromLabels,
  simulateDrift,
  type BacktestLabels,
  type BacktestMetrics,
  type DriftOptions,
  type MarketCalendar,
  type Sampling,
  type Schedule,
  type SharpeBasis,
  type SimulationResult,
  type Weights,
} from "./backtest.ts";

/** What a curve is: a strategy trades on labels; a buy-and-hold benchmark is bought on its first day and held; cash holds only cash. */
export type EquityCurveKind = "strategy" | "buy_and_hold_benchmark" | "cash";

const KINDS: readonly EquityCurveKind[] = ["strategy", "buy_and_hold_benchmark", "cash"];

/** One evaluation window's figures. */
export interface Window {
  first_day: string;
  last_day: string;
  final_value: number;
  /** yearly growth, a year counted as 365.25 days */
  cagr: number;
  /** periodStats's Sharpe ratio; 0 where it reports null */
  sharpe: number;
  /** the deepest fall from a peak, in [-1, 0] */
  max_drawdown: number;
  /** trades inside the window (periodStats's transitions) */
  trades: number;
  /** daily returns inside the window */
  n_days: number;
}

/** A trailing window's key: `trailing_12m` for 12 months. */
export type TrailingKey = `trailing_${number}m`;

/** A curve's windows: since inception, and each trailing window (null where the curve does not cover it in full). */
export type Windows = { since_inception: Window } & { [k: TrailingKey]: Window | null };

/** One equity curve, measured. */
export interface EquityCurve {
  kind: EquityCurveKind;
  /** the simulation's start */
  first_day: string;
  /** its end, the last axis day */
  last_day: string;
  /** since inception */
  final_value: number;
  windows: Windows;
  /** since inception, sampled as asked (default month-end) */
  equity_curve: Point[];
}

/** The key of the trailing window of `months` months. */
export const trailingKey = (months: number): TrailingKey => `trailing_${months}m`;

/** The same calendar day `months` months before `day`, or that month's last day when the day does not exist. */
export function monthsBefore(day: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`monthsBefore: day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  if (!Number.isInteger(months) || months < 0) throw new RangeError(`monthsBefore: months must be a nonnegative integer, got ${JSON.stringify(months)}`);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export interface EvaluateOptions {
  kind: EquityCurveKind;
  /** Trailing windows, in months, each ending on the last day. Default none. */
  trailingMonths?: readonly number[];
  /** How equity_curve is sampled. Default month-end. */
  sampling?: Sampling;
  /** The returns the Sharpe ratio reads, as periodStats. Default "excess". */
  sharpeBasis?: SharpeBasis;
}

const EVALUATE_KEYS = ["kind", "trailingMonths", "sampling", "sharpeBasis"];

function unknownKeys(where: string, options: object, allowed: readonly string[]): void {
  if (options === null || typeof options !== "object") throw new RangeError(`${where}: options must be an object`);
  for (const k of Object.keys(options)) if (!allowed.includes(k)) throw new RangeError(`${where}: unknown option ${JSON.stringify(k)}; expected ${allowed.join(", ")}`);
}

function monthsList(where: string, v: unknown): readonly number[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((m) => !Number.isInteger(m) || m <= 0)) throw new RangeError(`${where}: trailingMonths must be a list of positive integers, got ${JSON.stringify(v)}`);
  return v;
}

const windowOf = (m: BacktestMetrics): Window => ({
  first_day: m.start_date,
  last_day: m.end_date,
  final_value: m.final_value ?? NaN,
  cagr: m.cagr ?? NaN,
  sharpe: m.sharpe ?? 0,
  max_drawdown: m.max_drawdown ?? NaN,
  trades: m.transitions,
  n_days: m.n_days,
});

/**
 * One simulation measured since inception (periodStats over its own start and
 * end) and over each trailing window of N months, from monthsBefore(end, N)
 * to the end; a trailing window that starts before the simulation is null.
 */
export function evaluateEquityCurve(simulation: SimulationResult, options: EvaluateOptions): EquityCurve {
  unknownKeys("evaluateEquityCurve", options, EVALUATE_KEYS);
  if (!KINDS.includes(options.kind)) throw new RangeError(`evaluateEquityCurve: kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(options.kind)}`);
  const months = monthsList("evaluateEquityCurve", options.trailingMonths);
  const sampling = samplingOf(options.sampling);
  const { startDate: first, endDate: last } = simulation;
  const stats = (from: string) =>
    periodStats(simulation.values, from, last, {
      returns: simulation.returns,
      excess: simulation.excess,
      trades: simulation.trades,
      sampling,
      ...(options.sharpeBasis === undefined ? {} : { sharpeBasis: options.sharpeBasis }),
    });
  const all = stats(first);
  const windows: Windows = { since_inception: windowOf(all) };
  for (const n of months) {
    const from = monthsBefore(last, n);
    windows[trailingKey(n)] = from < first ? null : windowOf(stats(from));
  }
  return { kind: options.kind, first_day: first, last_day: last, final_value: windows.since_inception.final_value, windows, equity_curve: all.equity_curve };
}

/** The windows a group of curves is measured over. */
export interface CurveWindows {
  trailingMonths?: readonly number[];
  /** The common period every curve covers (crossCurveViolations reads it). */
  commonPeriodMonths?: number;
}

/** What every curve of a group runs under: simulateDrift's options, the sampling and the windows. */
export interface CurveGroupOptions {
  trading?: DriftOptions;
  sampling?: Sampling;
  windows?: CurveWindows;
}

/** A group of equity curves, by name. */
export type CurveGroup = Record<string, EquityCurve>;

/** Each label series carried forward from its first label: a day with no label keeps the last one. */
export function carryForward<T>(s: readonly (T | null)[]): (T | null)[] {
  let last: T | null = null;
  return s.map((v) => (last = v ?? last));
}

/** The trading options with the calendars cut to the priced assets (simulateDrift refuses a calendar for a series it is not given). */
export function tradingFor(trading: DriftOptions | undefined, assets: readonly string[]): DriftOptions {
  const t = trading ?? {};
  if (t.calendars === undefined) return { ...t };
  const calendars: Record<string, MarketCalendar> = {};
  for (const a of assets) if (Object.hasOwn(t.calendars, a)) calendars[a] = t.calendars[a]!;
  return { ...t, calendars };
}

/** The named prices, or a RangeError naming the first missing one. */
export function pricesOf(where: string, prices: Readonly<Record<string, Point[]>>, assets: readonly string[]): Record<string, Point[]> {
  const out: Record<string, Point[]> = {};
  for (const a of assets) {
    if (!Array.isArray(prices[a])) throw new RangeError(`${where}: no prices for ${JSON.stringify(a)}`);
    out[a] = prices[a]!;
  }
  return out;
}

/**
 * The label strategies of every PORTFOLIO_SPECS market (eth, sp500, mixed):
 * each referenceStrategies line through scheduleFromLabels and the market's
 * weight table, the market's buy-and-hold benchmark and stables_only. Each
 * label series is carried forward from its first label. Every curve is priced
 * on every asset of every market and has no target before the first day every
 * label series has a label, so all of them start on one day. Strategies run
 * under options.trading, benchmarks under the same options with freq "never".
 * The three groups hold one cash curve.
 */
export function labelStrategyCurves(
  dateAxis: readonly string[],
  labels: BacktestLabels,
  prices: Readonly<Record<string, Point[]>>,
  cashQuotes: Point[],
  options: CurveGroupOptions = {},
): Record<string, CurveGroup> {
  unknownKeys("labelStrategyCurves", options, ["trading", "sampling", "windows"]);
  const carried: BacktestLabels = {
    regime: carryForward(labels.regime),
    panelRegimes: Object.fromEntries(Object.entries(labels.panelRegimes).map(([p, s]) => [p, carryForward(s)])),
    ...(labels.panels === undefined ? {} : { panels: labels.panels }),
  };
  const lines = referenceStrategies(carried);
  const first = dateAxis.findIndex((_, i) => Object.values(lines).every((s) => s[i] != null));
  if (first < 0) throw new RangeError("labelStrategyCurves: no day on which every label series has a label");
  const assets = [...new Set(Object.values(PORTFOLIO_SPECS).flatMap((s) => s.risky))];
  const px = pricesOf("labelStrategyCurves", prices, assets);
  const trading = tradingFor(options.trading, assets);
  const benchmark: DriftOptions = { ...trading, freq: "never" };
  const evaluate = { trailingMonths: options.windows?.trailingMonths ?? [], ...(options.sampling === undefined ? {} : { sampling: options.sampling }) };
  const fromFirst = (s: Schedule): Schedule => s.map((w, i) => (i < first ? null : w));
  const constant = (w: Weights): Schedule => fromFirst(dateAxis.map(() => w));
  const curve = (s: Schedule, kind: EquityCurveKind, o: DriftOptions) => evaluateEquityCurve(simulateDrift(dateAxis, s, px, cashQuotes, o), { kind, ...evaluate });
  const cash = curve(constant({ cash: 1 }), "cash", benchmark);
  const out: Record<string, CurveGroup> = {};
  for (const [market, spec] of Object.entries(PORTFOLIO_SPECS)) {
    const group: CurveGroup = {};
    for (const [name, s] of Object.entries(lines)) group[name] = curve(fromFirst(scheduleFromLabels(s, spec.weights)), "strategy", trading);
    group[spec.hodl.key] = curve(constant(spec.hodl.weights), "buy_and_hold_benchmark", benchmark);
    group.stables_only = cash;
    out[market] = group;
  }
  return out;
}

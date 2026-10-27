// Regime backtest — ported VERBATIM from agentjuno/robotmoney scripts/regime/
// update.js (computeBacktest ~L695-770, simulate ~L827-925, combineConservativeN/
// combineAggressiveN/firstIndexWithAllAssets/forwardFillDaily/sameWeights/
// turnoverBetween, PORTFOLIO_SPECS + constants, stripDailyFromSnapshot). Pure and
// deterministic. Byte-fidelity to the original JS is proven in
// backend/tests/backtest-correlations-fidelity.test.ts.
//
// Three portfolios share the same 3-state regime-bucket rule but allocate to
// different risky baskets (eth / sp500 / mixed), all earning the DTB3 3-month
// T-bill yield on the cash leg. Rebalance only on bucket transitions; transaction
// cost = one-sided turnover × 10 bps. Strategies tested per portfolio: composite,
// each panel regime, macro_inverted, conservative, aggressive. Baselines: HODL +
// 100% stables. Month-end downsampled equity_curve; the per-day `_daily` series is
// stripped from the snapshot payload (stripDailyFromSnapshot).
//
// Issue 1404 exposes the same calculation for supplied portfolios:
// simulatePortfolio (any assets, schedule, cash rate, costBps), periodStats (the
// established statistics over a supplied range, from the simulation's pre-cost
// returns and boundary evidence) and scheduleFromLabels (the label-to-weight
// mapping). computeBacktest is those three over the reference portfolios; its
// output is byte-identical to the pre-refactor code (tests/backtest.test.ts
// against tests/reference/backtest-pre-refactor.ts). Spec: analytics
// requirements section 5 (docs/technical/analytics-requirements.md).
import type { RegimeComputeResult } from "./compute.ts";
import type { Point } from "../types.ts";
import { toDateMap } from "./correlations.ts";
import { PANELS } from "./indicators.ts";

export const BACKTEST_COST_PER_REBALANCE = 0.001;
export const BACKTEST_IN_SAMPLE_END = "2024-01-31";

interface PortfolioSpec {
  risky: string[];
  weights: Record<string, Weights>;
  hodl: { key: string; weights: Weights };
}

export const PORTFOLIO_SPECS: Record<string, PortfolioSpec> = {
  eth: {
    risky: ["eth"],
    weights: {
      risk_off: { cash: 1, eth: 0 },
      neutral: { cash: 0.5, eth: 0.5 },
      risk_on: { cash: 0, eth: 1 },
    },
    hodl: { key: "eth_hodl", weights: { cash: 0, eth: 1 } },
  },
  sp500: {
    risky: ["sp500"],
    weights: {
      risk_off: { cash: 1, sp500: 0 },
      neutral: { cash: 0.5, sp500: 0.5 },
      risk_on: { cash: 0, sp500: 1 },
    },
    hodl: { key: "sp500_hodl", weights: { cash: 0, sp500: 1 } },
  },
  mixed: {
    risky: ["eth", "sp500"],
    weights: {
      risk_off: { cash: 1, eth: 0, sp500: 0 },
      neutral: { cash: 0.5, eth: 0.25, sp500: 0.25 },
      risk_on: { cash: 0, eth: 0.5, sp500: 0.5 },
    },
    hodl: { key: "blend_hodl", weights: { cash: 0, eth: 0.5, sp500: 0.5 } },
  },
};

export interface BacktestMetrics {
  final_value: number | null;
  cagr: number | null;
  cagr_in_sample: number | null;
  cagr_out_sample: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  transitions: number;
  n_days: number;
  start_date: string;
  end_date: string;
  equity_curve: Point[];
  _daily?: Point[];
}

// portfolio → strategy → metrics.
export type BacktestPayload = Record<string, Record<string, BacktestMetrics>>;

// Daily SPX (^GSPC), ETH (ETH-USD) price levels + DTB3 (tbill3m) annualized yields
// (%). NOT registry indicators — sourced via fetchBacktestExtras.
export interface BacktestExtras {
  spx: Point[];
  eth: Point[];
  tbill3m: Point[];
}

const nullIfNaN = (v: number): number | null => (Number.isFinite(v) ? v : null);

// Target weights per asset id. "cash" is the cash leg; every other key is an
// asset id with supplied prices.
export type Weights = Record<string, number>;

// Applicable target weights per date of the axis; null where none apply (a
// missing regime label). Same length as the date axis.
export type Schedule = (Weights | null)[];

export interface SimulateOptions {
  // Cost per unit of one-sided turnover, in basis points. Default 10, the
  // established BACKTEST_COST_PER_REBALANCE.
  costBps?: number;
}

export interface TradeEvidence {
  date: string;
  turnover: number;
  cost: number;
}

// Everything one simulation produced. `values` are the net daily values (they
// include trading costs); `returns` are the pre-cost daily return observations
// the Sharpe uses; `trades` is the cost evidence; `startDate`/`endDate` are the
// boundary evidence periodStats needs. None of it is a report field.
export interface SimulationResult {
  values: Point[];
  returns: Point[];
  trades: TradeEvidence[];
  startDate: string;
  endDate: string;
}

export interface PeriodStatsOptions {
  // The simulation's pre-cost daily return observations (SimulationResult.returns).
  returns: Point[];
  // Trade evidence; its count inside the window is `transitions`.
  trades?: TradeEvidence[];
  // In-sample end. Default BACKTEST_IN_SAMPLE_END.
  splitDate?: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkWeights(w: Weights, where: string, assets: ReadonlySet<string>): void {
  let sum = 0;
  for (const [k, v] of Object.entries(w)) {
    if (k !== "cash" && !assets.has(k)) throw new RangeError(`${where}: weight for ${JSON.stringify(k)} has no supplied prices`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RangeError(`${where}: weight for ${JSON.stringify(k)} must be a finite nonnegative number, got ${JSON.stringify(v)}`);
    sum += v;
  }
  if (Math.abs(sum - 1) > 1e-9) throw new RangeError(`${where}: weights must sum to 1, got ${sum}`);
}

// The established label-to-weight mapping: a label with no row in the table
// (including a missing label) has no applicable weights.
export function scheduleFromLabels(labels: readonly (string | null)[], table: Record<string, Weights>): Schedule {
  return labels.map((l) => (l != null && Object.hasOwn(table, l) ? table[l]! : null));
}

// The shared simulation (analytics requirements 5.2/5.3) over supplied assets.
// Each date's return uses the previous target weights and that date's price
// change; target weights at a date's close cost one-sided turnover times the cost
// rate; cash earns the previous date's annual percent yield over 365 days. The
// simulation starts at the first date on which every supplied asset is priced,
// then at the first date with applicable weights. Pure: no file, no HTTP.
export function simulatePortfolio(
  dateAxis: readonly string[],
  schedule: Schedule,
  prices: Record<string, Point[]>,
  cashRate: Point[],
  options: SimulateOptions = {},
): SimulationResult {
  for (const k of Object.keys(options)) {
    if (k !== "costBps") throw new RangeError(`unknown option ${JSON.stringify(k)}; expected costBps`);
  }
  const { costBps } = options;
  if (costBps !== undefined && (typeof costBps !== "number" || !Number.isFinite(costBps) || costBps < 0)) {
    throw new RangeError(`costBps must be a finite nonnegative number, got ${JSON.stringify(costBps)}`);
  }
  const costRate = costBps === undefined ? BACKTEST_COST_PER_REBALANCE : costBps / 10_000;
  if (dateAxis.length === 0) throw new RangeError("dateAxis is empty");
  for (let i = 0; i < dateAxis.length; i++) {
    if (!ISO_DAY.test(dateAxis[i]!) || (i > 0 && dateAxis[i]! <= dateAxis[i - 1]!)) throw new RangeError(`dateAxis must be ascending YYYY-MM-DD dates (index ${i})`);
  }
  if (schedule.length !== dateAxis.length) throw new RangeError(`schedule has ${schedule.length} entries for ${dateAxis.length} dates`);
  const assets = new Set(Object.keys(prices));
  for (let i = 0; i < schedule.length; i++) {
    const w = schedule[i];
    if (w != null) checkWeights(w, `schedule ${dateAxis[i]}`, assets);
  }

  const tbillMap = toDateMap(cashRate);
  let lastTbill = 0;
  const tbillDaily = new Array<number>(dateAxis.length).fill(0);
  for (let i = 0; i < dateAxis.length; i++) {
    const v = tbillMap.get(dateAxis[i]);
    if (v !== undefined) lastTbill = v;
    tbillDaily[i] = Number.isFinite(lastTbill) ? lastTbill : 0;
  }
  const assetSeries: Record<string, number[]> = {};
  for (const [k, pts] of Object.entries(prices)) assetSeries[k] = forwardFillDaily(pts, dateAxis as string[]);
  const firstIdx = firstIndexWithAllAssets(Object.keys(assetSeries), assetSeries, dateAxis.length);
  if (firstIdx < 0) {
    throw new RangeError(`missing price coverage: no date in ${dateAxis[0]}..${dateAxis[dateAxis.length - 1]} has prices for every asset (${Object.keys(prices).join(", ")})`);
  }
  return simulate(dateAxis, schedule, assetSeries, tbillDaily, firstIdx, costRate);
}

function simulate(
  dateAxis: readonly string[],
  schedule: Schedule,
  assetSeries: Record<string, number[]>,
  tbillDaily: number[],
  firstIdx: number,
  costRate: number,
): SimulationResult {
  let equity = 1;
  let lastWeights: Weights | null = null;
  const values: Point[] = [];
  const returns: Point[] = [];
  const trades: TradeEvidence[] = [];
  let firstActiveIdx = -1;

  for (let i = firstIdx; i < dateAxis.length; i++) {
    const w = schedule[i];
    if (!w) continue;
    if (firstActiveIdx < 0) firstActiveIdx = i;

    // Day i's portfolio return = lastWeights · (day i's asset returns).
    if (lastWeights != null) {
      const dailyTbill = Math.pow(1 + (tbillDaily[i - 1] || 0) / 100, 1 / 365) - 1;
      let portRet = (lastWeights.cash || 0) * dailyTbill;
      for (const [asset, ws] of Object.entries(lastWeights)) {
        if (asset === "cash" || ws === 0) continue;
        const p0 = assetSeries[asset]?.[i - 1];
        const p1 = assetSeries[asset]?.[i];
        if (Number.isFinite(p0) && Number.isFinite(p1) && p0! > 0) {
          portRet += ws * (p1! / p0! - 1);
        }
      }
      equity *= 1 + portRet;
      returns.push({ date: dateAxis[i]!, value: portRet });
    }

    // Rebalance at close of today if weights changed (turnover-based cost).
    if (lastWeights != null && !sameWeights(lastWeights, w)) {
      const turnover = turnoverBetween(lastWeights, w);
      equity *= 1 - turnover * costRate;
      trades.push({ date: dateAxis[i]!, turnover, cost: turnover * costRate });
    }
    lastWeights = w;
    values.push({ date: dateAxis[i]!, value: equity });
  }

  return {
    values,
    returns,
    trades,
    startDate: dateAxis[firstActiveIdx >= 0 ? firstActiveIdx : firstIdx]!,
    endDate: dateAxis[dateAxis.length - 1]!,
  };
}

const YEAR_MS = 365.25 * 86400 * 1000;

// The established statistics over [from, to] (analytics requirements 5.4). A
// value dated in the window counts; a return or trade counts when dated after
// `from` (the move into the first value is outside the window). Called with the
// simulation's own startDate/endDate it reproduces the reference report fields
// exactly. `_daily` carries the window's values; stripDailyFromSnapshot drops it.
export function periodStats(valueSeries: Point[], from: string, to: string, options: PeriodStatsOptions): BacktestMetrics {
  for (const k of Object.keys(options)) {
    if (!["returns", "trades", "splitDate"].includes(k)) throw new RangeError(`unknown option ${JSON.stringify(k)}; expected returns, trades, splitDate`);
  }
  if (!Array.isArray(options.returns)) throw new RangeError("options.returns (the simulation's pre-cost daily returns) is required");
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) throw new RangeError(`period ${from}..${to} must be YYYY-MM-DD dates with from <= to`);
  const startDate = from;
  const endDate = to;
  const window = valueSeries.filter((p) => p.date >= from && p.date <= to);
  const dailyReturns = options.returns.filter((p) => p.date > from && p.date <= to).map((p) => p.value);
  const transitions = (options.trades ?? []).filter((t) => t.date > from && t.date <= to).length;
  const base = window.length ? window[0]!.value : 1;
  const equity = window.length ? window[window.length - 1]!.value / base : 1;

  let peak = base;
  let maxDd = 0;
  for (const pt of window) {
    if (pt.value > peak) peak = pt.value;
    const dd = (pt.value - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }

  const years = (+new Date(endDate) - +new Date(startDate)) / YEAR_MS;
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;
  const mean = dailyReturns.reduce((s, v) => s + v, 0) / Math.max(1, dailyReturns.length);
  const variance =
    dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean * 365) / (sd * Math.sqrt(365)) : 0;

  const splitDate = options.splitDate ?? BACKTEST_IN_SAMPLE_END;
  let isEquityStart: number | null = null;
  let isEquityEnd: number | null = null;
  let oosEquityStart: number | null = null;
  let oosEquityEnd: number | null = null;
  for (const pt of window) {
    if (isEquityStart == null) isEquityStart = pt.value;
    if (pt.date <= splitDate) isEquityEnd = pt.value;
    else {
      if (oosEquityStart == null) oosEquityStart = pt.value;
      oosEquityEnd = pt.value;
    }
  }
  const yearsIs = (+new Date(splitDate) - +new Date(startDate)) / YEAR_MS;
  const yearsOos = (+new Date(endDate) - +new Date(splitDate)) / YEAR_MS;
  const cagrIs =
    isEquityStart && isEquityEnd && yearsIs > 0 ? Math.pow(isEquityEnd / isEquityStart, 1 / yearsIs) - 1 : null;
  const cagrOos =
    oosEquityStart && oosEquityEnd && yearsOos > 0
      ? Math.pow(oosEquityEnd / oosEquityStart, 1 / yearsOos) - 1
      : null;

  const monthEnd = new Map<string, Point>();
  for (const pt of window) monthEnd.set(pt.date.slice(0, 7), pt);
  const downsampled = [...monthEnd.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    final_value: nullIfNaN(equity),
    cagr: nullIfNaN(cagr),
    cagr_in_sample: cagrIs == null ? null : nullIfNaN(cagrIs),
    cagr_out_sample: cagrOos == null ? null : nullIfNaN(cagrOos),
    sharpe: nullIfNaN(sharpe),
    max_drawdown: nullIfNaN(maxDd),
    transitions,
    n_days: dailyReturns.length,
    start_date: startDate,
    end_date: endDate,
    equity_curve: downsampled,
    _daily: window,
  };
}

// Full-range statistics of one simulation: the reference report fields.
function fullStats(sim: SimulationResult): BacktestMetrics {
  return periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades });
}

export function computeBacktest(
  dateAxis: string[],
  result: RegimeComputeResult,
  extras: BacktestExtras,
): BacktestPayload {
  const priceSeries: Record<string, Point[]> = { eth: extras.eth, sp500: extras.spx };
  const assetSeries: Record<string, number[]> = {
    eth: forwardFillDaily(extras.eth, dateAxis),
    sp500: forwardFillDaily(extras.spx, dateAxis),
  };

  const panels = result.panels || PANELS;
  const strategies: Record<string, (string | null)[]> = { composite: result.regime };
  for (const p of panels) strategies[p] = result.panelRegimes[p];
  if (result.panelRegimes.macro) {
    strategies.macro_inverted = result.panelRegimes.macro.map((b) => {
      if (b === "risk_off") return "risk_on";
      if (b === "risk_on") return "risk_off";
      return b;
    });
  }
  // Conservative / aggressive generalized to N panels (reduces to the original
  // 2-panel truth tables exactly when N = 2).
  strategies.conservative = result.regime.map((_, i) =>
    combineConservativeN(panels.map((p) => result.panelRegimes[p][i])),
  );
  strategies.aggressive = result.regime.map((_, i) =>
    combineAggressiveN(panels.map((p) => result.panelRegimes[p][i])),
  );

  const out: BacktestPayload = {};
  for (const [pKey, spec] of Object.entries(PORTFOLIO_SPECS)) {
    if (firstIndexWithAllAssets(spec.risky, assetSeries, dateAxis.length) < 0) continue;
    const prices: Record<string, Point[]> = {};
    for (const a of spec.risky) prices[a] = priceSeries[a]!;
    const run = (schedule: Schedule) => fullStats(simulatePortfolio(dateAxis, schedule, prices, extras.tbill3m));

    const port: Record<string, BacktestMetrics> = {};
    for (const [name, regimeSeries] of Object.entries(strategies)) {
      port[name] = run(scheduleFromLabels(regimeSeries, spec.weights));
    }
    port[spec.hodl.key] = run(dateAxis.map(() => spec.hodl.weights));
    port.stables_only = run(dateAxis.map(() => ({ cash: 1 })));
    out[pKey] = port;
  }

  return out;
}

export function combineConservativeN(labels: (string | null)[]): string | null {
  if (labels.some((l) => !l)) return null;
  if (labels.some((l) => l === "risk_off")) return "risk_off";
  if (labels.every((l) => l === "risk_on")) return "risk_on";
  return "neutral";
}

export function combineAggressiveN(labels: (string | null)[]): string | null {
  if (labels.some((l) => !l)) return null;
  const score = (r: string | null) => (r === "risk_on" ? 1 : r === "risk_off" ? -1 : 0);
  const sum = labels.reduce((s, l) => s + score(l), 0);
  if (sum > 0) return "risk_on";
  if (sum < 0) return "risk_off";
  return "neutral";
}

function firstIndexWithAllAssets(assetKeys: string[], assetSeries: Record<string, number[]>, length: number): number {
  for (let i = 0; i < length; i++) {
    if (assetKeys.every((k) => Number.isFinite(assetSeries[k]![i]))) return i;
  }
  return -1;
}

export function forwardFillDaily(series: Point[] | undefined, dateAxis: string[]): number[] {
  const map = new Map<string, number>();
  if (Array.isArray(series)) for (const p of series) map.set(p.date, p.value);
  let last = NaN;
  const out = new Array<number>(dateAxis.length).fill(NaN);
  for (let i = 0; i < dateAxis.length; i++) {
    const v = map.get(dateAxis[i]);
    if (v !== undefined) last = v;
    out[i] = last;
  }
  return out;
}

function sameWeights(a: Weights, b: Weights): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1e-9) return false;
  }
  return true;
}

function turnoverBetween(a: Weights, b: Weights): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0;
  for (const k of keys) s += Math.abs((a[k] || 0) - (b[k] || 0));
  return s / 2; // one-sided turnover (∑|Δw|/2)
}

// Strip the per-day `_daily` series from every strategy for the persisted snapshot
// payload (mirrors the original stripDailyFromSnapshot).
export function stripDailyFromSnapshot(backtest: BacktestPayload): BacktestPayload {
  const out: BacktestPayload = {};
  for (const [portfolioName, strategies] of Object.entries(backtest)) {
    out[portfolioName] = {};
    for (const [strategyName, v] of Object.entries(strategies)) {
      const { _daily, ...rest } = v;
      void _daily;
      out[portfolioName][strategyName] = rest as BacktestMetrics;
    }
  }
  return out;
}

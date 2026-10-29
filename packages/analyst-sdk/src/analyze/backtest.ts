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
//
// Accuracy (decision D78): equity compounds as an unrounded
// double-double (each factor 1 + r formed exactly), each day's portfolio return
// and the turnover are compensated sums, the daily cash rate is
// expm1(log1p(rate) / 365), CAGR is expm1(log(ratio) / years), and periodStats
// takes a compensated mean and sample variance. The old plain-loop mean made
// bit-identical returns look volatile (variance 3.7e-36, Sharpe 4e14); exact
// variance is 0, so Sharpe is 0 under the zero-volatility convention. The
// frozen pre-refactor copy (tests/reference/backtest-pre-refactor.ts) keeps the
// old arithmetic and now agrees to within rounding, not byte for byte.
import type { RegimeComputeResult } from "./compute.ts";
import type { Point } from "../types.ts";
import { toDateMap } from "./correlations.ts";
import { PANELS } from "./indicators.ts";
import { annualizedGrowth, Compounder, ddDiv, ddMulD, ddValue, dotDD, meanAndSampleSd, periodicRate, sharpeDD, sumDD, twoSum } from "../transform/exact.ts";

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
  const { assetSeries, tbillDaily, firstIdx } = prepareSimulation(dateAxis, schedule, prices, cashRate);
  return simulate(dateAxis, schedule, assetSeries, tbillDaily, firstIdx, costRate);
}

interface PreparedSimulation {
  assetSeries: Record<string, number[]>;
  tbillDaily: number[];
  firstIdx: number;
}

// The input checks, forward fill, cash-rate series and first index shared by
// simulatePortfolio and simulateDrift.
function prepareSimulation(
  dateAxis: readonly string[],
  schedule: Schedule,
  prices: Record<string, Point[]>,
  cashRate: Point[],
): PreparedSimulation {
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
  return { assetSeries, tbillDaily, firstIdx };
}

function simulate(
  dateAxis: readonly string[],
  schedule: Schedule,
  assetSeries: Record<string, number[]>,
  tbillDaily: number[],
  firstIdx: number,
  costRate: number,
): SimulationResult {
  const equity = new Compounder(1);
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
      const dailyTbill = periodicRate((tbillDaily[i - 1] || 0) / 100, 365);
      // portRet = cash weight x daily cash rate + sum of weight x asset return,
      // as one compensated dot product.
      const { ws, rs } = dayTerms(lastWeights, assetSeries, i, dailyTbill);
      const portRet = ddValue(dotDD(ws, rs));
      equity.grow(portRet);
      returns.push({ date: dateAxis[i]!, value: portRet });
    }

    // Rebalance at close of today if weights changed (turnover-based cost).
    if (lastWeights != null && !sameWeights(lastWeights, w)) {
      const turnover = turnoverBetween(lastWeights, w);
      equity.shrinkByProduct(turnover, costRate);
      trades.push({ date: dateAxis[i]!, turnover, cost: turnover * costRate });
    }
    lastWeights = w;
    values.push({ date: dateAxis[i]!, value: equity.value });
  }

  return {
    values,
    returns,
    trades,
    startDate: dateAxis[firstActiveIdx >= 0 ? firstActiveIdx : firstIdx]!,
    endDate: dateAxis[dateAxis.length - 1]!,
  };
}

// One day's return terms for weights held from the previous close: the cash
// weight and the daily cash rate first, then each nonzero asset weight and that
// asset's price change, in key order. An asset whose previous or current price
// is not finite, or whose previous price is not positive, contributes no term
// (a zero return).
function dayTerms(weights: Weights, assetSeries: Record<string, number[]>, i: number, dailyCash: number): { ws: number[]; rs: number[] } {
  const ws: number[] = [weights.cash || 0];
  const rs: number[] = [dailyCash];
  for (const [asset, wa] of Object.entries(weights)) {
    if (asset === "cash" || wa === 0) continue;
    const p0 = assetSeries[asset]?.[i - 1];
    const p1 = assetSeries[asset]?.[i];
    if (Number.isFinite(p0) && Number.isFinite(p1) && p0! > 0) {
      ws.push(wa);
      rs.push(p1! / p0! - 1);
    }
  }
  return { ws, rs };
}

/** When a drifting book rebalances on the calendar, judged against the previous axis date. */
export type RebalanceFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "never";

const REBALANCE_FREQUENCIES: readonly RebalanceFrequency[] = ["daily", "weekly", "monthly", "quarterly", "never"];

export interface DriftOptions {
  // Cost per unit of one-sided turnover, in basis points. Default 10, as simulatePortfolio.
  costBps?: number;
  // Calendar rebalance rule. Default "daily".
  freq?: RebalanceFrequency;
  // Rebalance when any weight is more than `band` (absolute) from its target. Default: no band.
  band?: number;
}

/** UTC weekday of a YYYY-MM-DD date, Monday 0 through Sunday 6. */
const weekdayOf = (iso: string): number => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

function calendarDue(freq: RebalanceFrequency, prev: string, cur: string): boolean {
  switch (freq) {
    case "daily":
      return true;
    case "weekly":
      return weekdayOf(cur) < weekdayOf(prev);
    case "monthly":
      return cur.slice(0, 7) !== prev.slice(0, 7);
    case "quarterly":
      return cur.slice(0, 7) !== prev.slice(0, 7) && ["01", "04", "07", "10"].includes(cur.slice(5, 7));
    case "never":
      return false;
  }
}

/**
 * A holding's weight after one day, w (1 + r) / (1 + rp), for its own return r
 * and the portfolio return rp. Both factors come from twoSum, the numerator from
 * ddMulD (TwoProd keeps the rounding error of w times the high word), and the
 * quotient is rounded once (D78).
 */
export function driftedWeight(w: number, r: number, rp: number): number {
  return ddValue(ddDiv(ddMulD(twoSum(1, r), w), twoSum(1, rp)));
}

// The drift-aware simulation (analytics requirements 5.3). Inputs, forward
// fill, first index and cash rate are simulatePortfolio's. Holdings start at the
// first date's target at no cost; on each later date with weights they earn
// that day's return and drift to w (1 + r_k) / (1 + r_p). The book rebalances
// to the day's target when the target changed since the last rebalance, when
// the calendar rule fires, or when a weight is more than `band` from target; a
// rebalance with turnover above 1e-9 costs turnover times costBps / 10000.
// With costBps 0 and freq "daily" the values and returns equal
// simulatePortfolio's bit for bit. Pure: no file, no HTTP.
export function simulateDrift(
  dateAxis: readonly string[],
  schedule: Schedule,
  prices: Record<string, Point[]>,
  cashRate: Point[],
  options: DriftOptions = {},
): SimulationResult {
  for (const k of Object.keys(options)) {
    if (k !== "costBps" && k !== "freq" && k !== "band") throw new RangeError(`unknown option ${JSON.stringify(k)}; expected costBps, freq, band`);
  }
  const { costBps, freq = "daily", band } = options;
  if (costBps !== undefined && (typeof costBps !== "number" || !Number.isFinite(costBps) || costBps < 0)) {
    throw new RangeError(`costBps must be a finite nonnegative number, got ${JSON.stringify(costBps)}`);
  }
  if (!REBALANCE_FREQUENCIES.includes(freq)) {
    throw new RangeError(`freq must be one of ${REBALANCE_FREQUENCIES.join(", ")}, got ${JSON.stringify(freq)}`);
  }
  if (band !== undefined && (typeof band !== "number" || !Number.isFinite(band) || band < 0)) {
    throw new RangeError(`band must be a finite nonnegative number, got ${JSON.stringify(band)}`);
  }
  const costRate = costBps === undefined ? BACKTEST_COST_PER_REBALANCE : costBps / 10_000;
  const { assetSeries, tbillDaily, firstIdx } = prepareSimulation(dateAxis, schedule, prices, cashRate);

  const equity = new Compounder(1);
  // The drifted weights of the book; holdings are held x equity.
  let held: Weights | null = null;
  let lastTarget: Weights | null = null;
  const values: Point[] = [];
  const returns: Point[] = [];
  const trades: TradeEvidence[] = [];
  let firstActiveIdx = -1;

  for (let i = firstIdx; i < dateAxis.length; i++) {
    const w = schedule[i];
    if (!w) continue;
    const date = dateAxis[i]!;
    if (firstActiveIdx < 0) firstActiveIdx = i;
    if (held == null || lastTarget == null) {
      held = { ...w };
      lastTarget = w;
      values.push({ date, value: equity.value });
      continue;
    }

    const dailyCash = periodicRate((tbillDaily[i - 1] || 0) / 100, 365);
    const { ws, rs } = dayTerms(held, assetSeries, i, dailyCash);
    const portRet = ddValue(dotDD(ws, rs));
    // fl(1 + r_p) is 0 only when 1 + r_p is exactly 0, so its sign is the exact sign.
    if (!(1 + portRet > 0)) throw new RangeError(`simulateDrift: 1 + portfolio return is not positive on ${date} (${portRet})`);
    equity.grow(portRet);
    returns.push({ date, value: portRet });

    const next: Weights = {};
    for (const [k, wk] of Object.entries(held)) {
      let r = 0;
      if (k === "cash") r = dailyCash;
      else {
        const p0 = assetSeries[k]?.[i - 1];
        const p1 = assetSeries[k]?.[i];
        if (Number.isFinite(p0) && Number.isFinite(p1) && p0! > 0) r = p1! / p0! - 1;
      }
      next[k] = driftedWeight(wk, r, portRet);
    }
    held = next;

    const drifted =
      band !== undefined && [...new Set([...Object.keys(held), ...Object.keys(w)])].some((k) => Math.abs((held![k] || 0) - (w[k] || 0)) > band);
    if (!sameWeights(lastTarget, w) || calendarDue(freq, dateAxis[i - 1]!, date) || drifted) {
      const turnover = turnoverBetween(held, w);
      if (turnover > 1e-9) {
        equity.shrinkByProduct(turnover, costRate);
        trades.push({ date, turnover, cost: turnover * costRate });
      }
      held = { ...w };
      lastTarget = w;
    }
    values.push({ date, value: equity.value });
  }

  return {
    values,
    returns,
    trades,
    startDate: dateAxis[firstActiveIdx >= 0 ? firstActiveIdx : firstIdx]!,
    endDate: dateAxis[dateAxis.length - 1]!,
  };
}

/** The year periodStats annualizes over: 365.25 days, in milliseconds. */
export const YEAR_MS = 365.25 * 86400 * 1000;

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
  const equityDD = window.length ? ddDiv([window[window.length - 1]!.value, 0], [base, 0]) : ([1, 0] as const);
  const equity = ddValue(equityDD);

  let peak = base;
  let maxDd = 0;
  for (const pt of window) {
    if (pt.value > peak) peak = pt.value;
    const dd = (pt.value - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }

  const years = (+new Date(endDate) - +new Date(startDate)) / YEAR_MS;
  const cagr = years > 0 ? annualizedGrowth(equityDD, years) : 0;
  // Compensated mean and sample sd. With no returns the mean is 0 and with one
  // the sd is 0 (the old max(1, n) and max(1, n - 1) divisors); either way, and
  // whenever the returns are all equal, sd is exactly 0 and Sharpe is 0.
  const { mean, sd } = dailyReturns.length === 0 ? { mean: [0, 0] as const, sd: [0, 0] as const } : meanAndSampleSd(dailyReturns);
  const sharpe = sd[0] > 0 ? sharpeDD(mean, sd, 365) : 0;

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
    isEquityStart && isEquityEnd && yearsIs > 0 ? annualizedGrowth(ddDiv([isEquityEnd, 0], [isEquityStart, 0]), yearsIs) : null;
  const cagrOos =
    oosEquityStart && oosEquityEnd && yearsOos > 0
      ? annualizedGrowth(ddDiv([oosEquityEnd, 0], [oosEquityStart, 0]), yearsOos)
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

// One-sided turnover (∑|Δw|/2): each difference is kept exact as a twoSum pair
// (with its sign folded in), and the pairs are summed compensated.
function turnoverBetween(a: Weights, b: Weights): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const parts: number[] = [];
  for (const k of keys) {
    const [d, e] = twoSum(a[k] || 0, -(b[k] || 0));
    if (d < 0 || (d === 0 && e < 0)) parts.push(-d, -e);
    else parts.push(d, e);
  }
  return ddValue(sumDD(parts)) / 2;
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

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
// 100% stables. Within a market every strategy and baseline starts on the first
// day all the strategies can trade (issue 1559). equity_curve is the start value
// then month-end values; the per-day `_daily` series is stripped from the
// snapshot payload (stripDailyFromSnapshot).
//
// Issue 1404 exposes the same calculation for supplied portfolios:
// simulatePortfolio (any assets, schedule, cash rate, costBps), periodStats (the
// established statistics over a supplied range, from the simulation's pre-cost
// returns and boundary evidence) and scheduleFromLabels (the label-to-weight
// mapping). computeBacktest is those three over the reference portfolios; its
// output matches the pre-refactor code with the issue 1559 start rule applied
// (tests/backtest.test.ts against tests/reference/backtest-pre-refactor.ts and
// tests/support/issue-1559.ts). Spec: analytics
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
//
// Issue 1554: no series is filled without a declared fill policy. Each price
// series and the cash rate the simulators read has one, through options.fill or
// DEFAULT_SIMULATOR_FILL; the reference backtest's are REFERENCE_FILL_POLICIES.
// Every shipped value is forward with no age limit, the former undeclared carry,
// so every output is unchanged. A label with no weight row is refused by default
// (UNKNOWN_LABEL_RULE).
import type { Point } from "../types.ts";
import { FillPolicyError, PANELS, fillMaxAgeDays, fillPolicyOf, type FillPolicy } from "./indicators.ts";
import { CURRENT_REGIME_VERSION, adoptionDate } from "./regime-versions.ts";
import { annualizedGrowth, Compounder, ddDiv, ddMulD, ddValue, dotDD, meanAndSampleSd, periodicRate, sharpeDD, sumDD, twoSum } from "../transform/exact.ts";

export const BACKTEST_COST_PER_REBALANCE = 0.001;
// The in-sample end: the adoption date of the current methodology version
// (issue 1734). Statistics up to and including it are in-sample, after it
// out-of-sample.
export const BACKTEST_IN_SAMPLE_END = adoptionDate(CURRENT_REGIME_VERSION);

/** Thrown by periodStats for a value series sparser than daily (issue 1734, finding B7). */
export class SparseSeriesError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "SparseSeriesError";
  }
}

/**
 * The longest median gap, in days, between consecutive values that still counts
 * as a daily series. A hole where no label applied is still a daily series; a
 * weekly or monthly one is not.
 */
export const MAX_DAILY_MEDIAN_GAP_DAYS = 1;

/**
 * The bond-equivalent yield, in percent, of a 3-month T-bill discount quote in
 * percent (finding B5). DTB3 is a discount rate d on a 360-day basis for 91
 * days: price = 1 - d x 91 / 360, yield = 365 d / (360 - 91 d). Both simulators
 * convert the cash rate with this helper before compounding.
 */
export function discountToYield(discountPercent: number): number {
  const d = discountPercent / 100;
  return (365 * d) / (360 - 91 * d) * 100;
}

/**
 * How the cash rate quote is read (issue 1751). "discount" converts a T-bill
 * discount quote with discountToYield before compounding (the default, decision
 * D94 item 6); "yield" compounds the quote as a yearly yield with no conversion.
 */
export type CashBasis = "discount" | "yield";

const CASH_BASES: readonly CashBasis[] = ["discount", "yield"];

function cashBasisOf(v: unknown): CashBasis {
  if (v === undefined) return "discount";
  if (!CASH_BASES.includes(v as CashBasis)) throw new RangeError(`cashBasis must be one of ${CASH_BASES.join(", ")}, got ${JSON.stringify(v)}`);
  return v as CashBasis;
}

/** The daily cash rate of a percent quote under a cash basis. */
function dailyCashRate(quotePercent: number, basis: CashBasis): number {
  return periodicRate((basis === "yield" ? quotePercent : discountToYield(quotePercent)) / 100, 365);
}

/**
 * The daily returns the Sharpe ratio reads (issue 1751): "excess" is the
 * post-cost return minus that day's cash return (the default, issue 1734);
 * "net" is the post-cost return with no cash subtraction.
 */
export type SharpeBasis = "excess" | "net";

const SHARPE_BASES: readonly SharpeBasis[] = ["excess", "net"];

function sharpeBasisOf(v: unknown): SharpeBasis {
  if (v === undefined) return "excess";
  if (!SHARPE_BASES.includes(v as SharpeBasis)) throw new RangeError(`sharpeBasis must be one of ${SHARPE_BASES.join(", ")}, got ${JSON.stringify(v)}`);
  return v as SharpeBasis;
}

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

/** One labelled block of statistics over a window (issue 1734). */
export interface SampleBlock {
  label: "in_sample" | "out_of_sample";
  start_date: string | null;
  end_date: string | null;
  n_days: number;
  cagr: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  transitions: number;
}

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
  // The statistics split at `sample_split_date` (the adoption date of the
  // methodology version): up to and including it, and after it.
  sample_split_date: string;
  in_sample: SampleBlock;
  out_of_sample: SampleBlock;
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

// A declared fill policy for one simulator series: issue 1655's FillPolicy
// (with issue 1554's `forward` form with no age limit, maxAgeDays null) and the
// reason it was chosen. Validated by fillPolicyOf.
export type DeclaredFill = FillPolicy & { reason: string };

// The fill policy per simulator series: one per key of `prices`, and `cash`
// for the cash rate.
export type SimulatorFill = Record<string, DeclaredFill>;

// The policy of a simulator series with no `fill` entry. null means every
// series must be declared. The declared value reproduces the undeclared carry
// the simulators applied before issue 1554, so a caller that passes no `fill`
// gets the same values, trades and evidence. An analyst changes it here, in a
// reviewed diff (research issue 1673 records the choice).
export let DEFAULT_SIMULATOR_FILL: DeclaredFill | null = { kind: "forward", maxAgeDays: null, reason: "Reproduces the undeclared carry" };

// Test seam: runs `fn` with DEFAULT_SIMULATOR_FILL set to `fill`, then restores
// the declared value. Not on the package entry.
export function withDefaultSimulatorFill<T>(fill: DeclaredFill | null, fn: () => T): T {
  const saved = DEFAULT_SIMULATOR_FILL;
  DEFAULT_SIMULATOR_FILL = fill;
  try {
    return fn();
  } finally {
    DEFAULT_SIMULATOR_FILL = saved;
  }
}

/**
 * Days an asset's market is open (issue 1734). `continuous` trades every axis
 * date, `weekdays` Monday to Friday, `observed` only on dates the asset's own
 * price series has a value (so a holiday is closed too).
 */
export type MarketCalendar = "continuous" | "weekdays" | "observed";

const MARKET_CALENDARS: readonly MarketCalendar[] = ["continuous", "weekdays", "observed"];

/** Cost per unit of one-sided turnover in basis points: one number, or a rate per asset id. */
export type CostBps = number | Record<string, number>;

export interface SimulateOptions {
  // Cost in basis points. A number is the rate on one-sided turnover (default
  // 10, the established BACKTEST_COST_PER_REBALANCE). A map gives each risky
  // asset its own rate on the notional of its leg of a trade (an asset with no
  // entry pays 10); cash trades free.
  costBps?: CostBps;
  // Axis days between the day a target is known (its close) and the day it can
  // trade (at that day's close). Default 1: a day's label trades no earlier
  // than the next session. 0 reproduces same-close execution.
  lagSessions?: number;
  // Open days per asset. Default "observed" for every asset. A trade that
  // changes an asset's weight waits for the next day that asset's market is open.
  calendars?: Record<string, MarketCalendar>;
  // Fill policy per series (issue 1554). A series with no entry uses
  // DEFAULT_SIMULATOR_FILL.
  fill?: SimulatorFill;
  // How the cash rate quote is read (issue 1751). Default "discount".
  cashBasis?: CashBasis;
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
  // Per day, the post-cost return minus that day's cash return: what Sharpe reads (issue 1734).
  excess: Point[];
  // Per day, the post-cost return with no cash subtraction (issue 1751).
  net: Point[];
  trades: TradeEvidence[];
  startDate: string;
  endDate: string;
}

export interface PeriodStatsOptions {
  // The simulation's pre-cost daily return observations (SimulationResult.returns).
  returns: Point[];
  // The simulation's post-cost, excess-of-cash daily returns (SimulationResult.excess).
  excess: Point[];
  // Trade evidence; its count inside the window is `transitions`.
  trades?: TradeEvidence[];
  // In-sample end. Default BACKTEST_IN_SAMPLE_END.
  splitDate?: string;
  // The simulation's post-cost daily returns (SimulationResult.net). Required
  // with sharpeBasis "net".
  net?: Point[];
  // The returns the Sharpe ratio reads (issue 1751). Default "excess".
  sharpeBasis?: SharpeBasis;
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

// What scheduleFromLabels does with a non-null label that has no own row in the
// weight table: "skip" gives a null entry (a skipped day, the former
// behaviour); "refuse" throws a RangeError naming the index and the label.
export type UnknownLabelRule = "skip" | "refuse";

// Declared value (issue 1554): a misspelt label is bad input, so the default
// fails closed. Every label computeRegime produces has a weight row, so the
// reference backtest never meets one.
export const UNKNOWN_LABEL_RULE: UnknownLabelRule = "refuse";

// The established label-to-weight mapping. A null label has no applicable
// weights (a skipped day) under either rule; a non-null label with no own row
// follows options.unknownLabel (default UNKNOWN_LABEL_RULE).
export function scheduleFromLabels(
  labels: readonly (string | null)[],
  table: Record<string, Weights>,
  options: { unknownLabel?: UnknownLabelRule } = {},
): Schedule {
  for (const k of Object.keys(options)) {
    if (k !== "unknownLabel") throw new RangeError(`scheduleFromLabels: unknown option ${JSON.stringify(k)}; expected unknownLabel`);
  }
  const rule = options.unknownLabel ?? UNKNOWN_LABEL_RULE;
  if (rule !== "skip" && rule !== "refuse") throw new RangeError(`scheduleFromLabels: unknownLabel must be "skip" or "refuse", got ${JSON.stringify(rule)}`);
  return labels.map((l, i) => {
    if (l == null) return null;
    if (Object.hasOwn(table, l)) return table[l]!;
    if (rule === "refuse") throw new RangeError(`scheduleFromLabels: label ${JSON.stringify(l)} at index ${i} has no weight row`);
    return null;
  });
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
    if (!["costBps", "fill", "lagSessions", "calendars", "cashBasis"].includes(k)) throw new RangeError(`unknown option ${JSON.stringify(k)}; expected costBps, fill, lagSessions, calendars, cashBasis`);
  }
  const costs = costSpec(options.costBps);
  const cashBasis = cashBasisOf(options.cashBasis);
  const prepared = prepareSimulation(dateAxis, schedule, prices, cashRate, options.fill);
  const executed = executionSchedule(dateAxis, schedule, prices, options);
  return simulate(dateAxis, executed, prepared, costs, cashBasis);
}

type CostSpec = { kind: "rate"; rate: number } | { kind: "map"; rates: Record<string, number> };

/** Validates costBps (a number or a per-asset map) into a CostSpec. */
function costSpec(costBps: CostBps | undefined): CostSpec {
  const bad = (v: unknown) => typeof v !== "number" || !Number.isFinite(v) || v < 0;
  if (costBps === undefined) return { kind: "rate", rate: BACKTEST_COST_PER_REBALANCE };
  if (costBps !== null && typeof costBps === "object" && !Array.isArray(costBps)) {
    const rates: Record<string, number> = {};
    for (const [k, v] of Object.entries(costBps)) {
      if (bad(v)) throw new RangeError(`costBps for ${JSON.stringify(k)} must be a finite nonnegative number, got ${JSON.stringify(v)}`);
      rates[k] = v / 10_000;
    }
    return { kind: "map", rates };
  }
  if (bad(costBps)) throw new RangeError(`costBps must be a finite nonnegative number or a map of them, got ${JSON.stringify(costBps)}`);
  return { kind: "rate", rate: (costBps as number) / 10_000 };
}

/** The one-sided turnover of a rebalance and the cost rate that applies to it. */
function tradeCost(a: Weights, b: Weights, spec: CostSpec): { turnover: number; rate: number } {
  const turnover = turnoverBetween(a, b);
  if (spec.kind === "rate") return { turnover, rate: spec.rate };
  let cost = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "cash") continue;
    cost += Math.abs((a[k] || 0) - (b[k] || 0)) * (spec.rates[k] ?? BACKTEST_COST_PER_REBALANCE);
  }
  return { turnover, rate: turnover > 0 ? cost / turnover : 0 };
}

/** The day's return after the trade cost (cost = turnover x rate of the book). */
function netOfCost(portRet: number, cost: number): number {
  return cost === 0 ? portRet : (1 + portRet) * (1 - cost) - 1;
}

const weekdayIndex = (iso: string): number => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Per axis date, whether an asset's market is open. */
function openDays(dateAxis: readonly string[], pts: Point[] | undefined, calendar: MarketCalendar): boolean[] {
  if (calendar === "continuous") return dateAxis.map(() => true);
  if (calendar === "weekdays") return dateAxis.map((d) => weekdayIndex(d) < 5);
  const seen = new Set<string>();
  if (Array.isArray(pts)) for (const p of pts) if (Number.isFinite(p.value)) seen.add(p.date);
  return dateAxis.map((d) => seen.has(d));
}

/**
 * The weights the book holds after each date's close (issue 1734). A target set
 * at date j trades no earlier than date j + lagSessions, and a trade that
 * changes an asset's weight waits for that asset's next open day. A null
 * target leaves the day unscheduled, as before. With lag 0 and every market
 * open the schedule is returned unchanged.
 */
function executionSchedule(
  dateAxis: readonly string[],
  schedule: Schedule,
  prices: Record<string, Point[]>,
  options: { lagSessions?: number; calendars?: Record<string, MarketCalendar> },
): Schedule {
  const lag = options.lagSessions ?? 1;
  if (!Number.isInteger(lag) || lag < 0) throw new RangeError(`lagSessions must be a nonnegative integer, got ${JSON.stringify(lag)}`);
  const calendars = options.calendars ?? {};
  for (const [k, c] of Object.entries(calendars)) {
    if (!MARKET_CALENDARS.includes(c)) throw new RangeError(`calendar for ${JSON.stringify(k)} must be one of ${MARKET_CALENDARS.join(", ")}, got ${JSON.stringify(c)}`);
    if (!Object.hasOwn(prices, k)) throw new RangeError(`calendar key ${JSON.stringify(k)} names no series; expected a key of prices`);
  }
  const open: Record<string, boolean[]> = {};
  for (const k of Object.keys(prices)) open[k] = openDays(dateAxis, prices[k], calendars[k] ?? "observed");
  const allOpen = Object.values(open).every((o) => o.every(Boolean));
  if (lag === 0 && allOpen) return schedule;

  const out: Schedule = new Array(dateAxis.length).fill(null);
  let held: Weights | null = null;
  for (let i = 0; i < dateAxis.length; i++) {
    const target = i - lag >= 0 ? schedule[i - lag]! : null;
    if (!target) continue;
    const changing = (held == null ? Object.keys(target) : [...new Set([...Object.keys(held), ...Object.keys(target)])]).filter(
      (k) => k !== "cash" && Math.abs((target[k] || 0) - (held?.[k] || 0)) > 1e-9,
    );
    if (changing.every((k) => open[k]?.[i] ?? true)) held = target;
    else if (held == null) continue;
    out[i] = held;
  }
  return out;
}

interface PreparedSimulation {
  assetSeries: Record<string, number[]>;
  // Per asset and date: whether the series has a value there under its policy.
  assetHas: Record<string, boolean[]>;
  assetPolicy: Record<string, FillPolicy>;
  tbillDaily: number[];
  cashHas: boolean[];
  cashPolicy: FillPolicy;
  firstIdx: number;
}

/** Validates a declared fill policy (fillPolicyOf, with its reason); a bad one is a RangeError naming the series. */
function declaredPolicy(name: string, f: unknown): FillPolicy {
  try {
    return fillPolicyOf({ id: name, fill: f, fillReason: f !== null && typeof f === "object" ? (f as { reason?: unknown }).reason : undefined });
  } catch (e) {
    if (e instanceof FillPolicyError) throw new RangeError(`fill policy for ${name} is invalid: ${e.message}`);
    throw e;
  }
}

/** The fill policy of every series a simulation reads: its `fill` entry, else DEFAULT_SIMULATOR_FILL. */
function simulatorPolicies(prices: Record<string, Point[]>, fill: SimulatorFill | undefined): { price: Record<string, FillPolicy>; cash: FillPolicy } {
  if (fill !== undefined) {
    if (fill === null || typeof fill !== "object" || Array.isArray(fill)) throw new RangeError("fill must be a record of fill policy per series");
    for (const k of Object.keys(fill)) {
      if (k !== "cash" && !Object.hasOwn(prices, k)) throw new RangeError(`fill key ${JSON.stringify(k)} names no series; expected cash or a key of prices`);
    }
  }
  const of = (key: string, name: string): FillPolicy => {
    const f = fill !== undefined && Object.hasOwn(fill, key) && fill[key] !== undefined ? fill[key] : DEFAULT_SIMULATOR_FILL;
    if (f === null) throw new RangeError(`fill policy missing for ${name}`);
    return declaredPolicy(name, f);
  };
  const price: Record<string, FillPolicy> = {};
  for (const k of Object.keys(prices)) price[k] = of(k, `price ${JSON.stringify(k)}`);
  return { price, cash: of("cash", "the cash rate") };
}

/** A fill policy in words, for error messages. */
function describeFill(p: FillPolicy): string {
  if (p.kind === "forward") return p.maxAgeDays === null ? "fill forward, no age limit" : `fill forward ${p.maxAgeDays} days`;
  return `fill ${p.kind}`;
}

const DAY_MS = 86_400_000;
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

interface AxisSeries {
  // The value per axis date; NaN where the series has none.
  values: number[];
  // Whether the series has a value on the date under its policy (an invalid
  // observation is a value).
  has: boolean[];
  // Index of the first axis date with an observation, -1 when none.
  firstObs: number;
}

// A series on the date axis under its fill policy (issue 1554). A value on day
// d is the observation dated d (finite or not); with none on d, `none` gives a
// missing value, `forward` N the latest observation dated d-1 to d-N, `forward`
// with no age limit the latest observation before d, and `zero` gives 0.
// Before the first observation `none` and `forward` give a missing value. As
// before issue 1554, only observations dated on axis dates are read.
function fillOnAxis(series: Point[] | undefined, dateAxis: readonly string[], policy: FillPolicy): AxisSeries {
  const map = new Map<string, number>();
  if (Array.isArray(series)) for (const p of series) map.set(p.date, p.value);
  const maxAge = fillMaxAgeDays(policy);
  const values = new Array<number>(dateAxis.length).fill(NaN);
  const has = new Array<boolean>(dateAxis.length).fill(false);
  let firstObs = -1;
  let last = NaN;
  let lastDay = NaN;
  for (let i = 0; i < dateAxis.length; i++) {
    const v = map.get(dateAxis[i]!);
    if (v !== undefined) {
      if (firstObs < 0) firstObs = i;
      last = v;
      lastDay = dayNumber(dateAxis[i]!);
      values[i] = v;
      has[i] = true;
    } else if (policy.kind === "zero") {
      values[i] = 0;
      has[i] = true;
    } else if (firstObs >= 0 && (maxAge === Infinity || dayNumber(dateAxis[i]!) - lastDay <= maxAge)) {
      values[i] = last;
      has[i] = true;
    }
  }
  return { values, has, firstObs };
}

// The cash rate on the axis: before its first observation it earns zero (a
// value of 0); after it, its value under the policy, a non-finite observation
// earning zero; a date the policy does not cover is missing (NaN).
function cashOnAxis(cashRate: Point[] | undefined, dateAxis: readonly string[], policy: FillPolicy): { rate: number[]; has: boolean[] } {
  const f = fillOnAxis(cashRate, dateAxis, policy);
  const rate = new Array<number>(dateAxis.length);
  const has = new Array<boolean>(dateAxis.length);
  for (let i = 0; i < dateAxis.length; i++) {
    if (f.firstObs < 0 || i < f.firstObs) {
      rate[i] = 0;
      has[i] = true;
    } else {
      rate[i] = f.has[i] ? (Number.isFinite(f.values[i]) ? f.values[i]! : 0) : NaN;
      has[i] = f.has[i]!;
    }
  }
  return { rate, has };
}

// A held day reads, for the cash leg and every asset with a nonzero weight held
// into day i, its value on the previous date (and, for an asset, the current
// date). A value its policy does not cover is a RangeError naming the series,
// the date and the policy.
function checkHeldDay(weights: Weights, p: PreparedSimulation, dateAxis: readonly string[], i: number): void {
  if ((weights.cash || 0) !== 0 && !p.cashHas[i - 1]) {
    throw new RangeError(`the cash rate has no value on ${dateAxis[i - 1]} (${describeFill(p.cashPolicy)})`);
  }
  for (const [asset, wa] of Object.entries(weights)) {
    if (asset === "cash" || !wa) continue;
    for (const j of [i - 1, i]) {
      if (!p.assetHas[asset]![j]) throw new RangeError(`price ${JSON.stringify(asset)} has no value on ${dateAxis[j]} (${describeFill(p.assetPolicy[asset]!)})`);
    }
  }
}

// The input checks, declared fill, cash-rate series and first index shared by
// simulatePortfolio and simulateDrift.
function prepareSimulation(
  dateAxis: readonly string[],
  schedule: Schedule,
  prices: Record<string, Point[]>,
  cashRate: Point[],
  fill: SimulatorFill | undefined,
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

  const policies = simulatorPolicies(prices, fill);
  const cash = cashOnAxis(cashRate, dateAxis, policies.cash);
  const assetSeries: Record<string, number[]> = {};
  const assetHas: Record<string, boolean[]> = {};
  for (const [k, pts] of Object.entries(prices)) {
    const f = fillOnAxis(pts, dateAxis, policies.price[k]!);
    assetSeries[k] = f.values;
    assetHas[k] = f.has;
  }
  const firstIdx = firstIndexWithAllAssets(Object.keys(assetSeries), assetSeries, dateAxis.length);
  if (firstIdx < 0) {
    throw new RangeError(`missing price coverage: no date in ${dateAxis[0]}..${dateAxis[dateAxis.length - 1]} has prices for every asset (${Object.keys(prices).join(", ")})`);
  }
  return { assetSeries, assetHas, assetPolicy: policies.price, tbillDaily: cash.rate, cashHas: cash.has, cashPolicy: policies.cash, firstIdx };
}

function simulate(
  dateAxis: readonly string[],
  schedule: Schedule,
  prepared: PreparedSimulation,
  costs: CostSpec,
  cashBasis: CashBasis,
): SimulationResult {
  const { assetSeries, tbillDaily, firstIdx } = prepared;
  const equity = new Compounder(1);
  let lastWeights: Weights | null = null;
  const values: Point[] = [];
  const returns: Point[] = [];
  const excess: Point[] = [];
  const net: Point[] = [];
  const trades: TradeEvidence[] = [];
  let firstActiveIdx = -1;

  for (let i = firstIdx; i < dateAxis.length; i++) {
    const w = schedule[i];
    if (!w) continue;
    if (firstActiveIdx < 0) firstActiveIdx = i;
    let dayRet: number | null = null;
    let dayCash = 0;

    // Day i's portfolio return = lastWeights · (day i's asset returns).
    if (lastWeights != null) {
      checkHeldDay(lastWeights, prepared, dateAxis, i);
      const dailyTbill = dailyCashRate(tbillDaily[i - 1] || 0, cashBasis);
      // portRet = cash weight x daily cash rate + sum of weight x asset return,
      // as one compensated dot product.
      const { ws, rs } = dayTerms(lastWeights, assetSeries, i, dailyTbill);
      const portRet = ddValue(dotDD(ws, rs));
      equity.grow(portRet);
      returns.push({ date: dateAxis[i]!, value: portRet });
      dayRet = portRet;
      dayCash = dailyTbill;
    }

    // Rebalance at close of today if weights changed (turnover-based cost).
    let tradeFraction = 0;
    if (lastWeights != null && !sameWeights(lastWeights, w)) {
      const { turnover, rate } = tradeCost(lastWeights, w, costs);
      equity.shrinkByProduct(turnover, rate);
      tradeFraction = turnover * rate;
      trades.push({ date: dateAxis[i]!, turnover, cost: tradeFraction });
    }
    if (dayRet != null) {
      const netRet = netOfCost(dayRet, tradeFraction);
      net.push({ date: dateAxis[i]!, value: netRet });
      excess.push({ date: dateAxis[i]!, value: netRet - dayCash });
    }
    lastWeights = w;
    values.push({ date: dateAxis[i]!, value: equity.value });
  }

  return {
    values,
    returns,
    excess,
    net,
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
  // Cost in basis points, as simulatePortfolio (a number or a map per asset). Default 10.
  costBps?: CostBps;
  // Execution lag and market calendars, as simulatePortfolio (issue 1734).
  lagSessions?: number;
  calendars?: Record<string, MarketCalendar>;
  // Calendar rebalance rule. Default "daily".
  freq?: RebalanceFrequency;
  // Rebalance when any weight is more than `band` (absolute) from its target. Default: no band.
  band?: number;
  // Fill policy per series, as simulatePortfolio (issue 1554).
  fill?: SimulatorFill;
  // How the cash rate quote is read, as simulatePortfolio (issue 1751). Default "discount".
  cashBasis?: CashBasis;
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
    if (!["costBps", "freq", "band", "fill", "lagSessions", "calendars", "cashBasis"].includes(k)) throw new RangeError(`unknown option ${JSON.stringify(k)}; expected costBps, freq, band, fill, lagSessions, calendars, cashBasis`);
  }
  const { freq = "daily", band } = options;
  const costs = costSpec(options.costBps);
  const cashBasis = cashBasisOf(options.cashBasis);
  if (!REBALANCE_FREQUENCIES.includes(freq)) {
    throw new RangeError(`freq must be one of ${REBALANCE_FREQUENCIES.join(", ")}, got ${JSON.stringify(freq)}`);
  }
  if (band !== undefined && (typeof band !== "number" || !Number.isFinite(band) || band < 0)) {
    throw new RangeError(`band must be a finite nonnegative number, got ${JSON.stringify(band)}`);
  }
  const prepared = prepareSimulation(dateAxis, schedule, prices, cashRate, options.fill);
  const { assetSeries, tbillDaily, firstIdx } = prepared;
  schedule = executionSchedule(dateAxis, schedule, prices, options);

  const equity = new Compounder(1);
  // The drifted weights of the book; holdings are held x equity.
  let held: Weights | null = null;
  let lastTarget: Weights | null = null;
  const values: Point[] = [];
  const returns: Point[] = [];
  const excess: Point[] = [];
  const net: Point[] = [];
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

    checkHeldDay(held, prepared, dateAxis, i);
    const dailyCash = dailyCashRate(tbillDaily[i - 1] || 0, cashBasis);
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
    let tradeFraction = 0;
    if (!sameWeights(lastTarget, w) || calendarDue(freq, dateAxis[i - 1]!, date) || drifted) {
      const { turnover, rate } = tradeCost(held, w, costs);
      if (turnover > 1e-9) {
        equity.shrinkByProduct(turnover, rate);
        tradeFraction = turnover * rate;
        trades.push({ date, turnover, cost: tradeFraction });
      }
      held = { ...w };
      lastTarget = w;
    }
    const netRet = netOfCost(portRet, tradeFraction);
    net.push({ date, value: netRet });
    excess.push({ date, value: netRet - dailyCash });
    values.push({ date, value: equity.value });
  }

  return {
    values,
    returns,
    excess,
    net,
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
    if (!["returns", "excess", "trades", "splitDate", "net", "sharpeBasis"].includes(k)) throw new RangeError(`unknown option ${JSON.stringify(k)}; expected returns, excess, trades, splitDate, net, sharpeBasis`);
  }
  const sharpeSeries = sharpeSeriesOf(options);
  if (!Array.isArray(options.returns)) throw new RangeError("options.returns (the simulation's pre-cost daily returns) is required");
  if (!Array.isArray(options.excess)) throw new RangeError("options.excess (the simulation's post-cost daily returns in excess of cash) is required");
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) throw new RangeError(`period ${from}..${to} must be YYYY-MM-DD dates with from <= to`);
  const startDate = from;
  const endDate = to;
  const window = valueSeries.filter((p) => p.date >= from && p.date <= to);
  const gaps: number[] = [];
  for (let k = 1; k < window.length; k++) gaps.push((+new Date(window[k]!.date) - +new Date(window[k - 1]!.date)) / 86_400_000);
  if (gaps.length > 0) {
    const median = [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)]!;
    if (median > MAX_DAILY_MEDIAN_GAP_DAYS) {
      throw new SparseSeriesError(`periodStats needs a daily value series: its median gap is ${median} days (limit ${MAX_DAILY_MEDIAN_GAP_DAYS})`);
    }
  }
  const dailyReturns = options.returns.filter((p) => p.date > from && p.date <= to).map((p) => p.value);
  const dailyExcess = sharpeSeries.filter((p) => p.date > from && p.date <= to).map((p) => p.value);
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
  // Sharpe reads the post-cost daily returns in excess of that day's cash rate
  // (issue 1734), so an all-cash book scores 0. With sharpeBasis "net" it reads
  // the post-cost daily returns instead (issue 1751).
  const sharpe = sharpeOf(dailyExcess);

  const splitDate = options.splitDate ?? BACKTEST_IN_SAMPLE_END;
  const inSample = sampleBlock("in_sample", window.filter((p) => p.date <= splitDate), options, from, splitDate, true);
  const outOfSample = sampleBlock("out_of_sample", window.filter((p) => p.date > splitDate), options, splitDate, to, false);
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

  // The curve opens with the window's first value (1 at a simulation's start),
  // then each month's last value (issue 1559).
  const monthEnd = new Map<string, Point>();
  for (const pt of window) monthEnd.set(pt.date.slice(0, 7), pt);
  const downsampled = [...monthEnd.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (window.length && downsampled[0] !== window[0]) downsampled.unshift(window[0]!);

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
    sample_split_date: splitDate,
    in_sample: inSample,
    out_of_sample: outOfSample,
    _daily: window,
  };
}

/**
 * The in-sample and out-of-sample blocks of a daily value series split at
 * `splitDate` (inclusive in-sample), for the research comparisons (issue 1734).
 * `excess` is the post-cost daily return in excess of cash, dated.
 */
export function splitSamples(
  values: Point[],
  excess: Point[],
  splitDate: string = BACKTEST_IN_SAMPLE_END,
): { sample_split_date: string; in_sample: SampleBlock; out_of_sample: SampleBlock } {
  const options: PeriodStatsOptions = { returns: excess, excess };
  const first = values.length ? values[0]!.date : splitDate;
  const last = values.length ? values[values.length - 1]!.date : splitDate;
  return {
    sample_split_date: splitDate,
    in_sample: sampleBlock("in_sample", values.filter((p) => p.date <= splitDate), options, first, splitDate, true),
    out_of_sample: sampleBlock("out_of_sample", values.filter((p) => p.date > splitDate), options, splitDate, last, false),
  };
}

// The dated returns the Sharpe ratio reads: options.excess, or options.net
// under sharpeBasis "net" (a RangeError when that series is absent).
function sharpeSeriesOf(options: PeriodStatsOptions): Point[] {
  if (sharpeBasisOf(options.sharpeBasis) === "excess") return options.excess;
  if (!Array.isArray(options.net)) throw new RangeError('options.net (the simulation\'s post-cost daily returns) is required with sharpeBasis "net"');
  return options.net;
}

// Annualized Sharpe of daily excess returns: compensated mean over sample sd;
// 0 with no return or a zero sd.
function sharpeOf(excess: number[]): number {
  if (excess.length === 0) return 0;
  const { mean, sd } = meanAndSampleSd(excess);
  return sd[0] > 0 ? sharpeDD(mean, sd, 365) : 0;
}

// One labelled block of statistics over the values `vals` (already cut to the
// block). Returns and trades count after the block's first value (or after
// `after` when the block starts the window), as periodStats counts them.
function sampleBlock(label: SampleBlock["label"], vals: Point[], options: PeriodStatsOptions, after: string, upTo: string, includesStart: boolean): SampleBlock {
  if (vals.length === 0) {
    return { label, start_date: null, end_date: null, n_days: 0, cagr: null, sharpe: null, max_drawdown: null, transitions: 0 };
  }
  const first = vals[0]!;
  const last = vals[vals.length - 1]!;
  const lo = includesStart ? first.date : after;
  const inBlock = (d: string) => d > lo && d <= (includesStart ? last.date : upTo);
  const excess = sharpeSeriesOf(options).filter((p) => inBlock(p.date)).map((p) => p.value);
  let peak = first.value;
  let maxDd = 0;
  for (const pt of vals) {
    if (pt.value > peak) peak = pt.value;
    const dd = (pt.value - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  const years = (+new Date(last.date) - +new Date(includesStart ? first.date : after)) / YEAR_MS;
  const cagr = first.value > 0 && years > 0 ? annualizedGrowth(ddDiv([last.value, 0], [first.value, 0]), years) : null;
  return {
    label,
    start_date: first.date,
    end_date: last.date,
    n_days: options.returns.filter((p) => inBlock(p.date)).length,
    cagr: cagr == null ? null : nullIfNaN(cagr),
    sharpe: nullIfNaN(sharpeOf(excess)),
    max_drawdown: nullIfNaN(maxDd),
    transitions: (options.trades ?? []).filter((t) => inBlock(t.date)).length,
  };
}

// Full-range statistics of one simulation: the reference report fields.
function fullStats(sim: SimulationResult, splitDate?: string, sharpeBasis?: SharpeBasis): BacktestMetrics {
  return periodStats(sim.values, sim.startDate, sim.endDate, {
    returns: sim.returns,
    excess: sim.excess,
    trades: sim.trades,
    ...(splitDate === undefined ? {} : { splitDate }),
    ...(sharpeBasis === undefined ? {} : { net: sim.net, sharpeBasis }),
  });
}

// The label series a reference backtest reads: the composite regime and one per
// panel. A RegimeComputeResult has this shape.
export interface BacktestLabels {
  regime: readonly (string | null)[];
  panelRegimes: Record<string, readonly (string | null)[]>;
  // Default PANELS.
  panels?: readonly string[];
}

// The reference grid's label series (analytics requirements 5.5): composite,
// one per panel, macro_inverted when a macro panel exists, conservative and
// aggressive (generalized to N panels; they reduce to the original 2-panel
// truth tables exactly when N = 2).
export function referenceStrategies(labels: BacktestLabels): Record<string, (string | null)[]> {
  // Default: the included panels the labels carry (a caller's labels may
  // predate a panel, e.g. two-panel labels from before issue 1708).
  const panels = labels.panels || PANELS.filter((p) => labels.panelRegimes[p]);
  const strategies: Record<string, (string | null)[]> = { composite: [...labels.regime] };
  for (const p of panels) strategies[p] = [...labels.panelRegimes[p]!];
  if (labels.panelRegimes.macro) {
    strategies.macro_inverted = labels.panelRegimes.macro.map((b) => {
      if (b === "risk_off") return "risk_on";
      if (b === "risk_on") return "risk_off";
      return b;
    });
  }
  strategies.conservative = labels.regime.map((_, i) => combineConservativeN(panels.map((p) => labels.panelRegimes[p]![i] ?? null)));
  strategies.aggressive = labels.regime.map((_, i) => combineAggressiveN(panels.map((p) => labels.panelRegimes[p]![i] ?? null)));
  return strategies;
}

// The reference backtest's fill policies, keyed like BacktestExtras: the one
// place they are declared. Each reproduces the published reference backtest
// exactly. An analyst changes one by editing its row, in a reviewed diff that
// also regenerates the golden (research issue 1673 records the choice).
export const REFERENCE_FILL_POLICIES: Readonly<Record<keyof BacktestExtras, DeclaredFill>> = {
  spx: { kind: "forward", maxAgeDays: null, reason: "Reproduces the published backtest" },
  eth: { kind: "forward", maxAgeDays: null, reason: "Reproduces the published backtest" },
  tbill3m: { kind: "forward", maxAgeDays: null, reason: "Reproduces the published backtest" },
};

// Market calendars of the reference assets (issue 1734): ETH trades every day,
// the S&P 500 only on days it printed a close.
export const REFERENCE_CALENDARS: Readonly<Record<string, MarketCalendar>> = { eth: "continuous", sp500: "observed" };

/** REFERENCE_CALENDARS cut to the assets a market trades. */
export const calendarsOf = (assets: readonly string[]): Record<string, MarketCalendar> =>
  Object.fromEntries(assets.filter((a) => Object.hasOwn(REFERENCE_CALENDARS, a)).map((a) => [a, REFERENCE_CALENDARS[a]!]));

const EXTRA_KEYS = ["spx", "eth", "tbill3m"] as const;

/**
 * Options of the reference backtest. `splitDate` is the in-sample end (default
 * BACKTEST_IN_SAMPLE_END, the current version's adoption date). The rest go to
 * every line of the grid (issue 1751): `lagSessions`, `calendars` and
 * `cashBasis` as simulatePortfolio takes them (calendars keyed eth and sp500,
 * default REFERENCE_CALENDARS), `sharpeBasis` as periodStats takes it.
 */
export interface ReferenceBacktestOptions {
  splitDate?: string;
  lagSessions?: number;
  calendars?: Record<string, MarketCalendar>;
  cashBasis?: CashBasis;
  sharpeBasis?: SharpeBasis;
}

const REFERENCE_OPTION_KEYS: readonly string[] = ["splitDate", "lagSessions", "calendars", "cashBasis", "sharpeBasis"];

// The reference backtest under REFERENCE_FILL_POLICIES.
export function computeBacktest(dateAxis: string[], labels: BacktestLabels, extras: BacktestExtras, options: ReferenceBacktestOptions = {}): BacktestPayload {
  return computeBacktestWithFill(dateAxis, labels, extras, REFERENCE_FILL_POLICIES, options);
}

// The reference backtest under the supplied policies (keyed like
// BacktestExtras). Each market ends on its latest complete day: the last axis
// date on which each of its risky assets and the cash rate has a value under
// its policy (the cash rate has one on every date before its first
// observation). Every line of the market is simulated over the axis cut at that
// day. A market with no complete day at or after its first priced date is left
// out. Not on the package entry.
export function computeBacktestWithFill(
  dateAxis: string[],
  labels: BacktestLabels,
  extras: BacktestExtras,
  fill: Readonly<Record<keyof BacktestExtras, DeclaredFill>>,
  options: ReferenceBacktestOptions = {},
): BacktestPayload {
  if (fill === null || typeof fill !== "object") throw new RangeError("fill must be a record of fill policy per extra (spx, eth, tbill3m)");
  for (const k of Object.keys(fill)) {
    if (!(EXTRA_KEYS as readonly string[]).includes(k)) throw new RangeError(`fill key ${JSON.stringify(k)} names no extra; expected spx, eth, tbill3m`);
  }
  for (const k of EXTRA_KEYS) if (!fill[k]) throw new RangeError(`fill policy missing for extra ${JSON.stringify(k)}`);
  for (const k of Object.keys(options)) {
    if (!REFERENCE_OPTION_KEYS.includes(k)) throw new RangeError(`unknown option ${JSON.stringify(k)}; expected ${REFERENCE_OPTION_KEYS.join(", ")}`);
  }
  if (options.calendars !== undefined) {
    if (options.calendars === null || typeof options.calendars !== "object") throw new RangeError("calendars must be a record of market calendar per asset (eth, sp500)");
    for (const k of Object.keys(options.calendars)) {
      if (k !== "eth" && k !== "sp500") throw new RangeError(`calendar key ${JSON.stringify(k)} names no reference asset; expected eth, sp500`);
    }
  }
  // Each market gets the supplied calendars of its own assets, else REFERENCE_CALENDARS.
  const calendarsFor = (assets: readonly string[]): Record<string, MarketCalendar> =>
    options.calendars === undefined ? calendarsOf(assets) : Object.fromEntries(assets.filter((a) => Object.hasOwn(options.calendars!, a)).map((a) => [a, options.calendars![a]!]));
  const lineOptions: SimulateOptions = {
    ...(options.lagSessions === undefined ? {} : { lagSessions: options.lagSessions }),
    ...(options.cashBasis === undefined ? {} : { cashBasis: options.cashBasis }),
  };
  const priceSeries: Record<string, Point[]> = { eth: extras.eth, sp500: extras.spx };
  const priceFill: Record<string, DeclaredFill> = { eth: fill.eth, sp500: fill.spx };
  const filled: Record<string, AxisSeries> = {
    eth: fillOnAxis(extras.eth, dateAxis, declaredPolicy('extra "eth"', fill.eth)),
    sp500: fillOnAxis(extras.spx, dateAxis, declaredPolicy('extra "spx"', fill.spx)),
  };
  const assetSeries: Record<string, number[]> = { eth: filled.eth!.values, sp500: filled.sp500!.values };
  const cashHas = cashOnAxis(extras.tbill3m, dateAxis, declaredPolicy('extra "tbill3m"', fill.tbill3m)).has;
  const strategies = referenceStrategies(labels);

  const out: BacktestPayload = {};
  for (const [pKey, spec] of Object.entries(PORTFOLIO_SPECS)) {
    const pricedIdx = firstIndexWithAllAssets(spec.risky, assetSeries, dateAxis.length);
    if (pricedIdx < 0) continue;
    let endIdx = dateAxis.length - 1;
    while (endIdx >= 0 && !(cashHas[endIdx] && spec.risky.every((a) => filled[a]!.has[endIdx]))) endIdx--;
    if (endIdx < pricedIdx) continue;
    const axis = endIdx === dateAxis.length - 1 ? dateAxis : dateAxis.slice(0, endIdx + 1);
    const prices: Record<string, Point[]> = {};
    const marketFill: SimulatorFill = { cash: fill.tbill3m };
    for (const a of spec.risky) {
      prices[a] = priceSeries[a]!;
      marketFill[a] = priceFill[a]!;
    }
    // Every line of a market starts on one date: the first day all the
    // strategies can trade (issue 1559). Before it, every schedule is empty, so
    // the comparison lines cover the strategies' window.
    const schedules: Record<string, Schedule> = {};
    for (const [name, regimeSeries] of Object.entries(strategies)) schedules[name] = scheduleFromLabels(regimeSeries.slice(0, axis.length), spec.weights);
    let startIdx = -1;
    for (const schedule of Object.values(schedules)) {
      const first = schedule.findIndex((w, i) => i >= pricedIdx && w != null);
      if (first > startIdx) startIdx = first;
    }
    schedules[spec.hodl.key] = axis.map(() => spec.hodl.weights);
    schedules.stables_only = axis.map(() => ({ cash: 1 }));

    const port: Record<string, BacktestMetrics> = {};
    for (const [name, schedule] of Object.entries(schedules)) {
      const fromStart = startIdx < 0 ? schedule : schedule.map((w, i) => (i < startIdx ? null : w));
      port[name] = fullStats(simulatePortfolio(axis, fromStart, prices, extras.tbill3m, { ...lineOptions, fill: marketFill, calendars: calendarsFor(spec.risky) }), options.splitDate, options.sharpeBasis);
    }
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

// A price series on the axis under its declared fill policy (default
// DEFAULT_SIMULATOR_FILL); NaN where the policy gives no value. It never fills
// a gap the policy does not cover. Not on the package entry.
export function forwardFillDaily(series: Point[] | undefined, dateAxis: readonly string[], policy: DeclaredFill | null = DEFAULT_SIMULATOR_FILL): number[] {
  if (policy === null) throw new RangeError("fill policy missing for the series");
  return fillOnAxis(series, dateAxis, declaredPolicy("the series", policy)).values;
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

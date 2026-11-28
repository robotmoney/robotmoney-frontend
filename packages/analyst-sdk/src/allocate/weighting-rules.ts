// The six portfolio weighting rules of Lex's optimizers page (issue 1766;
// analytics requirements section 5.7), under his keys and in his order: each
// splits a label's risk-on share across asset classes, the rest in cash. The
// solvers are the SDK's (ercCertified, minVarExact, tangencyExact through
// markowitzSchedule); this module adds the class returns, the rule schedules,
// the label scaling, the composition that returns the rules' figures and
// equity curves, and OPTIMIZERS_PRESET, the one set of values the backend and
// the workbench compute the page with. Pure: no file, no HTTP.
import type { Point } from "../types.ts";
import { PORTFOLIO_SPECS, discountToYield, simulateDrift, type CashBasis, type DriftOptions, type Schedule, type Weights } from "../analyze/backtest.ts";
import { carryForward, evaluateEquityCurve, pricesOf, tradingFor, type CurveGroup, type CurveGroupOptions, type EquityCurveKind } from "../analyze/equity-curves.ts";
import { dotDD, ddValue } from "../transform/exact.ts";
import { shrunkCov } from "./covariance.ts";
import { canonZero, markowitzSchedule, type MarkowitzRebalance, type MarkowitzScheduleResult } from "./markowitz.ts";
import { ercCertified, minVarExact, riskContributions, type Mat } from "./optimize.ts";

/** Lex's six rules, in his order. */
export const WEIGHTING_RULE_KEYS = ["naive", "inverse_vol", "equal_risk", "risk_budget", "min_variance", "markowitz"] as const;
export type WeightingRuleKey = (typeof WEIGHTING_RULE_KEYS)[number];

/** Each asset class and its member assets' fixed shares of it, in class order. */
export type AssetClasses = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Markowitz's own parameters: the fewest return rows it solves on and each class's expected total yearly return. */
export interface MarkowitzParameters {
  minObs: number;
  expectedReturn: Readonly<Record<string, number>>;
}

/** A risk rule's solver on a covariance, in class order. */
function riskSolver(key: Exclude<WeightingRuleKey, "markowitz">, classes: readonly string[], riskBudget: Readonly<Record<string, number>>): (S: Mat) => number[] {
  switch (key) {
    case "naive":
      return (S) => S.map(() => 1 / S.length);
    case "inverse_vol":
      return (S) => {
        const w = S.map((row, i) => 1 / Math.sqrt(row[i]!));
        const t = w.reduce((a, b) => a + b, 0);
        return w.map((x) => x / t);
      };
    case "equal_risk":
      return (S) => ercCertified(S);
    case "risk_budget":
      return (S) => ercCertified(S, classes.map((c) => riskBudget[c]!));
    case "min_variance":
      return (S) => minVarExact(S).map((x) => canonZero(x));
  }
}

/**
 * Each class's daily return on the days every member asset has a price,
 * measured from the previous such day, with each member's fixed share (a
 * compensated sum). Rows are in Object.keys(assetClasses) order.
 */
export function assetClassReturns(prices: Readonly<Record<string, Point[]>>, assetClasses: AssetClasses): Map<string, number[]> {
  const classes = Object.keys(assetClasses);
  if (classes.length === 0) throw new RangeError("assetClassReturns: no asset class");
  const members = [...new Set(classes.flatMap((c) => Object.keys(assetClasses[c]!)))];
  const at: Record<string, Map<string, number>> = {};
  for (const a of members) {
    if (!Array.isArray(prices[a])) throw new RangeError(`assetClassReturns: no prices for ${JSON.stringify(a)}`);
    at[a] = new Map(prices[a]!.filter((p) => Number.isFinite(p.value) && p.value > 0).map((p) => [p.date, p.value]));
  }
  const days = [...at[members[0]!]!.keys()].filter((d) => members.every((a) => at[a]!.has(d))).sort();
  const out = new Map<string, number[]>();
  for (let i = 1; i < days.length; i++) {
    const r: Record<string, number> = {};
    for (const a of members) r[a] = at[a]!.get(days[i]!)! / at[a]!.get(days[i - 1]!)! - 1;
    out.set(
      days[i]!,
      classes.map((c) => {
        const m = Object.entries(assetClasses[c]!);
        return ddValue(dotDD(m.map(([, f]) => f), m.map(([a]) => r[a]!)));
      }),
    );
  }
  return out;
}

/** The yearly cash rate of the newest quote dated before `day` (0 with none): its bond-equivalent yield under basis "discount". */
export function yearlyCashRateBefore(cashQuotes: readonly Point[], day: string, basis: CashBasis = "discount"): number {
  let best: Point | undefined;
  for (const p of cashQuotes) if (p.date < day && Number.isFinite(p.value) && (best === undefined || p.date > best.date)) best = p;
  if (best === undefined) return 0;
  return (basis === "yield" ? best.value : discountToYield(best.value)) / 100;
}

export interface WeightingRuleScheduleOptions {
  dateAxis: readonly string[];
  /** assetClassReturns of the member prices. */
  returns: ReadonlyMap<string, readonly number[]>;
  /** The class order of the return rows. */
  classes: readonly string[];
  /** A risk rule's rolling window and the fewest rows it solves on. */
  lookback: number;
  minObs: number;
  /** risk_budget: each class's share of the risk. */
  riskBudget: Readonly<Record<string, number>>;
  markowitz: MarkowitzParameters;
  /** The cash quotes (percent) Markowitz's excess returns subtract. */
  cashQuotes: readonly Point[];
  cashBasis?: CashBasis;
}

const SCHEDULE_OPTION_KEYS = ["dateAxis", "returns", "classes", "lookback", "minObs", "riskBudget", "markowitz", "cashQuotes", "cashBasis"];

/**
 * A rule's markowitzSchedule, re-optimised on the first axis day of each
 * month. A risk rule solves on the last `lookback` rows (at least `minObs`);
 * markowitz on every row before the solve (at least markowitz.minObs), its
 * expected returns the expected total returns less the yearly cash rate in
 * force on the solve day (yearlyCashRateBefore), with rf 0.
 */
export function weightingRuleSchedule(key: WeightingRuleKey, options: WeightingRuleScheduleOptions): MarkowitzScheduleResult {
  for (const k of Object.keys(options)) if (!SCHEDULE_OPTION_KEYS.includes(k)) throw new RangeError(`weightingRuleSchedule: unknown option ${JSON.stringify(k)}; expected ${SCHEDULE_OPTION_KEYS.join(", ")}`);
  if (!(WEIGHTING_RULE_KEYS as readonly string[]).includes(key)) throw new RangeError(`weightingRuleSchedule: unknown rule ${JSON.stringify(key)}; expected ${WEIGHTING_RULE_KEYS.join(", ")}`);
  const { dateAxis, returns, classes } = options;
  if (key === "markowitz") {
    const er = options.markowitz.expectedReturn;
    for (const c of classes) if (typeof er[c] !== "number") throw new RangeError(`weightingRuleSchedule: markowitz.expectedReturn has no ${JSON.stringify(c)}`);
    return markowitzSchedule({
      dateAxis,
      returns,
      assets: classes,
      rule: "tangency",
      minObs: options.markowitz.minObs,
      mu: (d) => {
        const y = yearlyCashRateBefore(options.cashQuotes, d, options.cashBasis);
        return classes.map((c) => er[c]! - y);
      },
    });
  }
  if (key === "risk_budget") for (const c of classes) if (typeof options.riskBudget[c] !== "number") throw new RangeError(`weightingRuleSchedule: riskBudget has no ${JSON.stringify(c)}`);
  const solve = riskSolver(key, classes, options.riskBudget);
  return markowitzSchedule({ dateAxis, returns, assets: classes, mu: () => classes.map(() => 0), lookback: options.lookback, minObs: options.minObs, solve: (_mu, S) => solve(S) });
}

/** Class weights by class, per axis day. */
export type ClassWeights = Readonly<Record<string, number>>;

/** Per axis day, the class weights of the solve in force: a solve dated d reads only the days before d, so it is in force from the axis day before d. */
export function classWeightsInForce(dateAxis: readonly string[], rebalances: readonly MarkowitzRebalance[], classes: readonly string[]): (ClassWeights | null)[] {
  let next = 0;
  let cur: ClassWeights | null = null;
  return dateAxis.map((_, i) => {
    const tomorrow = dateAxis[i + 1];
    while (next < rebalances.length && tomorrow !== undefined && rebalances[next]!.date <= tomorrow) {
      const w = rebalances[next++]!.weights;
      cur = Object.fromEntries(classes.map((c) => [c, w[c]!]));
    }
    return cur;
  });
}

/**
 * Each day's asset targets: the label's risk-on share times each class weight
 * times each member's share, the rest in cash. Null on a day with no class
 * weights or no label; a label with no risk-on share is a RangeError naming it
 * and its day.
 */
export function labelScaledTargets(
  classWeights: readonly (ClassWeights | null)[],
  labels: readonly (string | null)[],
  riskOnShare: Readonly<Record<string, number>>,
  assetClasses: AssetClasses,
): Schedule {
  if (classWeights.length !== labels.length) throw new RangeError(`labelScaledTargets: ${classWeights.length} class weight days for ${labels.length} label days`);
  return classWeights.map((cw, i) => {
    const label = labels[i];
    if (cw == null || label == null) return null;
    if (!Object.hasOwn(riskOnShare, label)) throw new RangeError(`labelScaledTargets: label ${JSON.stringify(label)} on day ${i} has no risk-on share`);
    const s = riskOnShare[label]!;
    const row: Weights = { cash: 1 - s };
    for (const [c, members] of Object.entries(assetClasses)) for (const [a, f] of Object.entries(members)) row[a] = s * (cw[c]! * f);
    return row;
  });
}

/** One rule's newest solve: its money shares, its risk shares under the covariance it solved on, and today's target by class (null with no label). */
export interface RuleShares {
  money: Record<string, number>;
  risk: Record<string, number>;
  target: Weights | null;
}

/** The figures Lex's optimizers page shows beside the curves, under his keys. */
export interface WeightingFigures {
  asof: string;
  /** the first day of the as-of month */
  rebalance_date: string;
  cost_bps: number;
  label_share: Readonly<Record<string, number>>;
  assets: string[];
  volatility_1y: Record<string, number>;
  /** shrunkCov of the last `lookback` class-return rows dated before rebalance_date */
  covariance_1y: number[][];
  /** shrunkCov of every class-return row dated before rebalance_date */
  covariance_full: number[][];
  expected_return: Readonly<Record<string, number>>;
  /** the yearly cash rate of the last quote dated before rebalance_date */
  cash_rate: number;
  engines: Record<WeightingRuleKey, RuleShares>;
}

/** The weighting rules' parameters (OPTIMIZERS_PRESET.weightingRules). */
export interface WeightingRuleParameters {
  assetClasses: AssetClasses;
  riskOnShare: Readonly<Record<string, number>>;
  lookback: number;
  minObs: number;
  riskBudget: Readonly<Record<string, number>>;
  markowitz: MarkowitzParameters;
}

export type PortfolioWeightingOptions = CurveGroupOptions & WeightingRuleParameters;

const WEIGHTING_OPTION_KEYS = ["trading", "sampling", "windows", "assetClasses", "riskOnShare", "lookback", "minObs", "riskBudget", "markowitz"];

export interface PortfolioWeighting {
  /** each rule's daily asset targets */
  targets: Record<WeightingRuleKey, Schedule>;
  figures: WeightingFigures;
  /** the six rules and the benchmarks stables_only, sp500_hodl and eth_hodl */
  curves: CurveGroup;
}

const byClass = (classes: readonly string[], v: readonly number[]): Record<string, number> => Object.fromEntries(classes.map((c, i) => [c, v[i]!]));

/**
 * The six weighting rules over the composite labels (carried forward from the
 * first label): their daily targets, their figures, and one group of equity
 * curves with the benchmarks stables_only, sp500_hodl and eth_hodl, each bought
 * on the earliest first day of the six rules and never traded. Every curve is
 * priced on every member asset, runs through simulateDrift under
 * options.trading (its cashBasis is the cash basis of the figures too) and
 * through evaluateEquityCurve under options.sampling and options.windows.
 */
export function computePortfolioWeighting(
  dateAxis: readonly string[],
  labels: readonly (string | null)[],
  prices: Readonly<Record<string, Point[]>>,
  cashQuotes: Point[],
  options: PortfolioWeightingOptions,
): PortfolioWeighting {
  if (options === null || typeof options !== "object") throw new RangeError("computePortfolioWeighting: options must be an object");
  for (const k of Object.keys(options)) if (!WEIGHTING_OPTION_KEYS.includes(k)) throw new RangeError(`computePortfolioWeighting: unknown option ${JSON.stringify(k)}; expected ${WEIGHTING_OPTION_KEYS.join(", ")}`);
  for (const k of ["assetClasses", "riskOnShare", "lookback", "minObs", "riskBudget", "markowitz"] as const) if (options[k] === undefined) throw new RangeError(`computePortfolioWeighting: option ${k} is required`);
  if (labels.length !== dateAxis.length) throw new RangeError(`computePortfolioWeighting: ${labels.length} labels for ${dateAxis.length} axis days`);
  const { assetClasses, riskOnShare, lookback } = options;
  const classes = Object.keys(assetClasses);
  const members = [...new Set(classes.flatMap((c) => Object.keys(assetClasses[c]!)))];
  const px = pricesOf("computePortfolioWeighting", prices, members);
  const trading = tradingFor(options.trading, members);
  const cashBasis = trading.cashBasis ?? "discount";
  const returns = assetClassReturns(px, assetClasses);
  const carried = carryForward(labels);
  const asof = dateAxis[dateAxis.length - 1]!;
  const rebalanceDate = `${asof.slice(0, 7)}-01`;
  const before = [...returns.keys()].filter((d) => d < rebalanceDate).sort();
  const rowsOf = (days: readonly string[]) => days.map((d) => [...returns.get(d)!]);
  const covariance1y = shrunkCov(rowsOf(before.slice(-lookback)));
  const covarianceFull = shrunkCov(rowsOf(before));
  const newestLabel = carried[carried.length - 1] ?? null;

  const targets = {} as Record<WeightingRuleKey, Schedule>;
  const engines = {} as Record<WeightingRuleKey, RuleShares>;
  for (const key of WEIGHTING_RULE_KEYS) {
    const { rebalances } = weightingRuleSchedule(key, {
      dateAxis, returns, classes, lookback, minObs: options.minObs, riskBudget: options.riskBudget, markowitz: options.markowitz, cashQuotes, cashBasis,
    });
    const last = rebalances[rebalances.length - 1];
    if (last === undefined) throw new RangeError(`computePortfolioWeighting: ${key} never solves (too few class-return rows)`);
    targets[key] = labelScaledTargets(classWeightsInForce(dateAxis, rebalances, classes), carried, riskOnShare, assetClasses);
    const w = classes.map((c) => last.weights[c]!);
    const s = newestLabel === null ? undefined : riskOnShare[newestLabel];
    engines[key] = {
      money: byClass(classes, w),
      risk: byClass(classes, riskContributions(key === "markowitz" ? covarianceFull : covariance1y, w)),
      target: s === undefined ? null : { cash: 1 - s, ...byClass(classes, w.map((x) => s * x)) },
    };
  }

  const evaluate = { trailingMonths: options.windows?.trailingMonths ?? [], ...(options.sampling === undefined ? {} : { sampling: options.sampling }) };
  const benchmark: DriftOptions = { ...trading, freq: "never" };
  const curve = (s: Schedule, kind: EquityCurveKind, o: DriftOptions) => evaluateEquityCurve(simulateDrift(dateAxis, s, px, cashQuotes, o), { kind, ...evaluate });
  const curves: CurveGroup = {};
  for (const key of WEIGHTING_RULE_KEYS) curves[key] = curve(targets[key], "strategy", trading);
  const firsts = WEIGHTING_RULE_KEYS.map((k) => targets[k].findIndex((w) => w != null)).filter((i) => i >= 0);
  if (firsts.length === 0) throw new RangeError("computePortfolioWeighting: no rule has a target");
  const from = Math.min(...firsts);
  const held = (w: Weights): Schedule => dateAxis.map((_, i) => (i < from ? null : w));
  curves.stables_only = curve(held({ cash: 1 }), "cash", benchmark);
  curves[PORTFOLIO_SPECS.sp500!.hodl.key] = curve(held(PORTFOLIO_SPECS.sp500!.hodl.weights), "buy_and_hold_benchmark", benchmark);
  curves[PORTFOLIO_SPECS.eth!.hodl.key] = curve(held(PORTFOLIO_SPECS.eth!.hodl.weights), "buy_and_hold_benchmark", benchmark);

  return {
    targets,
    figures: {
      asof,
      rebalance_date: rebalanceDate,
      cost_bps: typeof trading.costBps === "number" ? trading.costBps : 10,
      label_share: riskOnShare,
      assets: classes,
      volatility_1y: byClass(classes, covariance1y.map((row, i) => Math.sqrt(row[i]!))),
      covariance_1y: covariance1y,
      covariance_full: covarianceFull,
      expected_return: options.markowitz.expectedReturn,
      cash_rate: yearlyCashRateBefore(cashQuotes, rebalanceDate, cashBasis),
      engines,
    },
    curves,
  };
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const CRYPTO_RISK_BUDGET = 0.9;

/**
 * Every value the optimizers page computes with, for the backend and the
 * workbench alike (issue 1766), frozen at every depth. `trading` is the one
 * trading-rule set of every curve (the D94 default): per-asset execution at a
 * lag of one session of each asset, BTC and ETH continuous, the S&P 500 and
 * GLD observed, a monthly rebalance on each asset's own first open day, a day
 * with no target held, 10 basis points, and cash at the discount quote's
 * bond-equivalent yield. `labelStrategies.markets` names the PORTFOLIO_SPECS
 * markets, whose weight tables hold the label strategies' risk-on shares (read
 * there, never copied). Plain data.
 */
export const OPTIMIZERS_PRESET = deepFreeze({
  trading: {
    execution: "per-asset",
    lagCount: "asset-sessions",
    lagSessions: 1,
    calendars: { btc: "continuous", eth: "continuous", sp500: "observed", gld: "observed" },
    freq: "monthly",
    calendarDay: "asset-session",
    missingTarget: "hold",
    costBps: 10,
    cashBasis: "discount",
  } satisfies DriftOptions,
  sampling: { kind: "weekday", weekday: 5 } as const,
  labelStrategies: { markets: Object.keys(PORTFOLIO_SPECS) },
  weightingRules: {
    assetClasses: { crypto: { btc: 0.5, eth: 0.5 }, us_equities: { sp500: 1 }, gold: { gld: 1 } },
    riskOnShare: { risk_off: 0.05, neutral: 0.5, risk_on: 0.95 },
    lookback: 252,
    minObs: 126,
    riskBudget: { crypto: CRYPTO_RISK_BUDGET, us_equities: (1 - CRYPTO_RISK_BUDGET) / 2, gold: (1 - CRYPTO_RISK_BUDGET) / 2 },
    markowitz: { minObs: 252, expectedReturn: { crypto: 0.234, us_equities: 0.075, gold: 0.055 } },
  } satisfies WeightingRuleParameters,
  windows: { trailingMonths: [12, 36, 60], commonPeriodMonths: 60 },
});

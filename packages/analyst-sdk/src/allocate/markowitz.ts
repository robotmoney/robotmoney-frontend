// Markowitz sizing and the re-optimised Markowitz backtest (decision D78),
// built on the certified solvers (allocate/optimize.ts) and the shrunk
// covariance (allocate/covariance.ts). Ported from the general parts of
// rosemarys-baby src/computations/markowitz_today.ts (runWindow) and
// src/computations/backtest_markowitz.ts (pointInTimeWeights and its run loop);
// the research parts (bucket mapping, priors, report JSON) stay in the client.
//
//   - markowitzBooks: from daily return rows, the tangency book and one
//     mean-variance book per lambda, each with cash, expected return, volatility
//     and Sharpe ratio.
//   - markowitzSizing: the same from closes, on the dates every asset is priced.
//   - markowitzSchedule: point-in-time weights per axis date, re-optimised on a
//     calendar rule (monthly by default) from the history strictly before the
//     date, so a weight never sees a return dated on or after its own date.
//   - markowitzBacktest: the schedule run through a simulator (simulatePortfolio
//     by default) and periodStats over the simulation's own start and end.
//
// Every analysis is tunable: constants are options with today's defaults,
// strategy steps (expected returns, covariance, solver, expansion onto holdings,
// re-optimisation dates, simulator) are callbacks, and an unknown option key
// throws RangeError naming the key. Weights within the zero tolerance are
// reported as 0 (canonical zero). Every sum, dot product and quadratic form is
// compensated and rounded once.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
import type { Point } from "../types.ts";
import {
  periodStats, simulateDrift, simulatePortfolio,
  type BacktestMetrics, type DriftOptions, type Schedule, type SimulationResult, type Weights,
} from "../analyze/backtest.ts";
import { dot2, sum2 } from "../transform/exact.ts";
import { correlationMatrix, type Mat } from "../transform/linalg.ts";
import { PERIODS_PER_YEAR, SHRINK, shrunkCov } from "./covariance.ts";
import { meanVarExact, tangencyExact } from "./optimize.ts";

/** Default canonical-zero tolerance: |w| <= 1e-12 is reported as +0. */
export const ZERO_TOL = 1e-12;
/** Default minimum number of history rows before the schedule holds weights. */
export const MIN_OBS = 252;
/** Default risk aversion of the mean-variance rule. */
export const LAMBDA = 4;

/** Canonical zero: any |x| <= tol, including a rounding residue and -0, becomes +0. Otherwise unchanged. */
export const canonZero = (x: number, tol = ZERO_TOL): number => (Math.abs(x) <= tol ? 0 : x);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkKeys(where: string, options: object, allowed: readonly string[]): void {
  for (const k of Object.keys(options)) {
    if (!allowed.includes(k)) throw new RangeError(`${where}: unknown option ${JSON.stringify(k)}; expected ${allowed.join(", ")}`);
  }
}

const finite = (where: string, name: string, v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RangeError(`${where}: ${name} must be a finite number, got ${JSON.stringify(v)}`);
  return v;
};

const positive = (where: string, name: string, v: unknown): number => {
  const x = finite(where, name, v);
  if (!(x > 0)) throw new RangeError(`${where}: ${name} must be positive, got ${x}`);
  return x;
};

const nonNegative = (where: string, name: string, v: unknown): number => {
  const x = finite(where, name, v);
  if (x < 0) throw new RangeError(`${where}: ${name} must be nonnegative, got ${x}`);
  return x;
};

const countOption = (where: string, name: string, v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 2) throw new RangeError(`${where}: ${name} must be an integer of at least 2, got ${JSON.stringify(v)}`);
  return v;
};

const shrinkOption = (where: string, v: unknown): number => {
  const s = finite(where, "shrink", v);
  if (s < 0 || s > 1) throw new RangeError(`${where}: shrink must lie in [0, 1], got ${s}`);
  return s;
};

/** Expected returns per asset as a vector in `assets` order: a record keyed by asset id or an array. */
function muVector(where: string, mu: Readonly<Record<string, number>> | readonly number[], assets: readonly string[]): number[] {
  if (Array.isArray(mu)) {
    if (mu.length !== assets.length) throw new RangeError(`${where}: mu has ${mu.length} entries for ${assets.length} assets`);
    return mu.map((m, i) => finite(where, `mu for ${JSON.stringify(assets[i])}`, m));
  }
  const rec = mu as Readonly<Record<string, number>>;
  for (const k of Object.keys(rec)) if (!assets.includes(k)) throw new RangeError(`${where}: mu names ${JSON.stringify(k)}, which is not an asset`);
  return assets.map((a) => {
    if (!Object.hasOwn(rec, a)) throw new RangeError(`${where}: mu has no entry for ${JSON.stringify(a)}`);
    return finite(where, `mu for ${JSON.stringify(a)}`, rec[a]);
  });
}

// ------------------------------------------------------------------ books

/** One sized portfolio. */
export interface Book {
  /** Weight per asset id, canonical zero applied. */
  weights: Record<string, number>;
  /** 1 - sum of weights, compensated, canonical zero applied. */
  cash: number;
  /** Expected annual return: weights and cash dotted with mu and rf (one compensated dot product). */
  expReturn: number;
  /** Annual volatility: sqrt(w' S w), the quadratic form compensated. */
  vol: number;
  /** (expReturn - rf) / vol, the numerator as one compensated dot product; null when vol is 0. */
  sharpe: number | null;
}

export interface MarkowitzBooksInput {
  /** Daily return rows, days x assets (blended bucket returns are fine). */
  returns: Mat;
  /** Asset ids, one per column of `returns`. */
  assets: readonly string[];
  /** Risk-free rate, an annual fraction. */
  rf: number;
  /** Expected annual return per asset (fraction): a record keyed by asset id, or an array in `assets` order. */
  mu: Readonly<Record<string, number>> | readonly number[];
  /** Risk aversions; one mean-variance book per lambda, each positive. */
  lambdas: readonly number[];
  /** Shrinkage toward the diagonal. Default SHRINK (0.2). */
  shrink?: number;
  /** Periods per year for annualizing. Default 252. */
  periodsPerYear?: number;
  /** Canonical-zero tolerance. Default ZERO_TOL (1e-12). */
  zeroTol?: number;
}

export interface MarkowitzBooks {
  assets: string[];
  /** The optimizer's covariance: shrunkCov(returns, shrink, periodsPerYear). */
  cov: number[][];
  /** Annual volatility per asset: the square root of the covariance's (unshrunk) diagonal. */
  vols: number[];
  /** The long-only maximum-Sharpe book (fully invested). */
  tangency: Book;
  /** One long-only mean-variance book per lambda (the rest in cash), in the input order. */
  byLambda: { lambda: number; book: Book }[];
}

const BOOKS_KEYS = ["returns", "assets", "rf", "mu", "lambdas", "shrink", "periodsPerYear", "zeroTol"] as const;

function bookOf(assets: readonly string[], S: Mat, mu: readonly number[], rf: number, raw: readonly number[], tol: number): Book {
  const w = raw.map((x) => canonZero(x, tol));
  const cash = canonZero(sum2([1, ...w.map((x) => -x)]), tol); // exact residual of the budget, rounded once
  const expReturn = dot2([...w, cash], [...mu, rf]);
  const excess = dot2([...w, cash, -1], [...mu, rf, rf]); // expReturn - rf as one compensated dot, not two roundings
  const vol = Math.sqrt(dot2(w, S.map((row) => dot2(row, w))));
  return {
    weights: Object.fromEntries(assets.map((a, i) => [a, w[i]!])),
    cash,
    expReturn,
    vol,
    sharpe: vol > 0 ? excess / vol : null,
  };
}

/**
 * Markowitz books from daily return rows: S = shrunkCov(returns, shrink),
 * ex = mu - rf, the tangency book from tangencyExact and one mean-variance book
 * per lambda from meanVarExact. Throws RangeError on an unknown option, a
 * non-finite rf or mu, a lambda that is not positive and finite, or rows that
 * do not match the assets; the solvers throw UnsupportedError when no certified
 * optimum exists.
 */
export function markowitzBooks(input: MarkowitzBooksInput): MarkowitzBooks {
  const where = "markowitzBooks";
  checkKeys(where, input, BOOKS_KEYS);
  const { returns, assets } = input;
  if (!Array.isArray(assets) || assets.length === 0) throw new RangeError(`${where}: assets must be a nonempty list`);
  if (new Set(assets).size !== assets.length) throw new RangeError(`${where}: assets must be distinct`);
  if (!Array.isArray(returns) || returns.length < 2) throw new RangeError(`${where}: need at least two return rows, got ${Array.isArray(returns) ? returns.length : 0}`);
  returns.forEach((row, t) => {
    if (row.length !== assets.length) throw new RangeError(`${where}: return row ${t} has ${row.length} values for ${assets.length} assets`);
    row.forEach((v: number, j: number) => finite(where, `return row ${t} of ${JSON.stringify(assets[j])}`, v));
  });
  const rf = finite(where, "rf", input.rf);
  const mu = muVector(where, input.mu, assets);
  if (!Array.isArray(input.lambdas)) throw new RangeError(`${where}: lambdas must be a list`);
  const lambdas = input.lambdas.map((l, i) => positive(where, `lambda ${i}`, l));
  const shrink = input.shrink === undefined ? SHRINK : shrinkOption(where, input.shrink);
  const ppy = input.periodsPerYear === undefined ? PERIODS_PER_YEAR : positive(where, "periodsPerYear", input.periodsPerYear);
  const tol = input.zeroTol === undefined ? ZERO_TOL : nonNegative(where, "zeroTol", input.zeroTol);

  const S = shrunkCov(returns, shrink, ppy);
  const ex = mu.map((m) => m - rf);
  return {
    assets: [...assets],
    cov: S,
    vols: S.map((row, i) => Math.sqrt(row[i]!)),
    tangency: bookOf(assets, S, mu, rf, tangencyExact(S, ex), tol),
    byLambda: lambdas.map((lambda) => ({ lambda, book: bookOf(assets, S, mu, rf, meanVarExact(S, ex, lambda), tol) })),
  };
}

// ------------------------------------------------------------------ sizing from closes

export interface MarkowitzSizingInput {
  /** Closes per asset id. A date counts for an asset when its close is finite and positive. */
  closes: Readonly<Record<string, readonly Point[]>>;
  /** Expected annual return per asset (fraction), keyed by asset id; its keys are the assets, in key order. */
  mu: Readonly<Record<string, number>>;
  /** Risk-free rate, an annual fraction. */
  rf: number;
  /** Risk aversions, each positive. */
  lambdas: readonly number[];
  /** First date of the window (the first common date on or after it). Default: every date. */
  from?: string;
  /** Last date of the window (inclusive). Default: every date. */
  end?: string;
  shrink?: number;
  periodsPerYear?: number;
  zeroTol?: number;
}

export interface MarkowitzSizing extends MarkowitzBooks {
  /** The last common date. */
  asof: string;
  /** The first common date of the window. */
  from: string;
  /** Number of return rows. */
  nObs: number;
  /** Sample correlation matrix of the returns (correlationMatrix, unshrunk). */
  corr: number[][];
}

const SIZING_KEYS = ["closes", "mu", "rf", "lambdas", "from", "end", "shrink", "periodsPerYear", "zeroTol"] as const;

/**
 * Today's Markowitz sizing from closes: the dates on which every asset in `mu`
 * is priced, cut at `end`, starting at the first such date on or after `from`;
 * simple returns p1 / p0 - 1 between consecutive common dates; then
 * markowitzBooks. Throws RangeError when fewer than two common dates remain,
 * when an asset in mu is missing from closes, or when rf, mu or a lambda is
 * not finite (a lambda must be positive).
 */
export function markowitzSizing(input: MarkowitzSizingInput): MarkowitzSizing {
  const where = "markowitzSizing";
  checkKeys(where, input, SIZING_KEYS);
  const assets = Object.keys(input.mu ?? {});
  if (assets.length === 0) throw new RangeError(`${where}: mu names no asset`);
  for (const a of assets) if (!Object.hasOwn(input.closes, a)) throw new RangeError(`${where}: asset ${JSON.stringify(a)} in mu has no closes`);
  for (const [name, d] of [["from", input.from], ["end", input.end]] as const) {
    if (d !== undefined && (typeof d !== "string" || !ISO_DAY.test(d))) throw new RangeError(`${where}: ${name} must be a YYYY-MM-DD date, got ${JSON.stringify(d)}`);
  }
  const maps = assets.map((a) => {
    const m = new Map<string, number>();
    for (const p of input.closes[a]!) if (Number.isFinite(p.value) && p.value > 0) m.set(p.date, p.value);
    return m;
  });
  const days = [...maps[0]!.keys()]
    .filter((d) => maps.every((m) => m.has(d)) && (input.end === undefined || d <= input.end) && (input.from === undefined || d >= input.from))
    .sort();
  if (days.length < 2) throw new RangeError(`${where}: fewer than two common dates (${days.length}) in the window`);
  const returns: number[][] = [];
  for (let i = 1; i < days.length; i++) returns.push(maps.map((m) => m.get(days[i]!)! / m.get(days[i - 1]!)! - 1));
  const books = markowitzBooks({
    returns, assets, rf: input.rf, mu: input.mu, lambdas: input.lambdas,
    ...(input.shrink === undefined ? {} : { shrink: input.shrink }),
    ...(input.periodsPerYear === undefined ? {} : { periodsPerYear: input.periodsPerYear }),
    ...(input.zeroTol === undefined ? {} : { zeroTol: input.zeroTol }),
  });
  return {
    ...books,
    asof: days[days.length - 1]!,
    from: days[0]!,
    nObs: returns.length,
    corr: correlationMatrix(assets.map((_, j) => returns.map((r) => r[j]!))),
  };
}

// ------------------------------------------------------------------ point-in-time schedule

/** When the schedule re-optimises: a calendar frequency, or a predicate over the date and the previous axis date (null on the first). */
export type Reoptimise = "weekly" | "monthly" | "quarterly" | ((date: string, prevDate: string | null) => boolean);

/** Expected annual returns at a re-optimisation date from the history before it: a record keyed by asset id, or an array in asset order. */
export type MuFn = (date: string, history: number[][], historyDates: string[]) => Readonly<Record<string, number>> | readonly number[];
/** A covariance estimate from the history rows (days x assets). */
export type CovFn = (history: number[][]) => Mat;
/** Weights per asset (asset order) from mu, the covariance and rf (annual fraction); the rest is cash. */
export type SolveFn = (mu: number[], S: Mat, rf: number) => readonly number[];
/** Optimizer weights (cash plus one key per asset) to the day's holdings; null leaves that day unset. */
export type ExpandFn = (weights: Weights, date: string) => Weights | null;

export interface MarkowitzScheduleOptions {
  /** Ascending YYYY-MM-DD dates. */
  dateAxis: readonly string[];
  /** Daily return rows keyed by date, one value per asset in `assets` order. */
  returns: ReadonlyMap<string, readonly number[]>;
  /** Asset ids, one per return column. */
  assets: readonly string[];
  /** Cash yield points, annual percent (as simulatePortfolio). rf on a date is the last value on or before it / 100; 0 when none. */
  cashRate?: Point[];
  /** Expected returns callback, so a client keeps its own point-in-time priors. */
  mu: MuFn;
  /** The built-in rule when `solve` is absent: "meanVar" (meanVarExact at lambda, the rest cash) or "tangency" (tangencyExact, fully invested). Default "meanVar". */
  rule?: "meanVar" | "tangency";
  /** Any solver: ERC, risk budgets, minimum variance, inverse volatility, naive rules. Replaces `rule`. */
  solve?: SolveFn;
  /** Covariance estimate. Default shrunkCov(history, shrink, periodsPerYear). */
  cov?: CovFn;
  /** Rolling window: only the last `lookback` history rows. Default: expanding window. */
  lookback?: number;
  /** Re-optimisation dates. Default "monthly" (the first axis date of each calendar month). */
  reoptimise?: Reoptimise;
  /** Maps optimizer weights onto priced holdings per axis date. Default identity. */
  expand?: ExpandFn;
  /** History rows needed before the first weights. Default MIN_OBS (252). */
  minObs?: number;
  /** History starts at the first return dated on or after `from`. Default: every return. */
  from?: string;
  /** Shrinkage of the default covariance. Default SHRINK (0.2). */
  shrink?: number;
  /** Periods per year of the default covariance. Default 252. */
  periodsPerYear?: number;
  /** Risk aversion of the "meanVar" rule. Default LAMBDA (4). */
  lambda?: number;
  /** Canonical-zero tolerance of the solver weights and cash. Default ZERO_TOL (1e-12). */
  zeroTol?: number;
}

/** One re-optimisation that produced weights. */
export interface MarkowitzRebalance {
  date: string;
  /** rf used, an annual fraction. */
  rf: number;
  /** mu used, in asset order. */
  mu: number[];
  /** History rows used. */
  nObs: number;
  /** Optimizer weights: cash plus one key per asset (before `expand`). */
  weights: Weights;
}

export interface MarkowitzScheduleResult {
  /** Holdings per axis date (after `expand`); null before enough history or where `expand` returned null. */
  schedule: Schedule;
  rebalances: MarkowitzRebalance[];
}

const SCHEDULE_KEYS = [
  "dateAxis", "returns", "assets", "cashRate", "mu", "rule", "solve", "cov", "lookback", "reoptimise", "expand",
  "minObs", "from", "shrink", "periodsPerYear", "lambda", "zeroTol",
] as const;

/** First index in `sorted` with value > d (the count of entries <= d). */
function upperBound(sorted: readonly string[], d: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m]! <= d) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** First index in `sorted` with value >= d (the count of entries < d). */
function lowerBound(sorted: readonly string[], d: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m]! < d) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const DAY_MS = 86_400_000;
/** Days since 1970-01-01 of the Monday that starts the UTC week of a YYYY-MM-DD date. */
const weekStart = (iso: string): number => {
  const t = Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
  return t - ((new Date(t * DAY_MS).getUTCDay() + 6) % 7);
};
const quarterOf = (iso: string): string => `${iso.slice(0, 4)}Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3)}`;

function dueFn(where: string, r: Reoptimise): (date: string, prev: string | null) => boolean {
  if (typeof r === "function") return (d, p) => r(d, p) === true;
  switch (r) {
    case "weekly":
      return (d, p) => p === null || weekStart(d) !== weekStart(p);
    case "monthly":
      return (d, p) => p === null || d.slice(0, 7) !== p.slice(0, 7);
    case "quarterly":
      return (d, p) => p === null || quarterOf(d) !== quarterOf(p);
    default:
      throw new RangeError(`${where}: reoptimise must be "weekly", "monthly", "quarterly" or a function, got ${JSON.stringify(r)}`);
  }
}

/**
 * Point-in-time optimizer weights per axis date. On each re-optimisation date
 * (default: the first axis date of each calendar month, the first axis date
 * included) the history is the return rows dated on or after `from` and
 * strictly before the date (the last `lookback` of them when set). With fewer
 * than minObs rows the weights stay as they were (null at the start).
 * Otherwise rf is the last cashRate value on or before the date / 100, mu comes
 * from the `mu` callback, S from `cov`, and the weights from `solve` (default:
 * meanVarExact at lambda, or tangencyExact). Weights within zeroTol are 0; cash
 * is 1 - sum w, compensated. The weights hold until the next re-optimisation;
 * `expand(weights, date)` maps them onto that day's holdings. Throws RangeError
 * on an unknown option key or an invalid option, and when a solver returns
 * negative, non-finite or over-budget weights.
 */
export function markowitzSchedule(options: MarkowitzScheduleOptions): MarkowitzScheduleResult {
  return scheduleWith("markowitzSchedule", options, SCHEDULE_KEYS);
}

function scheduleWith(where: string, o: MarkowitzScheduleOptions, allowed: readonly string[]): MarkowitzScheduleResult {
  checkKeys(where, o, allowed);
  const { dateAxis, returns, assets } = o;
  if (!Array.isArray(dateAxis)) throw new RangeError(`${where}: dateAxis must be a list of dates`);
  for (let i = 0; i < dateAxis.length; i++) {
    if (!ISO_DAY.test(dateAxis[i]!) || (i > 0 && dateAxis[i]! <= dateAxis[i - 1]!)) throw new RangeError(`${where}: dateAxis must be ascending YYYY-MM-DD dates (index ${i})`);
  }
  if (!(returns instanceof Map)) throw new RangeError(`${where}: returns must be a Map of date to return row`);
  if (!Array.isArray(assets) || assets.length === 0 || new Set(assets).size !== assets.length) throw new RangeError(`${where}: assets must be a nonempty list of distinct ids`);
  if (typeof o.mu !== "function") throw new RangeError(`${where}: mu must be a function (date, history) => expected returns`);
  if (o.rule !== undefined && o.rule !== "meanVar" && o.rule !== "tangency") throw new RangeError(`${where}: rule must be "meanVar" or "tangency", got ${JSON.stringify(o.rule)}`);
  if (o.rule !== undefined && o.solve !== undefined) throw new RangeError(`${where}: give rule or solve, not both`);
  for (const name of ["solve", "cov", "expand"] as const) {
    if (o[name] !== undefined && typeof o[name] !== "function") throw new RangeError(`${where}: ${name} must be a function`);
  }
  if (o.from !== undefined && (typeof o.from !== "string" || !ISO_DAY.test(o.from))) throw new RangeError(`${where}: from must be a YYYY-MM-DD date, got ${JSON.stringify(o.from)}`);
  if (o.cov !== undefined && (o.shrink !== undefined || o.periodsPerYear !== undefined)) throw new RangeError(`${where}: shrink and periodsPerYear tune the default cov; give them or cov, not both`);
  if (o.solve !== undefined && o.lambda !== undefined) throw new RangeError(`${where}: lambda tunes the built-in rule; give it or solve, not both`);
  const minObs = o.minObs === undefined ? MIN_OBS : countOption(where, "minObs", o.minObs);
  const lookback = o.lookback === undefined ? undefined : countOption(where, "lookback", o.lookback);
  if (lookback !== undefined && lookback < minObs) throw new RangeError(`${where}: lookback ${lookback} is below minObs ${minObs}, so no date would have enough history`);
  const shrink = o.shrink === undefined ? SHRINK : shrinkOption(where, o.shrink);
  const ppy = o.periodsPerYear === undefined ? PERIODS_PER_YEAR : positive(where, "periodsPerYear", o.periodsPerYear);
  const lambda = o.lambda === undefined ? LAMBDA : positive(where, "lambda", o.lambda);
  const tol = o.zeroTol === undefined ? ZERO_TOL : nonNegative(where, "zeroTol", o.zeroTol);
  const due = dueFn(where, o.reoptimise ?? "monthly");
  const cov: CovFn = o.cov ?? ((h) => shrunkCov(h, shrink, ppy));
  const rule = o.rule ?? "meanVar";
  const solve: SolveFn =
    o.solve ?? (rule === "tangency" ? (mu, S, rf) => tangencyExact(S, mu.map((m) => m - rf)) : (mu, S, rf) => meanVarExact(S, mu.map((m) => m - rf), lambda));
  const expand: ExpandFn = o.expand ?? ((w) => w);

  const rdays = [...returns.keys()].filter((d) => o.from === undefined || d >= o.from).sort();
  for (const d of rdays) {
    const row = returns.get(d)!;
    if (!ISO_DAY.test(d)) throw new RangeError(`${where}: return date ${JSON.stringify(d)} is not YYYY-MM-DD`);
    if (row.length !== assets.length) throw new RangeError(`${where}: return row ${d} has ${row.length} values for ${assets.length} assets`);
    row.forEach((v: number, j: number) => finite(where, `return ${d} of ${JSON.stringify(assets[j])}`, v));
  }
  const cash = [...(o.cashRate ?? [])].filter((p) => Number.isFinite(p.value)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cashDays = cash.map((p) => p.date);
  const rfOn = (d: string): number => {
    const i = upperBound(cashDays, d);
    return i > 0 ? cash[i - 1]!.value / 100 : 0;
  };

  const schedule: Schedule = [];
  const rebalances: MarkowitzRebalance[] = [];
  let cur: Weights | null = null;
  let prev: string | null = null;
  for (const d of dateAxis) {
    if (due(d, prev)) {
      const end = lowerBound(rdays, d);
      const start = lookback === undefined ? 0 : Math.max(0, end - lookback);
      if (end - start >= minObs) {
        const historyDates = rdays.slice(start, end);
        const history = historyDates.map((x) => [...returns.get(x)!]);
        const rf = rfOn(d);
        const mu = muVector(`${where} ${d}`, o.mu(d, history.map((r) => [...r]), [...historyDates]), assets);
        const S = cov(history.map((r) => [...r]));
        const raw = solve([...mu], S, rf);
        cur = weightsOf(`${where} ${d}`, assets, raw, tol);
        rebalances.push({ date: d, rf, mu, nObs: history.length, weights: { ...cur } });
      }
    }
    schedule.push(cur === null ? null : expand({ ...cur }, d));
    prev = d;
  }
  return { schedule, rebalances };
}

/** Solver output to weights: canonical zero, nonnegative and finite, cash = 1 - sum w (compensated) not below 0. */
function weightsOf(where: string, assets: readonly string[], raw: readonly number[], tol: number): Weights {
  if (!Array.isArray(raw) || raw.length !== assets.length) throw new RangeError(`${where}: the solver returned ${Array.isArray(raw) ? raw.length : "no"} weights for ${assets.length} assets`);
  const w = raw.map((x, i) => {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new RangeError(`${where}: the solver weight for ${JSON.stringify(assets[i])} is ${x}`);
    const c = canonZero(x, tol);
    if (c < 0) throw new RangeError(`${where}: the solver weight for ${JSON.stringify(assets[i])} is negative (${x})`);
    return c;
  });
  const cash = canonZero(sum2([1, ...w.map((x) => -x)]), tol);
  if (cash < 0) throw new RangeError(`${where}: the solver weights sum above 1 (cash ${cash})`);
  const out: Weights = { cash };
  assets.forEach((a, i) => (out[a] = w[i]!));
  return out;
}

// ------------------------------------------------------------------ backtest

/** A simulator over the finished schedule. */
export type Simulator = (dateAxis: readonly string[], schedule: Schedule, prices: Record<string, Point[]>, cashRate: Point[]) => SimulationResult;

export interface MarkowitzBacktestOptions extends MarkowitzScheduleOptions {
  /** Prices per holding id, for the simulator. */
  prices: Record<string, Point[]>;
  /**
   * The simulator: simulatePortfolio by default; `{ drift: DriftOptions }` for
   * simulateDrift with those options; or any Simulator function.
   */
  simulate?: Simulator | { drift: DriftOptions };
  /** Trading cost in basis points of one-sided turnover. Default: the simulator's own default (10). Not with a Simulator function. */
  costBps?: number;
  /** In-sample end for periodStats. Default BACKTEST_IN_SAMPLE_END. */
  splitDate?: string;
}

export interface MarkowitzBacktestResult extends MarkowitzScheduleResult {
  simulation: SimulationResult;
  stats: BacktestMetrics;
}

const BACKTEST_KEYS = [...SCHEDULE_KEYS, "prices", "simulate", "costBps", "splitDate"] as const;

/**
 * The Markowitz backtest: markowitzSchedule, then the simulator over the
 * schedule (default simulatePortfolio(dateAxis, schedule, prices, cashRate,
 * { costBps })), then periodStats over the simulation's own startDate and
 * endDate. Neither the simulator nor periodStats is changed.
 */
export function markowitzBacktest(options: MarkowitzBacktestOptions): MarkowitzBacktestResult {
  const where = "markowitzBacktest";
  checkKeys(where, options, BACKTEST_KEYS);
  const { prices, simulate, costBps, splitDate, ...scheduleOptions } = options;
  if (prices === null || typeof prices !== "object") throw new RangeError(`${where}: prices must be a record of holding id to points`);
  if (costBps !== undefined) nonNegative(where, "costBps", costBps);
  const cost = costBps === undefined ? {} : { costBps };
  let sim: Simulator;
  if (simulate === undefined) {
    sim = (a, s, p, c) => simulatePortfolio(a, s, p, c, cost);
  } else if (typeof simulate === "function") {
    if (costBps !== undefined) throw new RangeError(`${where}: costBps does not reach a simulate function; set the cost inside it`);
    sim = simulate;
  } else if (simulate !== null && typeof simulate === "object" && Object.keys(simulate).length === 1 && "drift" in simulate) {
    const drift = simulate.drift;
    if (costBps !== undefined && drift.costBps !== undefined && drift.costBps !== costBps) throw new RangeError(`${where}: costBps ${costBps} and simulate.drift.costBps ${drift.costBps} disagree`);
    sim = (a, s, p, c) => simulateDrift(a, s, p, c, { ...cost, ...drift });
  } else {
    throw new RangeError(`${where}: simulate must be a function or { drift: DriftOptions }`);
  }
  const { schedule, rebalances } = scheduleWith(where, scheduleOptions, SCHEDULE_KEYS);
  const simulation = sim(scheduleOptions.dateAxis, schedule, prices, scheduleOptions.cashRate ?? []);
  const stats = periodStats(simulation.values, simulation.startDate, simulation.endDate, {
    returns: simulation.returns,
    trades: simulation.trades,
    ...(splitDate === undefined ? {} : { splitDate }),
  });
  return { schedule, rebalances, simulation, stats };
}

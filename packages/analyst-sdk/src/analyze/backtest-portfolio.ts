// A fixed-target portfolio backtest's inputs (issue 1404; moved out of
// bin/backtest.ts in issue 1765, so bin/ keeps argument parsing only): the
// portfolio and option checks, the cash-rate series names, the declared fill,
// the daily date axis, and the match of each holding to its price series.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
// `bun run backtest` (bin/backtest.ts) reads the portfolio and input files,
// runs the universe gate, calls these, then simulatePortfolio + periodStats
// (src/analyze/backtest.ts, analytics requirements section 5).
//
// The date axis is the plain calendar axis from `from` to `to`. It is not the
// regime axis: prepareRegimeInputs in src/prepare.ts is the only place that one
// is built (D59, scripts/tests/unit/regime-seam-guard.test.ts).
import type { Universe } from "../allocate/universe.ts";
import type { Point } from "../types.ts";
import type { DeclaredFill, SimulatorFill, Weights } from "./backtest.ts";

/** A portfolio: holding to weight in percent of NAV, summing to 100. `cash` is the cash leg. */
export type Portfolio = Record<string, number>;

/** A portfolio, option or holding the backtest refuses: a usage error (the command exits 2). */
export class PortfolioError extends RangeError {
  override readonly name = "PortfolioError";
}

/** The input series the cash leg earns, the first one the input holds: the 3-month T-bill rate (fred:DTB3). */
export const CASH_RATE_NAMES: readonly string[] = ["TBILL3M", "fred:DTB3", "backtest:DTB3"];

// Issue 1554: the fill policy the backtest command declares for every priced
// holding and for the cash rate. Forward with no age limit reproduces the former
// undeclared carry, so the output is unchanged. Research issue 1673 records
// any other choice.
export const BACKTEST_FILL: DeclaredFill = { kind: "forward", maxAgeDays: null, reason: "Reproduces the former command-line carry" };

/** True for a real calendar day written YYYY-MM-DD (2025-02-30 is not one). */
export const isDay = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Every calendar day from `from` to `to`, both included, as YYYY-MM-DD. */
export function dateAxis(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Check a parsed portfolio file: a JSON object of holding to a finite nonnegative percent, the percents summing to 100. */
export function checkPortfolio(data: unknown): Portfolio {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new PortfolioError("portfolio: expected a JSON object of holding to weight in percent");
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new PortfolioError(`portfolio: ${k} must be a finite nonnegative percent, got ${JSON.stringify(v)}`);
  }
  const portfolio = data as Portfolio;
  const sum = Object.values(portfolio).reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 100) > 1e-9) throw new PortfolioError(`portfolio: weights must sum to 100, got ${sum}`);
  return portfolio;
}

/** The backtest's option values as given on the command line. */
export interface BacktestOptionText {
  costBps?: string;
  from?: string;
  to?: string;
}

/** Check the option values: a nonnegative decimal cost in basis points, and `from` and `to` real YYYY-MM-DD days. Returns the cost as a number. */
export function checkBacktestOptions(o: BacktestOptionText): { costBps?: number } {
  let costBps: number | undefined;
  if (o.costBps !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(o.costBps)) throw new PortfolioError(`--cost-bps must be a nonnegative number, got ${JSON.stringify(o.costBps)}`);
    costBps = Number(o.costBps);
  }
  for (const [flag, v] of [["--from", o.from], ["--to", o.to]] as const) {
    if (v !== undefined && !isDay(v)) throw new PortfolioError(`${flag} must be a real YYYY-MM-DD date, got ${JSON.stringify(v)}`);
  }
  return costBps === undefined ? {} : { costBps };
}

/** A portfolio matched to its input series. */
export interface PortfolioSeries {
  /** Holding to weight as a fraction of NAV, cash included. */
  weights: Weights;
  /** Each holding but cash, to its price series. */
  prices: Record<string, Point[]>;
  /** The cash leg's rate: the first CASH_RATE_NAMES series the input holds, or empty (cash then earns zero). */
  cashRate: Point[];
}

/**
 * Match each holding to its price series in `history`. A universe asset is
 * priced from the asset's own series; any other holding (one let through the
 * universe gate) from the input series the holding itself names. A yield series
 * (defillama-yields) is not a price and is refused; a holding whose series the
 * input does not hold is an error, since a run never fetches.
 */
export function portfolioSeries(portfolio: Portfolio, universe: Universe, history: Readonly<Record<string, Point[]>>): PortfolioSeries {
  const byId = new Map(universe.assets.map((a) => [a.id, a]));
  const prices: Record<string, Point[]> = {};
  const weights: Weights = {};
  for (const [holding, pct] of Object.entries(portfolio)) {
    weights[holding] = pct / 100;
    if (holding === "cash") continue;
    const series = byId.get(holding)?.series ?? holding;
    if (series.startsWith("defillama-yields:")) throw new PortfolioError(`${holding} is priced by a yield series (${series}), not a price; this command backtests price series only`);
    const points = history[series];
    if (!points?.length) throw new Error(`missing input: ${holding} needs the price series ${series}, which the input does not hold (a run never fetches)`);
    prices[holding] = points;
  }
  const cashRate = CASH_RATE_NAMES.map((n) => history[n]).find((p) => p?.length) ?? [];
  return { weights, prices, cashRate };
}

/**
 * The backtest window and its date axis: `from` and `to` when given, otherwise
 * the first and last day any priced holding has. An all-cash portfolio has no
 * priced day, so it needs `from` and `to`.
 */
export function backtestAxis(prices: Readonly<Record<string, readonly Point[]>>, window: { from?: string; to?: string }): { from: string; to: string; axis: string[] } {
  const dates = Object.values(prices).flatMap((p) => p.map((x) => x.date)).sort();
  if (dates.length === 0 && !window.from) throw new PortfolioError("an all-cash portfolio needs --from and --to");
  const from = window.from ?? dates[0]!;
  const to = window.to ?? dates[dates.length - 1]!;
  if (from > to) throw new PortfolioError(`--from ${from} is after --to ${to}`);
  return { from, to, axis: dateAxis(from, to) };
}

/** The declared fill for the simulation: BACKTEST_FILL for the cash rate and for every priced holding. */
export function portfolioFill(holdings: Iterable<string>): SimulatorFill {
  const fill: SimulatorFill = { cash: BACKTEST_FILL };
  for (const holding of holdings) fill[holding] = BACKTEST_FILL;
  return fill;
}

// Drift-aware simulation (issue 1513; analytics requirements section 5.3):
// simulateDrift lets holdings drift between rebalances and rebalances on a
// target change, a calendar rule or an absolute band. Hand-computed fixtures fix
// the rules; the committed SPX/ETH/TBILL3M fixture fixes the arithmetic (every
// drifted weight is the correctly rounded BigInt-rational value) and the parity
// with simulatePortfolio at costBps 0 and freq daily.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  discountToYield,
  driftedWeight,
  forwardFillDaily,
  periodStats,
  PORTFOLIO_SPECS,
  scheduleFromLabels,
  simulateDrift as simulateDriftWithDefaults,
  simulatePortfolio as simulatePortfolioWithDefaults,
  type DriftOptions,
  type Schedule,
  type Weights,
} from "../src/analyze/backtest.ts";
import { ddDiv, ddValue, dotDD, periodicRate, twoSum } from "../src/transform/exact.ts";
import * as entry from "../src/index.ts";
import { parseRawHistory, runRegime as runRegimeOutcome, requireComplete, toHistory } from "../src/index.ts";
// Each run here scores a complete day (issue 1655): an IncompleteDay fails the test.
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));
import type { Point } from "../src/types.ts";
import { exactCompound, exactDot, onePlus, Q } from "./support/exact-reference.ts";
import { simulatorFillCases } from "./support/simulator-fill-cases.ts";

setDefaultTimeout(120_000);
const DIR = import.meta.dir;

// The drift cases test the book's own arithmetic: targets held from the same
// close, every market open (issue 1734 tests the lag and calendars in
// backtest.test.ts). Both wrappers pass the same defaults, so the bit-for-bit
// comparisons between the simulators still hold.
const sameClose = (p: Record<string, Point[]>) => ({ lagSessions: 0, calendars: Object.fromEntries(Object.keys(p).map((k) => [k, "continuous" as const])) });
// Issue 1766: every case below also runs with the four new options given at
// their defaults, and the two results must be equal, so each fixture of this
// suite pins the 0.9.0 result under both calls.
const EXPLICIT_DEFAULTS: DriftOptions = { lagCount: "axis-days", execution: "whole-book", calendarDay: "axis-day", missingTarget: "skip" };
let explicitDefaultRuns = 0;
const simulateDrift: typeof simulateDriftWithDefaults = (a, s, p, c, o = {}) => {
  const result = simulateDriftWithDefaults(a, s, p, c, { ...sameClose(p), ...o });
  expect(simulateDriftWithDefaults(a, s, p, c, { ...sameClose(p), ...EXPLICIT_DEFAULTS, ...o })).toEqual(result);
  explicitDefaultRuns++;
  return result;
};
const simulatePortfolio: typeof simulatePortfolioWithDefaults = (a, s, p, c, o = {}) => simulatePortfolioWithDefaults(a, s, p, c, { ...sameClose(p), ...o });
const raw = toHistory(parseRawHistory(readFileSync(join(DIR, "fixtures/raw-indicator-history.csv"), "utf8")));

const dayFrom = (start: string, i: number) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const axisBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let i = 0; dayFrom(from, i) <= to; i++) out.push(dayFrom(from, i));
  return out;
};
const pts = (axis: string[], vals: number[]): Point[] => vals.map((value, i) => ({ date: axis[i]!, value }));
const exact = (q: Q): number => q.toNumber();

// Five dates; a 50/50 cash and asset book; the asset doubles on day 1 and is flat after; no cash yield.
const AX = axisBetween("2024-01-01", "2024-01-05");
const HALF: Weights = { cash: 0.5, x: 0.5 };
const DOUBLES = { x: pts(AX, [1, 2, 2, 2, 2]) };
const run = (schedule: Schedule, options: DriftOptions) => simulateDrift(AX, schedule, DOUBLES, [], options);

describe("hand-computed fixtures", () => {
  test("freq never: values 1, 1.5, 1.5, ... and no trades", () => {
    const sim = run(AX.map(() => HALF), { freq: "never" });
    expect(sim.values.map((p) => p.value)).toEqual([1, 1.5, 1.5, 1.5, 1.5]);
    expect(sim.returns.map((p) => p.value)).toEqual([0.5, 0, 0, 0]);
    expect(sim.trades).toEqual([]);
    expect(sim.startDate).toBe(AX[0]!);
    expect(sim.endDate).toBe(AX[4]!);
  });

  test("freq daily: one trade on day 1, turnover 1/6, value 1.5 x (1 - turnover x costBps / 10000)", () => {
    for (const costBps of [10, 25]) {
      const sim = run(AX.map(() => HALF), { freq: "daily", costBps });
      expect(sim.trades.map((t) => t.date)).toEqual([AX[1]!]);
      const t = sim.trades[0]!.turnover;
      expect(Math.abs(t - 1 / 6)).toBeLessThanOrEqual(1e-15);
      expect(sim.trades[0]!.cost).toBe(t * (costBps / 10_000));
      // Held after day 1: x 2/3 and cash 1/3, each rounded once; the turnover is exact on those doubles.
      const xw = exact(Q.of(0.5).mul(new Q(2n)).div(Q.of(1.5)));
      const cw = exact(Q.of(0.5).div(Q.of(1.5)));
      expect(t).toBe(exact(Q.of(xw).sub(Q.of(0.5)).add(Q.of(0.5).sub(Q.of(cw))).div(new Q(2n))));
      const v1 = exact(Q.of(1.5).mul(new Q(1n).sub(Q.of(t).mul(Q.of(costBps / 10_000)))));
      expect(sim.values.map((p) => p.value)).toEqual([1, v1, v1, v1, v1]);
      // Pre-cost returns are unchanged by the cost.
      expect(sim.returns.map((p) => p.value)).toEqual([0.5, 0, 0, 0]);
    }
  });

  test("band thresholds under freq never: 0.2 gives no trade, 0.1 exactly one trade on day 1", () => {
    expect(run(AX.map(() => HALF), { freq: "never", band: 0.2 }).trades).toEqual([]);
    const tight = run(AX.map(() => HALF), { freq: "never", band: 0.1 });
    expect(tight.trades.map((t) => t.date)).toEqual([AX[1]!]);
    expect(Math.abs(tight.trades[0]!.turnover - 1 / 6)).toBeLessThanOrEqual(1e-15);
  });

  test("a target change on a later date rebalances under freq never, at the drifted weights' turnover", () => {
    const other: Weights = { cash: 0.2, x: 0.8 };
    const sim = run(AX.map((_, i) => (i < 3 ? HALF : other)), { freq: "never", costBps: 10 });
    expect(sim.trades.map((t) => t.date)).toEqual([AX[3]!]);
    // Held before the change: x 2/3, cash 1/3 (drifted on day 1, flat since); turnover |0.8 - 2/3| = 2/15.
    expect(Math.abs(sim.trades[0]!.turnover - 2 / 15)).toBeLessThanOrEqual(1e-15);
    // An unchanged target never trades again; the new target holds.
    expect(sim.values.slice(3).every((p) => p.value === sim.values[3]!.value)).toBe(true);
  });

  test("a rebalance with turnover at most 1e-9 records no trade and leaves equity unchanged", () => {
    const tiny = { x: pts(AX, [1, 1 + 1e-12, 1 + 2e-12, 1 + 3e-12, 1 + 4e-12]) };
    const paid = simulateDrift(AX, AX.map(() => HALF), tiny, [], { freq: "daily", costBps: 10_000 });
    const free = simulateDrift(AX, AX.map(() => HALF), tiny, [], { freq: "daily", costBps: 0 });
    expect(paid.trades).toEqual([]);
    expect(paid.values).toEqual(free.values);
    expect(paid.values.at(-1)!.value).toBeGreaterThan(1);
  });

  test("the first active date never trades and publishes value 1; null dates are skipped with their market move", () => {
    const sched: Schedule = AX.map((_, i) => (i === 0 ? null : { cash: 0, x: 1 }));
    const sim = run(sched, { freq: "daily", costBps: 10 });
    expect(sim.startDate).toBe(AX[1]!);
    expect(sim.values[0]).toEqual({ date: AX[1]!, value: 1 });
    expect(sim.trades).toEqual([]);
    // The doubling on day 1 happened before the first active date: not earned.
    expect(sim.values.map((p) => p.value)).toEqual([1, 1, 1, 1]);
  });
});

describe("calendar rules over 2024-01-29..2024-04-02", () => {
  const axis = axisBetween("2024-01-29", "2024-04-02");
  const drifting = { x: pts(axis, axis.map((_, i) => 1.01 ** i)) };
  const sched = axis.map(() => HALF);
  const tradeDates = (freq: DriftOptions["freq"]) => simulateDrift(axis, sched, drifting, [], { freq }).trades.map((t) => t.date);

  test("monthly trades fall exactly on the first day of each new month", () => {
    expect(tradeDates("monthly")).toEqual(["2024-02-01", "2024-03-01", "2024-04-01"]);
  });

  test("weekly trades fall exactly on the Monday after each week wraps", () => {
    const mondays = axis.filter((d) => d > axis[0]! && new Date(`${d}T00:00:00Z`).getUTCDay() === 1);
    expect(mondays.slice(0, 2)).toEqual(["2024-02-05", "2024-02-12"]);
    expect(tradeDates("weekly")).toEqual(mondays);
  });

  test("quarterly trades fall only on 2024-04-01; never trades never; daily trades on every later date", () => {
    expect(tradeDates("quarterly")).toEqual(["2024-04-01"]);
    expect(tradeDates("never")).toEqual([]);
    expect(tradeDates("daily")).toEqual(axis.slice(1));
    for (const f of ["daily", "weekly", "monthly", "quarterly", "never"] as const) expect(tradeDates(f)).not.toContain(axis[0]!);
  });

  test("the calendar rule is judged against the previous axis date on a sparse axis", () => {
    // Weekdays only: a Friday to Monday step wraps the week; a 2024-03-29 to 2024-04-01 step changes the quarter.
    const weekdays = axis.filter((d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; });
    const prices = { x: pts(weekdays, weekdays.map((_, i) => 1.01 ** i)) };
    const sim = (freq: DriftOptions["freq"]) => simulateDrift(weekdays, weekdays.map(() => HALF), prices, [], { freq }).trades.map((t) => t.date);
    expect(sim("weekly")).toEqual(weekdays.filter((d) => d > weekdays[0]! && new Date(`${d}T00:00:00Z`).getUTCDay() === 1));
    expect(sim("quarterly")).toEqual(["2024-04-01"]);
  });
});

describe("missing prices and zero equity", () => {
  const ax = axisBetween("2024-01-01", "2024-01-04");
  const target: Weights = { cash: 0.4, a: 0.2, b: 0.4 };
  test("a previous price that is NaN, 0 or negative gives that asset a zero return while other assets move", () => {
    for (const bad of [NaN, 0, -1]) {
      const prices = { a: pts(ax, [1, bad, 5, 5]), b: pts(ax, [1, 1, 1.1, 1.1]) };
      const sim = simulateDrift(ax, ax.map(() => target), prices, [], { freq: "daily", costBps: 0 });
      // Day 2: a's previous price is bad, so a earns 0; b earns 1.1 / 1 - 1 on its 0.4.
      expect(sim.returns[1]!.value).toBe(exactDot([0.4, 0.4], [0, 1.1 / 1 - 1]));
      expect(sim.returns[1]!.value).toBeGreaterThan(0);
    }
  });

  test("a day where 1 + r_p is not positive throws RangeError naming the date", () => {
    const prices = { a: pts(ax, [1, 1, 0, 0]) };
    const call = () => simulateDrift(ax, ax.map(() => ({ a: 1 })), prices, [], { freq: "never" });
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/2024-01-03/);
    const neg = { a: pts(ax, [1, -1, -1, -1]) };
    expect(() => simulateDrift(ax, ax.map(() => ({ a: 1 })), neg, [], {})).toThrow(/2024-01-02/);
  });
});

describe("committed SPX/ETH/TBILL3M fixture", () => {
  const spx = raw.SPX!;
  const eth = raw.ETH!;
  const tbill = raw.TBILL3M!;
  const axis = [...new Set([...spx, ...eth].map((p) => p.date))].sort();
  const prices = { spx, eth };

  test("every drifted weight is the correctly rounded rational w (1 + r_k) / (1 + r_p); the [w*hi, w*lo] form misses it", () => {
    const target: Weights = { cash: 0.2, spx: 0.4, eth: 0.4 };
    const sim = simulateDrift(axis, axis.map(() => target), prices, tbill, { freq: "never" });
    expect(sim.trades).toEqual([]);
    // Replay the book outside the SDK: the same terms in the same order give the SDK's returns bit for bit,
    // so the weights replayed are the weights the SDK held.
    const series = { spx: forwardFillDaily(spx, axis), eth: forwardFillDaily(eth, axis) };
    const tb = forwardFillDaily(tbill, axis).map((v) => (Number.isFinite(v) ? v : 0));
    const first = axis.findIndex((d) => d === sim.startDate);
    let held: Record<string, number> = { ...target };
    let updates = 0;
    let shortcutMisses = 0;
    for (let i = first + 1; i < axis.length; i++) {
      const rs: Record<string, number> = { cash: periodicRate(discountToYield(tb[i - 1] || 0) / 100, 365) };
      for (const k of ["spx", "eth"] as const) {
        const p0 = series[k][i - 1]!;
        const p1 = series[k][i]!;
        rs[k] = Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0 ? p1 / p0 - 1 : 0;
      }
      const keys = Object.keys(held);
      const rp = ddValue(dotDD(keys.map((k) => held[k]!), keys.map((k) => rs[k]!)));
      expect(sim.returns[i - first - 1]).toEqual({ date: axis[i]!, value: rp });
      const next: Record<string, number> = {};
      for (const k of keys) {
        const w = held[k]!;
        const want = exact(Q.of(w).mul(onePlus(rs[k]!)).div(onePlus(rp)));
        const got = driftedWeight(w, rs[k]!, rp);
        if (got !== want) throw new Error(`${axis[i]} ${k}: drifted ${got}, exact ${want}`);
        const [hi, lo] = twoSum(1, rs[k]!);
        if (ddValue(ddDiv([w * hi, w * lo], twoSum(1, rp))) !== want) shortcutMisses++;
        next[k] = got;
        updates++;
      }
      held = next;
    }
    expect(updates).toBeGreaterThan(3000);
    expect(shortcutMisses).toBeGreaterThan(0);
  });

  test("costBps 0 and freq daily: values and returns equal simulatePortfolio bit for bit on a regime schedule", () => {
    const r = runRegime(raw);
    const extras = { eth: raw.ETH!, sp500: raw.SPX! };
    for (const spec of [PORTFOLIO_SPECS.mixed!, PORTFOLIO_SPECS.eth!]) {
      const sched = scheduleFromLabels(r.result.regime, spec.weights);
      const p: Record<string, Point[]> = {};
      for (const a of spec.risky) p[a] = extras[a as keyof typeof extras];
      const ref = simulatePortfolio(r.dateAxis, sched, p, tbill, { costBps: 0 });
      const got = simulateDrift(r.dateAxis, sched, p, tbill, { costBps: 0, freq: "daily" });
      expect(ref.returns.length).toBeGreaterThan(500);
      expect(ref.trades.length).toBeGreaterThan(3);
      expect(got.values).toEqual(ref.values);
      expect(got.returns).toEqual(ref.returns);
      expect(got.startDate).toBe(ref.startDate);
      expect(got.endDate).toBe(ref.endDate);
      for (let j = 0; j < ref.values.length; j++) if (!Object.is(got.values[j]!.value, ref.values[j]!.value)) throw new Error(`value ${j}`);
    }
  });

  test("periodStats accepts a simulateDrift result: transitions equal trades and statistics are finite", () => {
    const sim = simulateDrift(axis, axis.map(() => ({ cash: 0.2, spx: 0.4, eth: 0.4 })), prices, tbill, { costBps: 10, freq: "monthly" });
    expect(sim.trades.length).toBeGreaterThan(12);
    const st = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
    expect(st.transitions).toBe(sim.trades.length);
    for (const v of [st.final_value, st.cagr, st.sharpe, st.max_drawdown]) expect(Number.isFinite(v)).toBe(true);
    expect(st.n_days).toBe(sim.returns.length);
  });
});

describe("options and inputs", () => {
  const sched = AX.map(() => HALF);
  test("unknown keys, bad costBps, an unknown freq and a bad band each throw RangeError naming the field", () => {
    const bad = (o: unknown, field: RegExp) => {
      const call = () => simulateDrift(AX, sched, DOUBLES, [], o as DriftOptions);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(field);
    };
    bad({ costbps: 10 }, /costbps/);
    bad({ freq: "daily", cadence: "weekly" }, /cadence/);
    bad({ costBps: -1 }, /costBps/);
    bad({ costBps: NaN }, /costBps/);
    bad({ costBps: Infinity }, /costBps/);
    bad({ costBps: "10" }, /costBps/);
    bad({ freq: "hourly" }, /freq/);
    bad({ freq: "Monthly" }, /freq/);
    bad({ band: -0.1 }, /band/);
    bad({ band: NaN }, /band/);
    bad({ band: Infinity }, /band/);
  });

  test("inputs are validated as simulatePortfolio validates them", () => {
    const both = (args: Parameters<typeof simulateDrift>) => {
      expect(() => simulatePortfolio(args[0], args[1], args[2], args[3])).toThrow(RangeError);
      expect(() => simulateDrift(...args)).toThrow(RangeError);
    };
    both([[], [], DOUBLES, [], {}]);
    both([["2024-01-02", "2024-01-01"], [HALF, HALF], DOUBLES, [], {}]);
    both([AX, sched.slice(1), DOUBLES, [], {}]);
    both([AX, AX.map(() => ({ cash: 0.5, x: 0.6 })), DOUBLES, [], {}]);
    both([AX, AX.map(() => ({ cash: 0.5, y: 0.5 })), DOUBLES, [], {}]);
    both([AX, AX.map(() => ({ cash: 1.5, x: -0.5 })), DOUBLES, [], {}]);
    both([AX, sched, { x: [] }, [], {}]);
  });

  test("defaults: costBps 10 and freq daily", () => {
    const def = simulateDrift(AX, sched, DOUBLES, []);
    expect(def).toEqual(simulateDrift(AX, sched, DOUBLES, [], { costBps: 10, freq: "daily" }));
    expect(def.trades[0]!.cost).toBe(def.trades[0]!.turnover * 0.001);
  });

  test("simulateDrift, periodStats and the drift types are exported from the package entry", () => {
    expect(entry.simulateDrift).toBe(simulateDriftWithDefaults);
    expect(entry.periodStats).toBe(periodStats);
    const opts: entry.DriftOptions = { freq: "weekly" as entry.RebalanceFrequency };
    expect(entry.simulateDrift(AX, sched, DOUBLES, [], { ...sameClose(DOUBLES), ...opts }).values.length).toBe(5);
  });
});

// Issue 1751, gap 1: the cash basis of the drifting book.
describe("cash basis (issue 1751)", () => {
  const axis = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
  const q = 5.25;
  const tbill = axis.map((date) => ({ date, value: q }));
  const allCash: Schedule = axis.map(() => ({ cash: 1 }));
  const compound = (r: number) => exactCompound(axis.slice(1).map(() => r));
  const asYield = periodicRate(q / 100, 365);
  const asDiscount = periodicRate(discountToYield(q) / 100, 365);

  test("cashBasis yield compounds the quote as a yearly yield; discount and no option convert it first, as 0.8.0", () => {
    expect(asYield).not.toBe(asDiscount);
    // Held from the same close, so the book earns cash on every later axis day.
    const run = (o?: DriftOptions) => simulateDriftWithDefaults(axis, allCash, {}, tbill, { lagSessions: 0, ...o });
    const end = (o?: DriftOptions) => run(o).values.at(-1)!.value;
    expect(end({ cashBasis: "yield" })).toBe(compound(asYield));
    expect(end({ cashBasis: "yield" })).toBeCloseTo((1 + asYield) ** (axis.length - 1), 14);
    expect(end({ cashBasis: "discount" })).toBe(compound(asDiscount));
    expect(end()).toBe(compound(asDiscount));
    expect(run({ cashBasis: "discount" })).toEqual(run());
    // Both simulators read the basis alike.
    expect(run({ cashBasis: "yield" }).values).toEqual(simulatePortfolioWithDefaults(axis, allCash, {}, tbill, { lagSessions: 0, cashBasis: "yield" }).values);
  });

  test("a cashBasis outside discount and yield, and an unknown option key, are RangeErrors naming them", () => {
    const bad = (o: unknown, field: RegExp) => {
      const call = () => simulateDriftWithDefaults(axis, allCash, {}, tbill, o as DriftOptions);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(field);
    };
    bad({ cashBasis: "other" }, /cashBasis/);
    bad({ cashbasis: "yield" }, /cashbasis/);
  });
});

// Issue 1554: simulateDrift reads its series under the same declared fill
// policies as simulatePortfolio.
simulatorFillCases("simulateDrift", simulateDrift);

// Issue 1766: per-asset trading. lagCount, execution, calendarDay and
// missingTarget default to the 0.9.0 behaviour.
describe("per-asset trading (issue 1766)", () => {
  test("every case above ran a second time with the four options given at their defaults, and equalled the first", () => {
    expect(explicitDefaultRuns).toBeGreaterThan(20);
  });

  test("the committed SPX/ETH/TBILL3M fixture under lag 1 and the reference calendars equals itself with the defaults given", () => {
    const r = runRegime(raw);
    const sched = scheduleFromLabels(r.result.regime, PORTFOLIO_SPECS.mixed!.weights);
    const p = { eth: raw.ETH!, sp500: raw.SPX! };
    for (const freq of ["daily", "monthly", "never"] as const) {
      const o: DriftOptions = { freq, calendars: { eth: "continuous", sp500: "observed" } };
      const implicit = simulateDriftWithDefaults(r.dateAxis, sched, p, raw.TBILL3M!, o);
      expect(implicit.trades.length).toBeGreaterThan(3);
      expect(simulateDriftWithDefaults(r.dateAxis, sched, p, raw.TBILL3M!, { ...o, ...EXPLICIT_DEFAULTS })).toEqual(implicit);
    }
  });

  test("lag 0, every market continuous, calendarDay axis-day and missingTarget skip: per-asset equals whole-book exactly", () => {
    // A target change, two month boundaries, a cash-only stretch and a day with no target.
    const axis = axisBetween("2024-01-20", "2024-03-10");
    const x = pts(axis, axis.map((_, i) => 100 * (1 + 0.013 * Math.sin(i * 0.7)) * (1 + i * 0.002)));
    const y = pts(axis, axis.map((_, i) => 50 * (1 + 0.021 * Math.cos(i * 1.3)) * (1 - i * 0.001)));
    const tbill = pts(axis, axis.map((_, i) => 4 + 0.01 * i));
    const A: Weights = { cash: 0.2, x: 0.5, y: 0.3 };
    const B: Weights = { cash: 0.1, x: 0.3, y: 0.6 };
    const sched: Schedule = axis.map((d, i) => (i < 2 ? null : d === "2024-02-07" ? null : d >= "2024-02-20" && d < "2024-02-26" ? { cash: 1 } : i < 15 ? A : B));
    const prices = { x, y };
    const calendars = { x: "continuous", y: "continuous" } as const;
    for (const freq of ["monthly", "daily", "weekly", "never"] as const) {
      const base: DriftOptions = { lagSessions: 0, calendars, freq, costBps: 10 };
      const whole = simulateDriftWithDefaults(axis, sched, prices, tbill, base);
      const per = simulateDriftWithDefaults(axis, sched, prices, tbill, { ...base, execution: "per-asset", lagCount: "asset-sessions", calendarDay: "axis-day", missingTarget: "skip" });
      expect(per.values).toEqual(whole.values);
      expect(per.returns).toEqual(whole.returns);
      expect(per.excess).toEqual(whole.excess);
      expect(per.trades).toEqual(whole.trades);
      expect(per).toEqual(whole);
      expect(whole.trades.length).toBeGreaterThan(2);
      expect(whole.values.some((p) => p.date === "2024-02-07")).toBe(false);
    }
  });

  // The hand fixtures: ETH trades every day; the S&P 500 only on the days it
  // has a close (none on weekends, none on Monday 2024-07-01). Cash earns 0.
  // Every expected value is written out below in plain arithmetic.
  const rel = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-14 * Math.abs(want));
  const COST = 10 / 10_000;
  const series = (rows: Record<string, number>): Point[] => Object.entries(rows).map(([date, value]) => ({ date, value }));
  const PER_ASSET: DriftOptions = { execution: "per-asset", lagCount: "asset-sessions", lagSessions: 1, calendars: { eth: "continuous", sp500: "observed" }, freq: "never", costBps: 10 };

  test("a target set on a Friday trades ETH on Saturday and the S&P 500 on Monday; the S&P 500 trades back to its target though only ETH's and cash's weights changed", () => {
    const axis = axisBetween("2024-06-19", "2024-06-25");
    const eth = series({ "2024-06-19": 100, "2024-06-20": 100, "2024-06-21": 100, "2024-06-22": 110, "2024-06-23": 110, "2024-06-24": 110, "2024-06-25": 110 });
    const sp500 = series({ "2024-06-19": 100, "2024-06-20": 100, "2024-06-21": 100, "2024-06-24": 120, "2024-06-25": 120 });
    const T1: Weights = { cash: 0.5, eth: 0.25, sp500: 0.25 };
    const T2: Weights = { cash: 0.3, eth: 0.45, sp500: 0.25 };
    const sched: Schedule = axis.map((d) => (d < "2024-06-21" ? T1 : T2));
    const sim = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], PER_ASSET);
    // Starts Thursday holding Wednesday's target; Friday's T2 waits a session of each asset.
    expect(sim.startDate).toBe("2024-06-20");
    expect(sim.trades.map((t) => t.date)).toEqual(["2024-06-22", "2024-06-24"]);
    // Saturday: ETH +10%, then ETH buys up to 0.45 from cash.
    const r1 = 0.25 * 0.1;
    const eth1 = (0.25 * 1.1) / (1 + r1);
    const sp1 = 0.25 / (1 + r1);
    const cash1 = 0.5 / (1 + r1);
    const t1 = 0.45 - eth1; // one-sided: ETH up, cash down by the same amount
    rel(sim.trades[0]!.turnover, t1);
    const v1 = (1 + r1) * (1 - t1 * COST);
    // Monday: the S&P 500 +20% on the weights after Saturday's trade (cash1 - t1 in cash), then it sells back to 0.25.
    expect(cash1 - t1).toBeGreaterThan(0);
    const r2 = sp1 * 0.2;
    const sp2 = (sp1 * 1.2) / (1 + r2);
    const t2 = sp2 - 0.25;
    rel(sim.trades[1]!.turnover, t2);
    const v2 = v1 * (1 + r2) * (1 - t2 * COST);
    expect(sim.values.map((p) => p.date)).toEqual(axis.slice(1));
    rel(sim.values[1]!.value, 1);
    rel(sim.values[2]!.value, v1);
    rel(sim.values[3]!.value, v1);
    rel(sim.values[4]!.value, v2);
    rel(sim.values[5]!.value, v2);
    rel(sim.returns[1]!.value, r1);
    rel(sim.returns[3]!.value, r2);
  });

  test("under calendarDay asset-session the monthly rebalance falls on ETH's 1st and on the S&P 500's first open day, the 2nd", () => {
    const axis = axisBetween("2024-06-27", "2024-07-03");
    const eth = series({ "2024-06-27": 100, "2024-06-28": 100, "2024-06-29": 100, "2024-06-30": 100, "2024-07-01": 120, "2024-07-02": 120, "2024-07-03": 120 });
    const sp500 = series({ "2024-06-27": 100, "2024-06-28": 100, "2024-07-02": 100, "2024-07-03": 100 });
    const T: Weights = { cash: 0.5, eth: 0.25, sp500: 0.25 };
    const sched: Schedule = axis.map(() => T);
    const sim = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], { ...PER_ASSET, freq: "monthly", calendarDay: "asset-session" });
    expect(sim.startDate).toBe("2024-06-28");
    expect(sim.trades.map((t) => t.date)).toEqual(["2024-07-01", "2024-07-02"]);
    const r = 0.25 * 0.2;
    const eth1 = 0.3 / (1 + r);
    const sp1 = 0.25 / (1 + r);
    const t1 = eth1 - 0.25; // ETH sells back to 0.25
    rel(sim.trades[0]!.turnover, t1);
    const t2 = 0.25 - sp1; // the S&P 500 buys back to 0.25 a day later
    rel(sim.trades[1]!.turnover, t2);
    const v = (1 + r) * (1 - t1 * COST) * (1 - t2 * COST);
    rel(sim.values.at(-1)!.value, v);
    // Under calendarDay axis-day the 1st is due for both, and the S&P 500, closed then, does not trade.
    const axisDay = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], { ...PER_ASSET, freq: "monthly", calendarDay: "axis-day" });
    expect(axisDay.trades.map((t) => t.date)).toEqual(["2024-07-01"]);
  });

  test("a purchase larger than the cash on hand fills pro rata, cash ends at 0, the order stays open, and the next day every open asset trades back to its target", () => {
    const axis = axisBetween("2024-06-20", "2024-06-25");
    const eth = series({ "2024-06-20": 100, "2024-06-21": 100, "2024-06-22": 100, "2024-06-23": 125, "2024-06-24": 125, "2024-06-25": 125 });
    const sp500 = series({ "2024-06-20": 100, "2024-06-21": 100, "2024-06-24": 100, "2024-06-25": 100 });
    const T1: Weights = { cash: 0.5, eth: 0.25, sp500: 0.25 };
    const T2: Weights = { cash: 0, eth: 0.5, sp500: 0.5 };
    const sched: Schedule = axis.map((d) => (d < "2024-06-21" ? T1 : T2));
    const sim = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], PER_ASSET);
    expect(sim.startDate).toBe("2024-06-21");
    expect(sim.trades.map((t) => t.date)).toEqual(["2024-06-22", "2024-06-24", "2024-06-25"]);
    // Saturday: ETH buys 0.25 from cash 0.5 in full.
    rel(sim.trades[0]!.turnover, 0.25);
    // Sunday: ETH +25% on 0.5.
    const r = 0.5 * 0.25;
    const eth1 = 0.625 / (1 + r);
    const cash1 = 0.25 / (1 + r);
    const sp1 = 0.25 / (1 + r);
    // Monday: the S&P 500 wants 0.5 - sp1 but cash1 is all there is: it buys cash1, cash ends at 0.
    expect(0.5 - sp1).toBeGreaterThan(cash1);
    rel(sim.trades[1]!.turnover, cash1);
    // Tuesday: the order is open, so ETH (no change of its own) sells back to 0.5 and funds the purchase in full.
    const t3 = eth1 - 0.5;
    rel(sim.trades[2]!.turnover, t3); // cash stays 0: the one-sided turnover is ETH's sale alone
    const v = (1 - 0.25 * COST) * (1 + r) * (1 - cash1 * COST) * (1 - t3 * COST);
    rel(sim.values.at(-1)!.value, v);
    // The book is T2 itself after Tuesday: a further day of returns earns exactly T2's mix.
    const longer = [...axis, "2024-06-26"];
    const eth26 = [...eth, { date: "2024-06-26", value: 150 }];
    const sp26 = [...sp500, { date: "2024-06-26", value: 110 }];
    const sim2 = simulateDriftWithDefaults(longer, [...sched, T2], { eth: eth26, sp500: sp26 }, [], PER_ASSET);
    rel(sim2.returns.at(-1)!.value, 0.5 * 0.2 + 0.5 * 0.1);
  });

  test("missingTarget hold keeps a day with no target on the curve with its return; skip leaves it out", () => {
    const axis = axisBetween("2024-06-20", "2024-06-24");
    const eth = series({ "2024-06-20": 100, "2024-06-21": 100, "2024-06-22": 110, "2024-06-23": 121, "2024-06-24": 121 });
    const sp500 = series({ "2024-06-20": 100, "2024-06-21": 100, "2024-06-24": 100 });
    const T: Weights = { cash: 0.5, eth: 0.5 };
    const sched: Schedule = axis.map((d) => (d === "2024-06-22" ? null : T));
    const hold = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], { ...PER_ASSET, missingTarget: "hold" });
    const skip = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], { ...PER_ASSET, missingTarget: "skip" });
    expect(hold.values.map((p) => p.date)).toEqual(["2024-06-21", "2024-06-22", "2024-06-23", "2024-06-24"]);
    expect(skip.values.map((p) => p.date)).toEqual(["2024-06-21", "2024-06-23", "2024-06-24"]);
    // hold: +10% on 0.5 ETH, then +10% on the drifted 0.55 / 1.05.
    const r1 = 0.05;
    const r2 = (0.55 / 1.05) * 0.1;
    rel(hold.returns[0]!.value, r1);
    rel(hold.returns[1]!.value, r2);
    rel(hold.values[2]!.value, (1 + r1) * (1 + r2));
    // skip: the 22nd is off the curve and its move is lost; the 23rd earns 121 / 110 on 0.5 ETH.
    rel(skip.returns[0]!.value, 0.5 * 0.1);
    expect(hold.trades).toEqual([]);
    // Whole-book hold is the schedule with the target carried over the day.
    const wb = simulateDriftWithDefaults(axis, sched, { eth, sp500 }, [], { lagSessions: 0, calendars: { eth: "continuous", sp500: "continuous" }, freq: "never", missingTarget: "hold" });
    expect(wb.values.map((p) => p.date)).toEqual(axis);
  });

  test("lagCount asset-sessions or calendarDay asset-session with whole-book, band with per-asset, and an unknown value of each option throw RangeError naming the option", () => {
    const sched = AX.map(() => HALF);
    const bad = (o: unknown, field: RegExp) => {
      const call = () => simulateDriftWithDefaults(AX, sched, DOUBLES, [], o as DriftOptions);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(field);
    };
    bad({ lagCount: "asset-sessions" }, /lagCount/);
    bad({ lagCount: "asset-sessions", execution: "whole-book" }, /lagCount/);
    bad({ calendarDay: "asset-session" }, /calendarDay/);
    bad({ execution: "per-asset", band: 0.1 }, /band/);
    bad({ lagCount: "sessions" }, /lagCount/);
    bad({ execution: "per_asset" }, /execution/);
    bad({ calendarDay: "first" }, /calendarDay/);
    bad({ missingTarget: "carry" }, /missingTarget/);
    bad({ targetChange: "per-asset" }, /targetChange/);
  });
});

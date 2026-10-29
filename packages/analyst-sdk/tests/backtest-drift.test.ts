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
  driftedWeight,
  forwardFillDaily,
  periodStats,
  PORTFOLIO_SPECS,
  scheduleFromLabels,
  simulateDrift,
  simulatePortfolio,
  type DriftOptions,
  type Schedule,
  type Weights,
} from "../src/analyze/backtest.ts";
import { ddDiv, ddValue, dotDD, periodicRate, twoSum } from "../src/transform/exact.ts";
import * as entry from "../src/index.ts";
import { parseRawHistory, runRegime, toHistory } from "../src/index.ts";
import type { Point } from "../src/types.ts";
import { exactDot, onePlus, Q } from "./support/exact-reference.ts";

setDefaultTimeout(120_000);
const DIR = import.meta.dir;
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
      const rs: Record<string, number> = { cash: periodicRate((tb[i - 1] || 0) / 100, 365) };
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
      expect(ref.trades.length).toBeGreaterThan(5);
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
    const st = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades });
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
    expect(entry.simulateDrift).toBe(simulateDrift);
    expect(entry.periodStats).toBe(periodStats);
    const opts: entry.DriftOptions = { freq: "weekly" as entry.RebalanceFrequency };
    expect(entry.simulateDrift(AX, sched, DOUBLES, [], opts).values.length).toBe(5);
  });
});

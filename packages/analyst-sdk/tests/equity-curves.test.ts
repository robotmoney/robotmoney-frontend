// Issue 1766: equity curve sampling, evaluation windows and the label
// strategies (analytics requirements sections 5.4 and 5.5).
import { describe, expect, test } from "bun:test";
import {
  dailyCashRate,
  periodStats,
  PORTFOLIO_SPECS,
  referenceStrategies,
  sampleEquityCurve,
  scheduleFromLabels,
  simulateDrift,
  type DriftOptions,
  type Schedule,
  type SimulationResult,
} from "../src/analyze/backtest.ts";
import { carryForward, evaluateEquityCurve, labelStrategyCurves, monthsBefore, type CurveGroupOptions } from "../src/analyze/equity-curves.ts";
import { OPTIMIZERS_PRESET } from "../src/allocate/weighting-rules.ts";
import type { Point } from "../src/types.ts";
import { syntheticMarket } from "./support/optimizers-synthetic.ts";

const M = syntheticMarket("2023-01-01", "2024-09-30");
const LABEL_PRICES = { eth: M.prices.eth, sp500: M.prices.sp500 };
const TRADING: DriftOptions = { ...OPTIMIZERS_PRESET.trading, calendars: { eth: "continuous", sp500: "observed" } };
const mixed = (): SimulationResult =>
  simulateDrift(M.axis, scheduleFromLabels(carryForward(M.labels.regime), PORTFOLIO_SPECS.mixed!.weights), LABEL_PRICES, M.cashQuotes, TRADING);
const statsOf = (sim: SimulationResult, from: string, extra: object = {}) =>
  periodStats(sim.values, from, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades, ...extra });

// The 0.9.0 month-end curve, written out: the first value, then each month's last value.
function monthEnd090(window: readonly Point[]): Point[] {
  const last = new Map<string, Point>();
  for (const p of window) last.set(p.date.slice(0, 7), p);
  const out = [...last.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (window.length && out[0] !== window[0]) out.unshift(window[0]!);
  return out;
}

describe("equity curve sampling", () => {
  const sim = mixed();
  test("periodStats with no sampling and with month-end deep-equals the 0.9.0 result", () => {
    const plain = statsOf(sim, sim.startDate);
    expect(statsOf(sim, sim.startDate, { sampling: { kind: "month-end" } })).toEqual(plain);
    expect(plain.equity_curve).toEqual(monthEnd090(sim.values.filter((p) => p.date >= sim.startDate)));
    const later = statsOf(sim, "2024-02-10");
    expect(later.equity_curve).toEqual(monthEnd090(sim.values.filter((p) => p.date >= "2024-02-10")));
  });

  test("weekday 5: the first point is the window's first value, every point between is a Friday, the last is the window's last value", () => {
    const from = "2023-05-03";
    const s = statsOf(sim, from, { sampling: { kind: "weekday", weekday: 5 } });
    const window = sim.values.filter((p) => p.date >= from);
    expect(s.equity_curve[0]).toEqual(window[0]!);
    expect(s.equity_curve.at(-1)).toEqual(window.at(-1)!);
    for (const p of s.equity_curve.slice(1, -1)) expect(new Date(`${p.date}T00:00:00Z`).getUTCDay()).toBe(5);
    expect(s.equity_curve.length).toBe(window.filter((p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 5).length + 2);
  });

  test("sampleEquityCurve on a window's values equals periodStats's equity_curve under both kinds", () => {
    const from = "2023-08-17";
    const window = sim.values.filter((p) => p.date >= from);
    for (const sampling of [{ kind: "month-end" as const }, { kind: "weekday" as const, weekday: 5 }, { kind: "weekday" as const, weekday: 0 }]) {
      expect(sampleEquityCurve(window, sampling)).toEqual(statsOf(sim, from, { sampling }).equity_curve);
    }
    expect(() => sampleEquityCurve(window, { kind: "weekday", weekday: 7 })).toThrow(RangeError);
    expect(() => statsOf(sim, from, { sampling: { kind: "weekly" } })).toThrow(/sampling/);
  });
});

describe("evaluation windows", () => {
  test("monthsBefore: the same calendar day N months earlier, or that month's last day", () => {
    expect(monthsBefore("2026-11-16", 12)).toBe("2025-11-16");
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2024-02-29", 12)).toBe("2023-02-28");
    expect(monthsBefore("2024-03-31", 1)).toBe("2024-02-29");
    expect(monthsBefore("2024-01-15", 0)).toBe("2024-01-15");
  });

  test("on a simulation shorter than two years: since inception and trailing 12 months are periodStats's, 36 and 60 are null", () => {
    const sim = mixed();
    const e = evaluateEquityCurve(sim, { kind: "strategy", trailingMonths: [12, 36, 60] });
    const si = statsOf(sim, sim.startDate);
    expect(e.first_day).toBe(sim.startDate);
    expect(e.last_day).toBe(sim.endDate);
    expect(e.windows.since_inception).toEqual({
      first_day: si.start_date, last_day: si.end_date, final_value: si.final_value!, cagr: si.cagr!, sharpe: si.sharpe!, max_drawdown: si.max_drawdown!, trades: si.transitions, n_days: si.n_days,
    });
    const t12 = statsOf(sim, monthsBefore(sim.endDate, 12));
    expect(e.windows.trailing_12m).toEqual({
      first_day: monthsBefore(sim.endDate, 12), last_day: sim.endDate, final_value: t12.final_value!, cagr: t12.cagr!, sharpe: t12.sharpe!, max_drawdown: t12.max_drawdown!, trades: t12.transitions, n_days: t12.n_days,
    });
    expect(e.windows.trailing_36m).toBeNull();
    expect(e.windows.trailing_60m).toBeNull();
    expect(e.final_value).toBe(e.windows.since_inception.final_value);
    expect(e.equity_curve).toEqual(si.equity_curve);
    expect(e.windows.since_inception.trades).toBeGreaterThan(3);
  });

  test("an all-cash curve scores a Sharpe ratio of 0 in every window", () => {
    const sim = simulateDrift(M.axis, M.axis.map(() => ({ cash: 1 })), LABEL_PRICES, M.cashQuotes, { ...TRADING, freq: "never" });
    const e = evaluateEquityCurve(sim, { kind: "cash", trailingMonths: [3, 12] });
    for (const w of [e.windows.since_inception, e.windows.trailing_3m!, e.windows.trailing_12m!]) expect(w.sharpe).toBe(0);
  });

  test("the Sharpe ratio is the mean over the sample sd, times sqrt(365), of the daily return after costs less the cash return", () => {
    const sim = mixed();
    const e = evaluateEquityCurve(sim, { kind: "strategy", trailingMonths: [12] });
    const quote = new Map(M.cashQuotes.map((p) => [p.date, p.value]));
    // The previous day's quote, carried over the days with none.
    let q = 0;
    const cashOn = new Map<string, number>();
    for (const d of M.axis) {
      cashOn.set(d, dailyCashRate(q, "discount"));
      q = quote.get(d) ?? q;
    }
    const sharpe = (from: string) => {
      const v = sim.values.filter((p) => p.date >= from);
      const x = v.slice(1).map((p, i) => p.value / v[i]!.value - 1 - cashOn.get(p.date)!);
      const mean = x.reduce((a, b) => a + b, 0) / x.length;
      const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (x.length - 1));
      return (mean / sd) * Math.sqrt(365);
    };
    expect(Math.abs(e.windows.since_inception.sharpe - sharpe(sim.startDate))).toBeLessThan(1e-10);
    expect(Math.abs(e.windows.trailing_12m!.sharpe - sharpe(monthsBefore(sim.endDate, 12)))).toBeLessThan(1e-10);
  });

  test("an unknown option or kind is a RangeError naming it", () => {
    expect(() => evaluateEquityCurve(mixed(), { kind: "strategy", window: 12 } as never)).toThrow(/window/);
    expect(() => evaluateEquityCurve(mixed(), { kind: "hodl" } as never)).toThrow(/kind/);
  });
});

describe("label strategies", () => {
  const options: CurveGroupOptions = { trading: OPTIMIZERS_PRESET.trading, sampling: OPTIMIZERS_PRESET.sampling, windows: { trailingMonths: [12], commonPeriodMonths: 12 } };
  const groups = labelStrategyCurves(M.axis, M.labels, M.prices, M.cashQuotes, options);
  const lines = referenceStrategies({ regime: carryForward(M.labels.regime), panelRegimes: { macro: carryForward(M.labels.panelRegimes.macro!), onchain: carryForward(M.labels.panelRegimes.onchain!) }, panels: ["macro", "onchain"] });

  test("eth, sp500 and mixed, each with every referenceStrategies line, its buy-and-hold key and stables_only, all starting on one day", () => {
    expect(Object.keys(groups)).toEqual(["eth", "sp500", "mixed"]);
    for (const [market, g] of Object.entries(groups)) expect(Object.keys(g).sort()).toEqual([...Object.keys(lines), PORTFOLIO_SPECS[market]!.hodl.key, "stables_only"].sort());
    const firsts = new Set(Object.values(groups).flatMap((g) => Object.values(g).map((c) => c.first_day)));
    expect(firsts.size).toBe(1);
  });

  test("each curve deep-equals simulateDrift and evaluateEquityCurve called on the schedule built with scheduleFromLabels", () => {
    const first = M.axis.findIndex((_, i) => Object.values(lines).every((s) => s[i] != null));
    const cut = (s: Schedule): Schedule => s.map((w, i) => (i < first ? null : w));
    const trading = { ...OPTIMIZERS_PRESET.trading, calendars: { eth: "continuous" as const, sp500: "observed" as const } };
    const ev = (s: Schedule, kind: "strategy" | "buy_and_hold_benchmark" | "cash", o: DriftOptions) =>
      evaluateEquityCurve(simulateDrift(M.axis, s, LABEL_PRICES, M.cashQuotes, o), { kind, trailingMonths: [12], sampling: OPTIMIZERS_PRESET.sampling });
    for (const [market, spec] of Object.entries(PORTFOLIO_SPECS)) {
      for (const [name, s] of Object.entries(lines)) expect(groups[market]![name]).toEqual(ev(cut(scheduleFromLabels(s, spec.weights)), "strategy", trading));
      expect(groups[market]![spec.hodl.key]).toEqual(ev(cut(M.axis.map(() => spec.hodl.weights)), "buy_and_hold_benchmark", { ...trading, freq: "never" }));
    }
    expect(groups.eth!.stables_only).toEqual(ev(cut(M.axis.map(() => ({ cash: 1 }))), "cash", { ...trading, freq: "never" }));
  });

  test("every benchmark and cash window has trades 0, strategies trade, and the three cash curves are equal", () => {
    for (const g of Object.values(groups)) {
      for (const c of Object.values(g)) {
        const windows = [c.windows.since_inception, c.windows.trailing_12m];
        if (c.kind === "strategy") continue;
        for (const w of windows) expect(w!.trades).toBe(0);
      }
      expect(g.composite!.windows.since_inception.trades).toBeGreaterThan(0);
    }
    expect(groups.eth!.stables_only).toEqual(groups.sp500!.stables_only!);
    expect(groups.mixed!.stables_only).toEqual(groups.eth!.stables_only!);
  });

  test("an unknown option key is a RangeError naming it", () => {
    expect(() => labelStrategyCurves(M.axis, M.labels, M.prices, M.cashQuotes, { trading: {}, labelStrategies: {} } as never)).toThrow(RangeError);
    expect(() => labelStrategyCurves(M.axis, M.labels, M.prices, M.cashQuotes, { trading: {}, labelStrategies: {} } as never)).toThrow(/labelStrategies/);
  });
});

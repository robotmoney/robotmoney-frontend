// The public backtest API (issue 1404; analytics requirements section 5):
// simulatePortfolio, periodStats and scheduleFromLabels expose the one shared
// calculation, and computeBacktest is those three over the reference
// portfolios. Three paths must agree byte for byte on identical inputs:
//   original     tests/reference/backtest-pre-refactor.ts (frozen pre-refactor code)
//   shared       computeBacktest (what backend and SDK run)
//   generalized  simulatePortfolio + periodStats called directly
// including the per-day values (`_daily`), every statistic, nulls and field order.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  BACKTEST_IN_SAMPLE_END,
  combineAggressiveN,
  combineConservativeN,
  PORTFOLIO_SPECS,
  computeBacktest,
  periodStats,
  scheduleFromLabels,
  simulatePortfolio,
  stripDailyFromSnapshot,
  type BacktestExtras,
  type Schedule,
} from "../src/analyze/backtest.ts";
import { computeBacktest as originalBacktest } from "./reference/backtest-pre-refactor.ts";
import type { RegimeComputeResult } from "../src/analyze/compute.ts";
import { buildReport, parseRawHistory, runRegime, toHistory } from "../src/index.ts";
import type { Point } from "../src/types.ts";

setDefaultTimeout(120_000);
const DIR = import.meta.dir;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
const axisOf = (n: number) => Array.from({ length: n }, (_, i) => day(i));
const pts = (axis: string[], vals: (number | undefined)[]): Point[] =>
  vals.flatMap((v, i) => (v === undefined ? [] : [{ date: axis[i]!, value: v }]));

// The generalized path for one reference portfolio: the same schedules and
// prices computeBacktest builds, through the public functions.
function generalized(dateAxis: string[], result: RegimeComputeResult, extras: BacktestExtras) {
  const price: Record<string, Point[]> = { eth: extras.eth, sp500: extras.spx };
  const panels = result.panels;
  const labels: Record<string, (string | null)[]> = { composite: result.regime };
  for (const p of panels) labels[p] = result.panelRegimes[p]!;
  if (result.panelRegimes.macro) labels.macro_inverted = result.panelRegimes.macro.map((b) => (b === "risk_off" ? "risk_on" : b === "risk_on" ? "risk_off" : b));
  labels.conservative = result.regime.map((_, i) => combineConservativeN(panels.map((p) => result.panelRegimes[p]![i]!)));
  labels.aggressive = result.regime.map((_, i) => combineAggressiveN(panels.map((p) => result.panelRegimes[p]![i]!)));
  const ref = originalBacktest(dateAxis, result, extras);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [pKey, spec] of Object.entries(PORTFOLIO_SPECS)) {
    if (!ref[pKey]) continue;
    const prices: Record<string, Point[]> = {};
    for (const a of spec.risky) prices[a] = price[a]!;
    const run = (s: Schedule) => {
      const sim = simulatePortfolio(dateAxis, s, prices, extras.tbill3m);
      return periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades });
    };
    const port: Record<string, unknown> = {};
    for (const name of Object.keys(ref[pKey]!)) {
      if (name === spec.hodl.key) port[name] = run(dateAxis.map(() => spec.hodl.weights));
      else if (name === "stables_only") port[name] = run(dateAxis.map(() => ({ cash: 1 })));
      else port[name] = run(scheduleFromLabels(labels[name]!, spec.weights));
    }
    expect(Object.keys(port)).toEqual(Object.keys(ref[pKey]!));
    out[pKey] = port;
  }
  return { ref, out };
}

function threeWay(dateAxis: string[], result: RegimeComputeResult, extras: BacktestExtras) {
  const original = JSON.stringify(originalBacktest(dateAxis, result, extras));
  const shared = JSON.stringify(computeBacktest(dateAxis, result, extras));
  expect(shared).toBe(original);
  const { ref, out } = generalized(dateAxis, result, extras);
  for (const [p, strategies] of Object.entries(out)) {
    for (const [s, m] of Object.entries(strategies)) expect(JSON.stringify(m)).toBe(JSON.stringify(ref[p]![s]));
  }
  return JSON.parse(shared) as ReturnType<typeof computeBacktest>;
}

const fakeResult = (axis: string[], regime: (string | null)[], macro = regime, onchain = regime) =>
  ({ dateAxis: axis, regime, panels: ["macro", "onchain"], panelRegimes: { macro, onchain } }) as unknown as RegimeComputeResult;

describe("simulatePortfolio: hand-calculated values", () => {
  const axis = axisOf(5);
  const A = pts(axis, [100, 110, 99, 99, 108.9]);
  const B = pts(axis, [50, 50, 55, 55, 55]);

  test("arbitrary supplied assets: values follow the previous target weights", () => {
    const w = { A: 0.5, B: 0.25, cash: 0.25 };
    const sim = simulatePortfolio(axis, axis.map(() => w), { A, B }, []);
    // day 1: 0.5*(110/100-1) + 0.25*(50/50-1) + 0.25*0 = 0.05
    // day 2: 0.5*(99/110-1) + 0.25*(55/50-1) = -0.05 + 0.025
    const r = [0.5 * (110 / 100 - 1) + 0.25 * (50 / 50 - 1), 0.5 * (99 / 110 - 1) + 0.25 * (55 / 50 - 1), 0.5 * (99 / 99 - 1) + 0.25 * (55 / 55 - 1), 0.5 * (108.9 / 99 - 1) + 0.25 * (55 / 55 - 1)];
    let v = 1;
    const values = [1, ...r.map((x) => (v *= 1 + x))];
    expect(sim.values.map((p) => p.value)).toEqual(values);
    expect(sim.returns).toEqual(r.map((value, i) => ({ date: axis[i + 1]!, value })));
    expect(sim.trades).toEqual([]);
    expect(sim.startDate).toBe(axis[0]);
    expect(sim.endDate).toBe(axis[4]);
  });

  test("cash accrues the previous date's annual percent yield over 365 days; missing earlier yields earn zero", () => {
    const rate = pts(axis, [undefined, 3.65, undefined, 5, undefined]);
    const sim = simulatePortfolio(axis, axis.map(() => ({ cash: 1 })), {}, rate);
    const d = (y: number) => Math.pow(1 + y / 100, 1 / 365) - 1;
    // day 1 uses day 0's yield (none yet: 0); day 2 uses 3.65; day 3 uses 3.65 (forward-filled); day 4 uses 5.
    const r = [d(0), d(3.65), d(3.65), d(5)];
    let v = 1;
    expect(sim.values.map((p) => p.value)).toEqual([1, ...r.map((x) => (v *= 1 + x))]);
    expect(sim.returns.map((p) => p.value)).toEqual(r);
  });

  test("default 10 bps and custom costBps on one-sided turnover at the close", () => {
    const sched: Schedule = [{ A: 1 }, { A: 1 }, { A: 0.5, cash: 0.5 }, { A: 0.5, cash: 0.5 }, { cash: 1 }];
    const def = simulatePortfolio(axis, sched, { A }, []);
    const custom = simulatePortfolio(axis, sched, { A }, [], { costBps: 25 });
    // Turnover = sum |dw| / 2: day 2 (A 1 -> 0.5, cash 0 -> 0.5) = 0.5; day 4 = 0.5.
    expect(def.trades).toEqual([
      { date: axis[2]!, turnover: 0.5, cost: 0.5 * 0.001 },
      { date: axis[4]!, turnover: 0.5, cost: 0.5 * 0.001 },
    ]);
    expect(custom.trades.map((t) => t.cost)).toEqual([0.5 * 0.0025, 0.5 * 0.0025]);
    let v = 1;
    const exp = [1];
    v *= 1 + (110 / 100 - 1); exp.push(v);
    v *= 1 + (99 / 110 - 1); v *= 1 - 0.5 * 0.001; exp.push(v);
    v *= 1 + 0.5 * (99 / 99 - 1); exp.push(v);
    v *= 1 + 0.5 * (108.9 / 99 - 1); v *= 1 - 0.5 * 0.001; exp.push(v);
    expect(def.values.map((p) => p.value)).toEqual(exp);
    // Costs never touch the pre-cost return observations.
    expect(custom.returns).toEqual(def.returns);
    expect(custom.values[4]!.value).toBeLessThan(def.values[4]!.value);
  });

  test("costBps 10 is the default exactly", () => {
    const sched: Schedule = [{ A: 1 }, { cash: 1 }, { A: 1 }, { cash: 1 }, { A: 1 }];
    expect(JSON.stringify(simulatePortfolio(axis, sched, { A }, [], { costBps: 10 }))).toBe(JSON.stringify(simulatePortfolio(axis, sched, { A }, [])));
  });

  test("invalid weights, schedules and options are rejected", () => {
    const bad = (s: Schedule, o?: object, prices: Record<string, Point[]> = { A }) =>
      expect(() => simulatePortfolio(axis, s, prices, [], o as never)).toThrow(RangeError);
    const fill = (w: Record<string, number>) => axis.map(() => w);
    bad(fill({ A: -0.5, cash: 1.5 }));
    bad(fill({ A: NaN, cash: 1 }));
    bad(fill({ A: Infinity }));
    bad(fill({ A: 0.5, cash: 0.4 }));
    bad(fill({ A: 0.6, cash: 0.6 }));
    bad(fill({ Z: 1 }));
    bad(fill({ A: "1" as never }));
    bad(axis.slice(1).map(() => ({ A: 1 })));
    bad(fill({ A: 1 }), { costBps: -1 });
    bad(fill({ A: 1 }), { costBps: NaN });
    bad(fill({ A: 1 }), { costbps: 5 });
    expect(() => simulatePortfolio(axis, fill({ A: 1 }), { A: [] }, [])).toThrow(/missing price coverage.*A/);
    expect(() => simulatePortfolio([], [], { A }, [])).toThrow(RangeError);
    expect(() => simulatePortfolio([axis[1]!, axis[0]!], [{ A: 1 }, { A: 1 }], { A }, [])).toThrow(RangeError);
  });

  test("finite nonnegative unit-sum weights are accepted, including zero shares", () => {
    expect(() => simulatePortfolio(axis, axis.map(() => ({ A: 0, B: 1, cash: 0 })), { A, B }, [])).not.toThrow();
    expect(() => simulatePortfolio(axis, axis.map(() => ({ A: 0.1, B: 0.2, cash: 0.7 })), { A, B }, [])).not.toThrow();
  });
});

describe("timing: close-of-day targets", () => {
  const axis = axisOf(8);
  const A = pts(axis, [100, 102, 101, 105, 104, 108, 107, 110]);
  const base: Schedule = axis.map(() => ({ A: 0.5, cash: 0.5 }));
  const changed: Schedule = base.map((w, i) => (i === 4 ? { A: 1 } : w));

  test("changing one date's targets leaves earlier values and that date's pre-cost return unchanged; its close-of-day cost is the one-sided turnover", () => {
    const a = simulatePortfolio(axis, base, { A }, []);
    const b = simulatePortfolio(axis, changed, { A }, []);
    for (let i = 0; i < 4; i++) expect(b.values[i]).toEqual(a.values[i]!);
    // returns[k] is dated axis[k + 1]; the changed date is axis[4] -> returns[3].
    for (let k = 0; k <= 3; k++) expect(b.returns[k]).toEqual(a.returns[k]!);
    expect(a.trades).toEqual([]);
    // In at day 4's close (0.5 -> 1 on A, 0.5 -> 0 cash: turnover 0.5), out at day 5's close.
    expect(b.trades).toEqual([
      { date: axis[4]!, turnover: 0.5, cost: 0.5 * 0.001 },
      { date: axis[5]!, turnover: 0.5, cost: 0.5 * 0.001 },
    ]);
    expect(b.values[4]!.value).toBe(a.values[4]!.value * (1 - 0.5 * 0.001));
    // The new weights apply to the next return.
    expect(b.returns[4]!.value).toBe(1 * (108 / 104 - 1));
  });

  test("a date with no applicable weights is skipped with its market move", () => {
    const s: Schedule = base.map((w, i) => (i === 2 ? null : w));
    const sim = simulatePortfolio(axis, s, { A }, []);
    expect(sim.values.map((p) => p.date)).not.toContain(axis[2]);
    // The move into day 2 is skipped; day 3's return is day 3 vs day 2's price.
    expect(sim.returns.find((r) => r.date === axis[3])!.value).toBe(0.5 * (105 / 101 - 1));
    expect(sim.returns.map((r) => r.date)).not.toContain(axis[2]);
  });

  test("additional windows and a different split leave the full-range report fields unchanged", () => {
    const sim = simulatePortfolio(axis, changed, { A }, []);
    const full = () => JSON.stringify(periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades }));
    const before = full();
    const w = periodStats(sim.values, axis[2]!, axis[6]!, { returns: sim.returns, trades: sim.trades, splitDate: axis[4]! });
    expect(full()).toBe(before);
    expect(w.start_date).toBe(axis[2]);
    expect(w.end_date).toBe(axis[6]);
    expect(w.n_days).toBe(4);
    expect(w.transitions).toBe(2);
    expect(w.final_value).toBe(sim.values[6]!.value / sim.values[2]!.value);
    expect(() => periodStats(sim.values, axis[6]!, axis[2]!, { returns: sim.returns })).toThrow(RangeError);
    expect(() => periodStats(sim.values, axis[0]!, axis[2]!, {} as never)).toThrow(RangeError);
    expect(() => periodStats(sim.values, axis[0]!, axis[2]!, { returns: [], bogus: 1 } as never)).toThrow(RangeError);
  });
});

describe("parity: original, shared and generalized paths", () => {
  const raw = toHistory(parseRawHistory(readFileSync(join(DIR, "fixtures/raw-indicator-history.csv"), "utf8")));
  const extras: BacktestExtras = { spx: raw.SPX!, eth: raw.ETH!, tbill3m: raw.TBILL3M! };

  test("fixture, two-panel result: complete payload with daily values is byte-identical on all three paths", () => {
    const run = runRegime(raw);
    const out = threeWay(run.dateAxis, run.result, extras);
    // Pinned bytes of the pre-refactor output, daily values included (main 408cd875, computed from the unmodified main checkout).
    expect(sha(JSON.stringify(out))).toBe("ee9a3019dbfb8ff98a58af2db337e361273415db127fa314ba8b0e8b5df8d2cf");
    expect(Object.keys(out.mixed!)).toContain("blend_hodl");
  });

  test("fixture, three-panel (factor) result is byte-identical on all three paths", () => {
    const run = runRegime(raw, { factor: true });
    threeWay(run.dateAxis, run.factor!, extras);
  });

  test("the reference report's backtest section is unchanged: golden bytes", async () => {
    const golden = await Bun.file(join(DIR, "golden/regime-report.json")).text();
    const report = buildReport(runRegime(raw));
    expect(JSON.stringify(report.backtest, null, 2)).toBe(JSON.stringify(JSON.parse(golden).backtest, null, 2));
    expect(JSON.stringify(stripDailyFromSnapshot(computeBacktest(runRegime(raw).dateAxis, runRegime(raw).result, extras)))).toBe(JSON.stringify(report.backtest));
  });

  const axis = axisOf(900); // 2024-01-01 onward: spans the 2024-01-31 in-sample split
  const wave = (i: number, base: number, amp: number, per: number) => base + amp * Math.sin(i / per);
  const labelsAt = (i: number) => (i % 97 < 30 ? "risk_on" : i % 97 < 60 ? "neutral" : "risk_off");

  test("blend_hodl is a fixed-target daily calculation with no reset cost; distinct starts per path", () => {
    const eth = pts(axis, axis.map((_, i) => (i < 40 ? undefined : wave(i, 2000, 300, 17))));
    const spx = pts(axis, axis.map((_, i) => (i < 10 ? undefined : wave(i, 4000, 200, 23))));
    const tbill = pts(axis, axis.map((_, i) => (i % 5 === 0 ? 4 + (i % 3) * 0.1 : undefined)));
    const regime = axis.map((_, i) => (i < 60 ? null : labelsAt(i)));
    const out = threeWay(axis, fakeResult(axis, regime), { spx, eth, tbill3m: tbill });
    // Baselines start at the first priced date of the portfolio's assets;
    // strategies at their first labelled date.
    expect(out.sp500!.sp500_hodl!.start_date).toBe(axis[10]);
    expect(out.eth!.eth_hodl!.start_date).toBe(axis[40]);
    expect(out.mixed!.blend_hodl!.start_date).toBe(axis[40]);
    expect(out.mixed!.composite!.start_date).toBe(axis[60]);
    expect(out.mixed!.blend_hodl!.transitions).toBe(0);
  });

  test("absent labels, zero volatility, nonfinite and null cases, split boundaries", () => {
    const flat = pts(axis, axis.map(() => 100));
    // Every label absent: strategies never start; baselines still run.
    const none = threeWay(axis, fakeResult(axis, axis.map(() => null)), { spx: flat, eth: flat, tbill3m: [] });
    expect(none.eth!.composite!.n_days).toBe(0);
    expect(none.eth!.composite!.final_value).toBe(1);
    // Zero volatility: flat prices, no yield -> Sharpe 0, no risk-free subtraction.
    expect(none.eth!.eth_hodl!.sharpe).toBe(0);
    expect(none.eth!.stables_only!.sharpe).toBe(0);
    // A portfolio with no priced date is left out; nonfinite prices are gaps.
    const nanEth = pts(axis, axis.map(() => NaN));
    const skipped = threeWay(axis, fakeResult(axis, axis.map((_, i) => labelsAt(i))), { spx: flat, eth: nanEth, tbill3m: [] });
    expect(Object.keys(skipped)).toEqual(["sp500"]);
    // An axis that ends before the split: no out-of-sample figures (null).
    const short = axisOf(20);
    const pre = threeWay(short, fakeResult(short, short.map((_, i) => labelsAt(i))), { spx: pts(short, short.map((_, i) => 100 + i)), eth: pts(short, short.map((_, i) => 50 + i)), tbill3m: [] });
    expect(pre.eth!.composite!.cagr_out_sample).toBeNull();
    expect(short[19]! <= BACKTEST_IN_SAMPLE_END).toBe(true);
    // A one-day axis: zero elapsed years -> cagr 0 (not NaN); in-sample 0, out-of-sample null.
    const one = axisOf(1);
    const single = threeWay(one, fakeResult(one, ["risk_on"]), { spx: pts(one, [1]), eth: pts(one, [1]), tbill3m: [] });
    expect(single.eth!.composite!.cagr).toBe(0);
    expect(single.eth!.composite!.cagr_in_sample).toBe(0);
    expect(single.eth!.composite!.cagr_out_sample).toBeNull();
  });

  test("cost-bearing path: Sharpe uses the pre-cost returns, not returns derived from net values", () => {
    const eth = pts(axis, axis.map((_, i) => wave(i, 2000, 300, 11)));
    const spx = pts(axis, axis.map((_, i) => wave(i, 4000, 200, 13)));
    const res = fakeResult(axis, axis.map((_, i) => labelsAt(i)));
    const out = threeWay(axis, res, { spx, eth, tbill3m: [] });
    expect(out.eth!.composite!.transitions).toBeGreaterThan(5);
    const sim = simulatePortfolio(axis, scheduleFromLabels(res.regime, PORTFOLIO_SPECS.eth!.weights), { eth }, []);
    const pre = sim.returns.map((r) => r.value);
    const sharpeOf = (xs: number[]) => {
      const m = xs.reduce((s, v) => s + v, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
      return (m * 365) / (sd * Math.sqrt(365));
    };
    expect(out.eth!.composite!.sharpe).toBe(sharpeOf(pre));
    const net = sim.values.slice(1).map((p, i) => p.value / sim.values[i]!.value - 1);
    expect(sharpeOf(net)).not.toBe(out.eth!.composite!.sharpe);
  });
});

describe("scheduleFromLabels", () => {
  test("maps labels through the table; a missing or unknown label has no weights", () => {
    const t = PORTFOLIO_SPECS.eth!.weights;
    expect(scheduleFromLabels(["risk_on", null, "neutral", "bogus", "toString"], t)).toEqual([t.risk_on!, null, t.neutral!, null, null]);
  });
});

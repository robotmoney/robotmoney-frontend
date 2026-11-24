// The public backtest API (issue 1404; analytics requirements section 5):
// simulatePortfolio, periodStats and scheduleFromLabels expose the one shared
// calculation, and computeBacktest is those three over the reference
// portfolios. Three paths must agree on identical inputs:
//   original     tests/reference/backtest-pre-refactor.ts (frozen pre-refactor code)
//   shared       computeBacktest (what backend and SDK run)
//   generalized  simulatePortfolio + periodStats called directly
// including the per-day values (`_daily`), every statistic, nulls and field order.
// shared and generalized agree byte for byte. Since decision D78
// (compensated arithmetic) the frozen original keeps the old plain-loop
// arithmetic, so it agrees with them up to rounding: same structure, labels,
// nulls and integers, no number moved by more than rounding.
// Issue 1559 starts every line of a market on the strategies' first labelled
// date; the frozen original predates it, so it is compared with that rule
// applied (support/issue-1559.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  BACKTEST_IN_SAMPLE_END,
  combineAggressiveN,
  combineConservativeN,
  PORTFOLIO_SPECS,
  REFERENCE_FILL_POLICIES,
  UNKNOWN_LABEL_RULE,
  DEFAULT_SIMULATOR_FILL,
  computeBacktest,
  computeBacktestWithFill,
  referenceStrategies,
  periodStats,
  scheduleFromLabels,
  simulatePortfolio,
  stripDailyFromSnapshot,
  type BacktestExtras,
  type Schedule,
} from "../src/analyze/backtest.ts";
import { computeBacktest as originalBacktest } from "./reference/backtest-pre-refactor.ts";
import type { RegimeComputeResult } from "../src/analyze/compute.ts";
import { buildReport, parseRawHistory, runRegime as runRegimeOutcome, requireComplete, toHistory } from "../src/index.ts";
// Each run here scores a complete day (issue 1655): an IncompleteDay fails the test.
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));
import type { Point } from "../src/types.ts";
import { expectSameUpToRounding } from "./support/numeric-diff.ts";
import { apply1559 } from "./support/issue-1559.ts";
import { exactCompound, exactDot, exactProduct, exactSharpe, onePlus, Q } from "./support/exact-reference.ts";
import { NONE, forward, simulatorFillCases } from "./support/simulator-fill-cases.ts";

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
    // Issue 1559: every schedule is empty before the latest first labelled
    // date (on or after the first priced date) of the market's strategies.
    const priced = dateAxis.findIndex((_, i) => spec.risky.every((a) => price[a]!.some((p) => p.date <= dateAxis[i]! && Number.isFinite(p.value))));
    const strategySchedules = Object.keys(ref[pKey]!)
      .filter((name) => name !== spec.hodl.key && name !== "stables_only")
      .map((name) => scheduleFromLabels(labels[name]!, spec.weights));
    const start = Math.max(-1, ...strategySchedules.map((s) => s.findIndex((w, i) => i >= priced && w != null)));
    const run = (s: Schedule) => {
      const sim = simulatePortfolio(dateAxis, start < 0 ? s : s.map((w, i) => (i < start ? null : w)), prices, extras.tbill3m);
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

// Issue 1741: a missing panel gives a NaN composite, so the composite can label
// later than a panel. The frozen original starts each strategy on its own first
// label and apply1559 requires one start per market, so the original is handed
// labels cut to the market's latest first label: the day the shared path starts
// every strategy on (issue 1559).
function labelsFromMarketStart(result: RegimeComputeResult): RegimeComputeResult {
  const series = [result.regime, ...result.panels.map((p) => result.panelRegimes[p]!)];
  const start = Math.max(...series.map((l) => l.findIndex((b) => b != null)));
  const cut = (l: (string | null)[]) => l.map((b, i) => (i < start ? null : b));
  const panelRegimes = Object.fromEntries(Object.entries(result.panelRegimes).map(([p, l]) => [p, cut(l)]));
  return { ...result, regime: cut(result.regime), panelRegimes } as RegimeComputeResult;
}

function threeWay(dateAxis: string[], result: RegimeComputeResult, extras: BacktestExtras) {
  const original = JSON.stringify(apply1559(originalBacktest(dateAxis, labelsFromMarketStart(result), extras)));
  const shared = JSON.stringify(computeBacktest(dateAxis, result, extras));
  expectSameUpToRounding(shared, original, "shared vs frozen original (issue 1559 rule)");
  // The generalized path runs the same arithmetic as the shared one: byte for byte.
  const { out } = generalized(dateAxis, result, extras);
  const sharedObj = JSON.parse(shared) as Record<string, Record<string, unknown>>;
  for (const [p, strategies] of Object.entries(out)) {
    for (const [s, m] of Object.entries(strategies)) expect(JSON.stringify(m)).toBe(JSON.stringify(sharedObj[p]![s]));
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
    // D78: each day's return is the exact weighted sum rounded once, and each
    // value the exact product of the (1 + return) factors rounded once.
    const legs = (a0: number, a1: number, b0: number, b1: number) => exactDot([0.5, 0.25, 0.25], [a1 / a0 - 1, b1 / b0 - 1, 0]);
    const r = [legs(100, 110, 50, 50), legs(110, 99, 50, 55), legs(99, 99, 55, 55), legs(99, 108.9, 55, 55)];
    expect(r[1]).toBe(0.5 * (99 / 110 - 1) + 0.25 * (55 / 50 - 1));
    const values = [1, ...r.map((_, k) => exactCompound(r.slice(0, k + 1)))];
    expect(sim.values.map((p) => p.value)).toEqual(values);
    expect(sim.returns).toEqual(r.map((value, i) => ({ date: axis[i + 1]!, value })));
    expect(sim.trades).toEqual([]);
    expect(sim.startDate).toBe(axis[0]);
    expect(sim.endDate).toBe(axis[4]);
  });

  test("cash accrues the previous date's annual percent yield over 365 days; missing earlier yields earn zero", () => {
    const rate = pts(axis, [undefined, 3.65, undefined, 5, undefined]);
    const sim = simulatePortfolio(axis, axis.map(() => ({ cash: 1 })), {}, rate);
    // D78: (1 + y)^(1/365) - 1 as expm1(log1p(y) / 365), which keeps the leading
    // digits the pow form loses to the final "- 1".
    const d = (y: number) => Math.expm1(Math.log1p(y / 100) / 365);
    for (const y of [3.65, 5]) expect(Math.abs(d(y) - (Math.pow(1 + y / 100, 1 / 365) - 1))).toBeLessThan(1e-16);
    // day 1 uses day 0's yield (none yet: 0); day 2 uses 3.65; day 3 uses 3.65 (forward-filled); day 4 uses 5.
    const r = [d(0), d(3.65), d(3.65), d(5)];
    expect(sim.values.map((p) => p.value)).toEqual([1, ...r.map((_, k) => exactCompound(r.slice(0, k + 1)))]);
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
    // D78: the exact product of every growth and cost factor so far, rounded once.
    const cost = new Q(1n).sub(Q.of(0.5).mul(Q.of(0.001)));
    const f: Q[] = [];
    const exp = [1];
    f.push(onePlus(110 / 100 - 1)); exp.push(exactProduct(f));
    f.push(onePlus(99 / 110 - 1), cost); exp.push(exactProduct(f));
    f.push(onePlus(0.5 * (99 / 99 - 1))); exp.push(exactProduct(f));
    f.push(onePlus(0.5 * (108.9 / 99 - 1)), cost); exp.push(exactProduct(f));
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
    // D78: the cost multiplies the unrounded equity, so the value is the exact
    // product of every growth factor and the cost factor, rounded once.
    const growth = a.returns.slice(0, 4).map((r) => onePlus(r.value));
    expect(b.values[4]!.value).toBe(exactProduct([...growth, new Q(1n).sub(Q.of(0.5).mul(Q.of(0.001)))]));
    expect(a.values[4]!.value).toBe(exactProduct(growth));
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
    // The pinned pre-refactor bytes were computed under methodology v3 (labels
    // cut on the rolling percentile), so this run is v3 (issue 1652).
    // The pinned bytes are also from the two-panel composite (before issue 1708).
    const run = runRegime(raw, { version: "v3", panels: ["macro", "onchain"] });
    const out = threeWay(run.dateAxis, run.result, extras);
    // Pinned bytes of the pre-refactor output, daily values included (main 408cd875, computed from the unmodified main checkout).
    // The frozen reference still produces them; the shared output matches it up to rounding (D78).
    expect(sha(JSON.stringify(originalBacktest(run.dateAxis, run.result, extras)))).toBe("ee9a3019dbfb8ff98a58af2db337e361273415db127fa314ba8b0e8b5df8d2cf");
    expect(out.eth!.eth_hodl!.n_days).toBeGreaterThan(1000);
    expect(Object.keys(out.mixed!)).toContain("blend_hodl");
  });

  test("fixture, three-panel (factor) result is byte-identical on all three paths", () => {
    const run = runRegime(raw, { factor: true });
    threeWay(run.dateAxis, run.factor!, extras);
  });

  // Issue 1652: the composite strategy trades result.regime, which since v4 is
  // the label cut on the composite itself, never on its rolling percentile.
  test("the composite strategy reads result.regime cut on the composite (v4)", async () => {
    const { bucketFn, smoothRegimes } = await import("../src/analyze/compute.ts");
    const run = runRegime(raw);
    expect(run.version).toBe("v4");
    expect(run.result.regime).toEqual(smoothRegimes(run.result.composite, bucketFn));
    const out = threeWay(run.dateAxis, run.result, extras);
    // The composite line is the schedule from those labels, nothing else.
    const cutOnComposite = { ...run.result, regime: smoothRegimes(run.result.composite, bucketFn) } as RegimeComputeResult;
    expect(JSON.stringify(computeBacktest(run.dateAxis, cutOnComposite, extras).eth!.composite)).toBe(JSON.stringify(out.eth!.composite));
    // Non-vacuity: labels cut on the percentile give another composite line.
    const cutOnRank = { ...run.result, regime: smoothRegimes(run.result.compositePercentile, bucketFn) } as RegimeComputeResult;
    expect(JSON.stringify(computeBacktest(run.dateAxis, cutOnRank, extras).eth!.composite)).not.toBe(JSON.stringify(out.eth!.composite));
    for (const p of run.result.panels) expect(run.result.panelRegimes[p]).toEqual(smoothRegimes(run.result.panelIndices[p]!, bucketFn));
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

  test("blend_hodl is a fixed-target daily calculation with no reset cost; one start per market", () => {
    const eth = pts(axis, axis.map((_, i) => (i < 40 ? undefined : wave(i, 2000, 300, 17))));
    const spx = pts(axis, axis.map((_, i) => (i < 10 ? undefined : wave(i, 4000, 200, 23))));
    const tbill = pts(axis, axis.map((_, i) => (i % 5 === 0 ? 4 + (i % 3) * 0.1 : undefined)));
    const regime = axis.map((_, i) => (i < 60 ? null : labelsAt(i)));
    const out = threeWay(axis, fakeResult(axis, regime), { spx, eth, tbill3m: tbill });
    // Issue 1559: baselines start with the strategies, on the first labelled date.
    for (const market of Object.values(out)) for (const m of Object.values(market)) expect(m.start_date).toBe(axis[60]);
    expect(out.mixed!.blend_hodl!.equity_curve[0]).toEqual({ date: axis[60]!, value: 1 });
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
    // D78: the reported Sharpe is the exact Sharpe of the pre-cost returns, rounded once.
    const sharpeOf = (xs: number[]) => exactSharpe(xs, 365);
    expect(out.eth!.composite!.sharpe).toBe(sharpeOf(pre));
    const net = sim.values.slice(1).map((p, i) => p.value / sim.values[i]!.value - 1);
    expect(sharpeOf(net)).not.toBe(out.eth!.composite!.sharpe);
  });
});

describe("scheduleFromLabels", () => {
  const t = PORTFOLIO_SPECS.eth!.weights;

  test("UNKNOWN_LABEL_RULE is refuse: a label with no own row throws a RangeError naming the label and its index", () => {
    expect(UNKNOWN_LABEL_RULE).toBe("refuse");
    expect(() => scheduleFromLabels(["risk_on", "risk-on", null], t)).toThrow(RangeError);
    expect(() => scheduleFromLabels(["risk_on", "risk-on", null], t)).toThrow('scheduleFromLabels: label "risk-on" at index 1 has no weight row');
    // An own-row check: an inherited name has no row.
    expect(() => scheduleFromLabels(["toString"], t)).toThrow('label "toString" at index 0');
    expect(() => scheduleFromLabels(["risk_on", null, "neutral", "bogus"], t, { unknownLabel: "refuse" })).toThrow('label "bogus" at index 3');
  });

  test("unknownLabel skip: a label with no row is a skipped day, as on main", () => {
    expect(scheduleFromLabels(["risk_on", "risk-on", null], t, { unknownLabel: "skip" })).toEqual([t.risk_on!, null, null]);
    expect(scheduleFromLabels(["risk_on", null, "neutral", "bogus", "toString"], t, { unknownLabel: "skip" })).toEqual([t.risk_on!, null, t.neutral!, null, null]);
  });

  test("a null label is a skipped day under either rule", () => {
    expect(scheduleFromLabels(["risk_on", null], t)).toEqual([t.risk_on!, null]);
    expect(scheduleFromLabels(["risk_on", null], t, { unknownLabel: "skip" })).toEqual([t.risk_on!, null]);
  });

  test("an unknown option or rule is a RangeError", () => {
    expect(() => scheduleFromLabels(["risk_on"], t, { unknownLabel: "ignore" as never })).toThrow(RangeError);
    expect(() => scheduleFromLabels(["risk_on"], t, { onUnknown: "skip" } as never)).toThrow(RangeError);
  });
});

simulatorFillCases("simulatePortfolio", simulatePortfolio);

describe("simulatePortfolio: the shipped default fill reproduces the undeclared carry", () => {
  test("DEFAULT_SIMULATOR_FILL is forward with no age limit", () => {
    expect(DEFAULT_SIMULATOR_FILL).toEqual({ kind: "forward", maxAgeDays: null, reason: "Reproduces the undeclared carry" });
  });
});

// Issue 1554: the reference backtest's label shape, its strategy grid and its
// declared fill policies, on the committed fixture.
describe("reference backtest: label shape, referenceStrategies and fill policies (issue 1554)", () => {
  const raw = toHistory(parseRawHistory(readFileSync(join(DIR, "fixtures/raw-indicator-history.csv"), "utf8")));
  const extras: BacktestExtras = { spx: raw.SPX!, eth: raw.ETH!, tbill3m: raw.TBILL3M! };
  const run = runRegime(raw);
  const shipped = computeBacktest(run.dateAxis, run.result, extras);
  const changedFill = {
    spx: forward(4),
    eth: NONE,
    tbill3m: forward(4),
  };

  test("computeBacktest over { regime, panelRegimes, panels } deep-equals it over the full result; referenceStrategies keys", () => {
    const { regime, panelRegimes, panels } = run.result;
    expect(computeBacktest(run.dateAxis, { regime, panelRegimes, panels }, extras)).toEqual(shipped);
    expect(computeBacktest(run.dateAxis, { regime, panelRegimes }, extras)).toEqual(shipped);
    expect(Object.keys(referenceStrategies(run.result))).toEqual(["composite", "macro", "onchain", "factor", "macro_inverted", "conservative", "aggressive"]);
    expect(referenceStrategies(run.result).composite).toEqual(run.result.regime);
  });

  test("REFERENCE_FILL_POLICIES are forward with no age limit; computeBacktest equals the golden backtest section", async () => {
    for (const k of ["spx", "eth", "tbill3m"] as const) {
      expect(REFERENCE_FILL_POLICIES[k]).toEqual({ kind: "forward", maxAgeDays: null, reason: "Reproduces the published backtest" });
    }
    expect(Object.keys(REFERENCE_FILL_POLICIES)).toEqual(["spx", "eth", "tbill3m"]);
    const golden = JSON.parse(await Bun.file(join(DIR, "golden/regime-report.json")).text());
    expect(JSON.stringify(stripDailyFromSnapshot(shipped), null, 2)).toBe(JSON.stringify(golden.backtest, null, 2));
    expect(computeBacktestWithFill(run.dateAxis, run.result, extras, REFERENCE_FILL_POLICIES)).toEqual(shipped);
  });

  test("a changed reference policy takes effect: each market ends on its latest complete day and equals the original cut there", () => {
    const changed = computeBacktestWithFill(run.dateAxis, run.result, extras, changedFill);
    const ends: Record<string, string> = { eth: "2026-06-29", mixed: "2026-06-29", sp500: "2026-07-03" };
    for (const [market, end] of Object.entries(ends)) {
      for (const m of Object.values(changed[market]!)) expect(m.end_date).toBe(end);
      const cut = run.dateAxis.findIndex((d) => d === end) + 1;
      const axis = run.dateAxis.slice(0, cut);
      const panelRegimes = Object.fromEntries(Object.entries(run.result.panelRegimes).map(([p, l]) => [p, l.slice(0, cut)]));
      const labels = { ...run.result, regime: run.result.regime.slice(0, cut), panelRegimes } as RegimeComputeResult;
      const original = apply1559(originalBacktest(axis, labelsFromMarketStart(labels), extras))[market];
      expectSameUpToRounding(JSON.stringify(changed[market]), JSON.stringify(original), `${market} cut at ${end}`);
      // Non-vacuity: the changed policies change the market's lines.
      expect(JSON.stringify(changed[market])).not.toBe(JSON.stringify(shipped[market]));
    }
    expect(Object.keys(changed)).toEqual(Object.keys(shipped));
  });

  test("a missing, unknown or invalid reference policy is a RangeError", () => {
    expect(() => computeBacktestWithFill(run.dateAxis, run.result, extras, { spx: forward(null), eth: forward(null) } as never)).toThrow(/tbill3m/);
    expect(() => computeBacktestWithFill(run.dateAxis, run.result, extras, { ...REFERENCE_FILL_POLICIES, btc: forward(null) } as never)).toThrow(/btc/);
    expect(() => computeBacktestWithFill(run.dateAxis, run.result, extras, { ...REFERENCE_FILL_POLICIES, eth: { kind: "forward", maxAgeDays: 0, reason: "r" } })).toThrow(RangeError);
  });

  test("a market with no complete day at or after its first priced date is left out", () => {
    // ETH (none) is priced on day 2 only; the cash rate (none) has a value on day 0 only.
    // No day has both, so eth and mixed are left out; sp500 (priced every day) ends on day 0.
    const axis = axisOf(5);
    const res = fakeResult(axis, axis.map(() => "risk_on"));
    const ext: BacktestExtras = { spx: pts(axis, [1, 2, 3, 4, 5]), eth: pts(axis, [undefined, undefined, 7]), tbill3m: pts(axis, [4]) };
    const fill = { spx: NONE, eth: NONE, tbill3m: NONE };
    const out = computeBacktestWithFill(axis, res, ext, fill);
    expect(Object.keys(out)).toEqual(["sp500"]);
    expect(out.sp500!.composite!.end_date).toBe(axis[0]);
    // Under the reference policies every market runs to the last axis date.
    const ref = computeBacktestWithFill(axis, res, ext, REFERENCE_FILL_POLICIES);
    expect(Object.keys(ref)).toEqual(["eth", "sp500", "mixed"]);
    for (const m of Object.values(ref)) expect(m.composite!.end_date).toBe(axis[4]);
  });
});

// Issue 1733: the backtest reads labels computed by knowledge time. Revisions of
// ICSA known a week after each first release (together with the next week's
// first release) never reach a past day, so the backtest equals the one on the
// first-release values; a run that reads the revisions by period date differs.
describe("revision-at-asof selection (issue 1733)", () => {
  const raw = toHistory(parseRawHistory(readFileSync(join(DIR, "fixtures/raw-indicator-history.csv"), "utf8")));
  const revise = (v: number, i: number) => v * (i % 2 ? 1.5 : 0.6);
  const icsaKnown = (date: string) => {
    // ICSA is published the Thursday after its Saturday; the revision a week later.
    const t = Date.parse(`${date}T00:00:00Z`) + (5 + 7) * 86_400_000;
    return `${new Date(t).toISOString().slice(0, 10)}T13:30:00Z`;
  };
  const revised = { ...raw, ICSA: [...raw.ICSA!, ...raw.ICSA!.map((p, i) => ({ date: p.date, value: revise(p.value, i), known: icsaKnown(p.date) }))] };
  const leaked = { ...raw, ICSA: raw.ICSA!.map((p, i) => ({ date: p.date, value: revise(p.value, i) })) };

  test("given a revised fixture, the backtest uses the value known at each as-of day, not the later revision", () => {
    const first = runRegime(raw);
    const withRevisions = runRegime(revised);
    expect(withRevisions.backtest).toBeDefined();
    expect(JSON.stringify(withRevisions.backtest)).toBe(JSON.stringify(first.backtest));
    expect(JSON.stringify(withRevisions.result.regime)).toBe(JSON.stringify(first.result.regime));
    // Non-vacuity: reading the revisions by period date changes the regime.
    expect(JSON.stringify(runRegime(leaked).result.signed.ICSA)).not.toBe(JSON.stringify(first.result.signed.ICSA));
  });
});

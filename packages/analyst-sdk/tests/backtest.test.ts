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
  simulatePortfolio as simulateWithDefaults,
  discountToYield,
  REFERENCE_CALENDARS,
  calendarsOf,
  SparseSeriesError,
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

// The hand-calculated cases below test the arithmetic of a schedule's weights as
// given, held from the same close: no execution lag, every market open (issue
// 1734 tests the lag and the calendars in their own describe blocks).
const simulatePortfolio: typeof simulateWithDefaults = (a, s, p, c, o = {}) =>
  simulateWithDefaults(a, s, p, c, { lagSessions: 0, calendars: Object.fromEntries(Object.keys(p).map((k) => [k, "continuous" as const])), ...o });
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
      const sim = simulateWithDefaults(dateAxis, start < 0 ? s : s.map((w, i) => (i < start ? null : w)), prices, extras.tbill3m, { calendars: calendarsOf(spec.risky) });
      return periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
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
  // The frozen original is the same-close, pre-cost-Sharpe, discount-quote
  // calculation: issue 1734 changed all three, so only its structure is compared.
  const original = apply1559(originalBacktest(dateAxis, labelsFromMarketStart(result), extras));
  const shared = JSON.stringify(computeBacktest(dateAxis, result, extras));
  expect(Object.keys(JSON.parse(shared))).toEqual(Object.keys(original));
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

  test("cash accrues the previous date's DTB3 quote as a bond-equivalent yield over 365 days; missing earlier quotes earn zero", () => {
    const rate = pts(axis, [undefined, 3.65, undefined, 5, undefined]);
    const sim = simulatePortfolio(axis, axis.map(() => ({ cash: 1 })), {}, rate);
    // D78: (1 + y)^(1/365) - 1 as expm1(log1p(y) / 365), which keeps the leading
    // digits the pow form loses to the final "- 1".
    const d = (q: number) => Math.expm1(Math.log1p(discountToYield(q) / 100) / 365);
    for (const y of [3.65, 5]) expect(Math.abs(d(y) - (Math.pow(1 + discountToYield(y) / 100, 1 / 365) - 1))).toBeLessThan(1e-16);
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
    const full = () => JSON.stringify(periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades }));
    const before = full();
    const w = periodStats(sim.values, axis[2]!, axis[6]!, { returns: sim.returns, excess: sim.excess, trades: sim.trades, splitDate: axis[4]! });
    expect(full()).toBe(before);
    expect(w.start_date).toBe(axis[2]);
    expect(w.end_date).toBe(axis[6]);
    expect(w.n_days).toBe(4);
    expect(w.transitions).toBe(2);
    expect(w.final_value).toBe(sim.values[6]!.value / sim.values[2]!.value);
    expect(() => periodStats(sim.values, axis[6]!, axis[2]!, { returns: sim.returns, excess: sim.excess })).toThrow(RangeError);
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
    // Issue 1559: baselines start with the strategies, on the first labelled date plus the one-session lag (issue 1734).
    for (const market of Object.values(out)) for (const m of Object.values(market)) expect(m.start_date).toBe(axis[61]);
    expect(out.mixed!.blend_hodl!.equity_curve[0]).toEqual({ date: axis[61]!, value: 1 });
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
    // (Two days: the first label trades on day 1, one session later.)
    const one = axisOf(2);
    const single = threeWay(one, fakeResult(one, ["risk_on", "risk_on"]), { spx: pts(one, [1, 1]), eth: pts(one, [1, 1]), tbill3m: [] });
    expect(single.eth!.composite!.cagr).toBe(0);
    expect(single.eth!.composite!.cagr_in_sample).toBe(0);
    expect(single.eth!.composite!.cagr_out_sample).toBeNull();
  });

  test("cost-bearing path: Sharpe is the exact Sharpe of post-cost daily returns in excess of cash (issue 1734)", () => {
    const eth = pts(axis, axis.map((_, i) => wave(i, 2000, 300, 11)));
    const spx = pts(axis, axis.map((_, i) => wave(i, 4000, 200, 13)));
    const res = fakeResult(axis, axis.map((_, i) => labelsAt(i)));
    const out = threeWay(axis, res, { spx, eth, tbill3m: [] });
    expect(out.eth!.composite!.transitions).toBeGreaterThan(5);
    const sim = simulateWithDefaults(axis, scheduleFromLabels(res.regime, PORTFOLIO_SPECS.eth!.weights), { eth }, [], { calendars: calendarsOf(["eth"]) });
    // No cash yield here, so excess = post-cost return. The net daily return is the
    // value ratio on days with a return, so it matches excess to rounding.
    const net = sim.values.slice(1).map((p, i) => p.value / sim.values[i]!.value - 1);
    const ex = sim.excess.map((p) => p.value);
    expect(ex.length).toBe(net.length);
    for (let i = 0; i < ex.length; i++) expect(Math.abs(ex[i]! - net[i]!)).toBeLessThan(1e-12);
    expect(out.eth!.composite!.sharpe).toBe(exactSharpe(ex, 365));
    // Non-vacuity: costs lower it against the pre-cost returns.
    expect(exactSharpe(sim.returns.map((r) => r.value), 365)).not.toBe(out.eth!.composite!.sharpe);
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
      expect(Object.keys(changed[market]!)).toEqual(Object.keys(original!));
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

// Issue 1734: execution lag, market calendars, excess Sharpe, cash yield basis,
// per-asset costs, sample blocks and daily-only statistics.
describe("execution lag and market calendars (issue 1734)", () => {
  test("a target set at day i's close trades no earlier than the next session", () => {
    const axis = axisOf(8);
    const A = pts(axis, [100, 101, 102, 103, 104, 105, 106, 107]);
    const sched: Schedule = axis.map((_, i): Record<string, number> => (i < 3 ? { cash: 1 } : { A: 1 }));
    const sim = simulateWithDefaults(axis, sched, { A }, []);
    // The target changes at day 3's close; the trade is at day 4's close, never day 3's.
    expect(sim.trades.map((t) => t.date)).toEqual([axis[4]!]);
    // Day 4 still earned cash (no price move); day 5 is the first day in A.
    expect(sim.returns.find((r) => r.date === axis[4])!.value).toBe(0);
    expect(sim.returns.find((r) => r.date === axis[5])!.value).toBe(105 / 104 - 1);
    // lagSessions 0 is the same-close execution the lag replaces.
    const same = simulateWithDefaults(axis, sched, { A }, [], { lagSessions: 0 });
    expect(same.trades.map((t) => t.date)).toEqual([axis[3]!]);
    expect(same.returns.find((r) => r.date === axis[4])!.value).toBe(104 / 103 - 1);
  });

  test("a weekend label change defers the SPX trade to the next open session; ETH trades through the weekend", () => {
    const axis = axisOf(14); // 2024-01-01 is a Monday
    const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() % 6 !== 0;
    const spxPts = pts(axis, axis.map((d, i) => (weekday(d) ? 4000 + i : undefined)));
    const ethPts = pts(axis, axis.map((_, i) => 2000 + i));
    // Risk-on from Saturday 2024-01-06 (index 5).
    const sched: Schedule = axis.map((_, i): Record<string, number> => (i < 5 ? { cash: 1 } : { cash: 0, sp500: 1 }));
    const sp = simulateWithDefaults(axis, sched, { sp500: spxPts }, []);
    expect(sp.trades.map((t) => t.date)).toEqual(["2024-01-08"]); // Monday, not Saturday or Sunday
    const eth = simulateWithDefaults(axis, axis.map((_, i): Record<string, number> => (i < 5 ? { cash: 1 } : { cash: 0, eth: 1 })), { eth: ethPts }, []);
    expect(eth.trades.map((t) => t.date)).toEqual(["2024-01-07"]); // Sunday: the next session of a 24/7 market
    // A mixed book waits for the SPX leg: no partial trade into a closed market.
    const mixed = simulateWithDefaults(axis, axis.map((_, i): Record<string, number> => (i < 5 ? { cash: 1 } : { eth: 0.5, sp500: 0.5 })), { eth: ethPts, sp500: spxPts }, []);
    expect(mixed.trades.map((t) => t.date)).toEqual(["2024-01-08"]);
    // The reference backtest declares ETH 24/7 and the S&P 500 as observed.
    expect(REFERENCE_CALENDARS).toEqual({ eth: "continuous", sp500: "observed" });
  });

  test("a bad lag or calendar is a RangeError", () => {
    const axis = axisOf(3);
    const A = pts(axis, [1, 2, 3]);
    const run = (o: object) => simulateWithDefaults(axis, axis.map(() => ({ A: 1 })), { A }, [], o as never);
    expect(() => run({ lagSessions: -1 })).toThrow(RangeError);
    expect(() => run({ lagSessions: 1.5 })).toThrow(RangeError);
    expect(() => run({ calendars: { A: "tuesdays" } })).toThrow(RangeError);
    expect(() => run({ calendars: { Z: "continuous" } })).toThrow(RangeError);
  });
});

describe("Sharpe, cash basis, costs and daily series (issue 1734)", () => {
  const axis = axisOf(60);

  test("an all-cash portfolio reports a Sharpe of 0 even as the T-bill rate moves", () => {
    const tbill = pts(axis, axis.map((_, i) => 4 + 0.05 * (i % 7)));
    const sim = simulateWithDefaults(axis, axis.map(() => ({ cash: 1 })), {}, tbill);
    expect(sim.excess.every((p) => p.value === 0)).toBe(true);
    const st = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
    expect(st.sharpe).toBe(0);
    // Pre-cost returns would have scored a Sharpe from the moving rate.
    expect(exactSharpe(sim.returns.map((r) => r.value), 365)).not.toBe(0);
  });

  test("excess on a trade day is the post-cost return minus that day's cash return", () => {
    const A = pts(axis, axis.map((_, i) => 100 + i));
    const sched: Schedule = axis.map((_, i): Record<string, number> => (i < 10 ? { cash: 1 } : { A: 1 }));
    const tbill = pts(axis, axis.map(() => 5));
    const sim = simulateWithDefaults(axis, sched, { A }, tbill, { lagSessions: 0 });
    const cash = Math.expm1(Math.log1p(discountToYield(5) / 100) / 365);
    const t = sim.trades[0]!;
    const ret = sim.returns.find((r) => r.date === t.date)!.value;
    expect(ret).toBe(cash);
    expect(sim.excess.find((r) => r.date === t.date)!.value).toBeCloseTo((1 + ret) * (1 - t.cost) - 1 - cash, 15);
    expect(sim.excess.find((r) => r.date === t.date)!.value).toBeLessThan(0);
  });

  test("the cash leg uses the bond-equivalent yield of the DTB3 discount quote", () => {
    // d = 5%: 365 x 0.05 / (360 - 91 x 0.05) = 5.134336756224505 percent.
    expect(discountToYield(5)).toBeCloseTo(5.134336756224505, 12);
    expect(discountToYield(0)).toBe(0);
    const sim = simulateWithDefaults(axisOf(3), axisOf(3).map(() => ({ cash: 1 })), {}, pts(axisOf(3), [5, 5, 5]));
    expect(sim.returns[0]!.value).toBeCloseTo(Math.expm1(Math.log1p(0.05134336756224505) / 365), 15);
    expect(sim.returns[0]!.value).toBeGreaterThan(Math.expm1(Math.log1p(0.05) / 365));
  });

  test("costBps takes a per-asset map: two assets pay different costs", () => {
    const A = pts(axis, axis.map((_, i) => 100 + i));
    const B = pts(axis, axis.map((_, i) => 50 + i));
    const sched: Schedule = axis.map((_, i): Record<string, number> => (i < 5 ? { cash: 1 } : { A: 0.5, B: 0.5 }));
    const sim = simulateWithDefaults(axis, sched, { A, B }, [], { lagSessions: 0, costBps: { A: 10, B: 40 } });
    expect(sim.trades).toHaveLength(1);
    expect(sim.trades[0]!.turnover).toBe(0.5 + 0.5);
    expect(sim.trades[0]!.cost).toBeCloseTo(0.5 * 0.001 + 0.5 * 0.004, 15);
    // An asset with no entry pays the 10 bps default; a number is unchanged.
    const dflt = simulateWithDefaults(axis, sched, { A, B }, [], { lagSessions: 0, costBps: { B: 40 } });
    expect(dflt.trades[0]!.cost).toBeCloseTo(0.5 * 0.001 + 0.5 * 0.004, 15);
    const num = simulateWithDefaults(axis, sched, { A, B }, [], { lagSessions: 0, costBps: 10 });
    expect(num.trades[0]!.cost).toBeCloseTo(1 * 0.001, 15);
    expect(() => simulateWithDefaults(axis, sched, { A, B }, [], { costBps: { A: -1 } })).toThrow(RangeError);
  });

  test("periodStats refuses a value series sparser than daily, and says which gap", () => {
    const sim = simulateWithDefaults(axis, axis.map(() => ({ cash: 1 })), {}, []);
    const weekly = sim.values.filter((_, i) => i % 7 === 0);
    const opts = { returns: sim.returns, excess: sim.excess };
    expect(() => periodStats(weekly, weekly[0]!.date, weekly[weekly.length - 1]!.date, opts)).toThrow(SparseSeriesError);
    expect(() => periodStats(weekly, weekly[0]!.date, weekly[weekly.length - 1]!.date, opts)).toThrow(/median gap is 7 days/);
    expect(() => periodStats(sim.values, sim.startDate, sim.endDate, opts)).not.toThrow();
  });

  test("periodStats reports labelled in-sample and out-of-sample blocks split at the adoption date", () => {
    const ax = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)); // from 2026-10-01
    const A = pts(ax, ax.map((_, i) => 100 + i + 5 * Math.sin(i)));
    const sim = simulateWithDefaults(ax, ax.map(() => ({ A: 1 })), { A }, []);
    const st = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
    expect(st.sample_split_date).toBe(BACKTEST_IN_SAMPLE_END);
    expect(st.in_sample.label).toBe("in_sample");
    expect(st.out_of_sample.label).toBe("out_of_sample");
    expect(st.in_sample.end_date! <= BACKTEST_IN_SAMPLE_END).toBe(true);
    expect(st.out_of_sample.start_date! > BACKTEST_IN_SAMPLE_END).toBe(true);
    expect(st.in_sample.n_days + st.out_of_sample.n_days).toBe(st.n_days);
    expect(st.in_sample.n_days).toBeGreaterThan(30);
    expect(st.out_of_sample.n_days).toBeGreaterThan(30);
    // A split before the window leaves no in-sample block.
    const early = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, splitDate: "2020-01-01" });
    expect(early.in_sample.n_days).toBe(0);
    expect(early.in_sample.cagr).toBeNull();
  });
});

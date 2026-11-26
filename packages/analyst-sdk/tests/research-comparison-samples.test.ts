// Issue 1734 (D94): the weighting and regime-equal research comparisons report
// labelled in-sample and out-of-sample blocks split at the adoption date, on
// every strategy line, and the lines are finite and priced after the label lag.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { computeWeightingComparison } from "../src/research/legacy/weighting-comparison.ts";
import { computeRegimeEqComparison } from "../src/research/legacy/regime-eq-comparison.ts";
import { BACKTEST_IN_SAMPLE_END, splitSamples } from "../src/analyze/backtest.ts";
import { CONSTANT_CASH_YR } from "../src/research/legacy/weighting-comparison.ts";
import { CASH_YR } from "../src/research/legacy/regime-eq-comparison.ts";
import { periodicRate } from "../src/transform/exact.ts";
import { CURRENT_REGIME_VERSION, adoptionDate } from "../src/analyze/regime-versions.ts";

setDefaultTimeout(240_000);
const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));
const extras = { eth: raw.ETH!, spx: raw.SPX! };

// Every object that carries a sample split, with its path.
function lines(x: unknown, path = "$", out: [string, Record<string, any>][] = []): [string, Record<string, any>][] {
  if (x && typeof x === "object") {
    if ("sample_split_date" in (x as object)) out.push([path, x as Record<string, any>]);
    for (const [k, v] of Object.entries(x as object)) lines(v, `${path}.${k}`, out);
  }
  return out;
}

function checkBlocks(found: [string, Record<string, any>][]) {
  expect(found.length).toBeGreaterThan(10);
  for (const [path, m] of found) {
    expect(m.sample_split_date, path).toBe(BACKTEST_IN_SAMPLE_END);
    expect(m.sample_split_date, path).toBe(adoptionDate(CURRENT_REGIME_VERSION));
    expect(m.in_sample.label, path).toBe("in_sample");
    expect(m.out_of_sample.label, path).toBe("out_of_sample");
    expect(m.in_sample.end_date <= m.sample_split_date, path).toBe(true);
    if (m.out_of_sample.start_date !== null) expect(m.out_of_sample.start_date > m.sample_split_date, path).toBe(true);
    // The fixture ends before the adoption date: all of it is in sample, none out of sample.
    expect(m.in_sample.n_days, path).toBeGreaterThan(100);
    expect(m.out_of_sample.n_days, path).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(m.sharpe), path).toBe(true);
    expect(Number.isFinite(m.in_sample.sharpe), path).toBe(true);
  }
}

describe("research comparisons report labelled sample blocks (issue 1734)", () => {
  const asof = raw.SPX![raw.SPX!.length - 1]!.date;

  test("weighting comparison: every method and strategy line", () => {
    const r = computeWeightingComparison({ raw, snapAsof: asof, extras });
    checkBlocks(lines(r.methods));
  });

  test("regime-equal comparison: every portfolio and strategy line", () => {
    const r = computeRegimeEqComparison({ raw, extras });
    checkBlocks(lines(r));
  });
});

// The ETH buy-and-hold line never trades, so its Sharpe is the Sharpe of the
// daily ETH return minus the constant cash return, rebuilt here from the inputs.
function ethHodlSharpe(cashYr: number): number {
  const maxDate = Object.values(raw).reduce((m, pts) => (pts.length && pts[pts.length - 1]!.date > m ? pts[pts.length - 1]!.date : m), "2018-01-01");
  const px = new Map(extras.eth.map((p) => [p.date, p.value]));
  const cash = periodicRate(cashYr, 365);
  const ex: number[] = [];
  let last: number | null = null;
  for (let t = Date.parse(`${extras.eth[0]!.date}T00:00:00Z`); t <= Date.parse(`${maxDate}T00:00:00Z`); t += 86_400_000) {
    const v: number | null = px.get(new Date(t).toISOString().slice(0, 10)) ?? last;
    if (last != null && v != null) ex.push(v / last - 1 - cash);
    last = v;
  }
  const mean = ex.reduce((a, b) => a + b, 0) / ex.length;
  const sd = Math.sqrt(ex.reduce((a, b) => a + (b - mean) ** 2, 0) / (ex.length - 1));
  return (mean * 365) / (sd * Math.sqrt(365));
}

describe("post-cost excess Sharpe in the research comparisons (issue 1734)", () => {
  const asof = raw.SPX![raw.SPX!.length - 1]!.date;

  test("weighting comparison: the ETH hold line's Sharpe is the Sharpe of its daily return minus the cash return", () => {
    const r = computeWeightingComparison({ raw, snapAsof: asof, extras });
    const hodl = r.methods.walk_forward!.eth.hodl;
    expect(Math.abs(hodl.sharpe - ethHodlSharpe(CONSTANT_CASH_YR))).toBeLessThan(1e-9);
    // Without the cash subtraction the figure would differ.
    expect(Math.abs(ethHodlSharpe(0) - hodl.sharpe)).toBeGreaterThan(1e-6);
  });

  test("regime-equal comparison: the same for its ETH hold line", () => {
    const r = computeRegimeEqComparison({ raw, extras });
    const found = lines(r).filter(([path]) => path.endsWith(".hodl") && path.includes(".eth"));
    expect(found.length).toBeGreaterThan(0);
    expect(Math.abs(found[0]![1].sharpe - ethHodlSharpe(CASH_YR))).toBeLessThan(1e-9);
  });

  test("a strategy line starts after its hold line: a label trades the day after it is known (one-day lag)", () => {
    const r = computeWeightingComparison({ raw, snapAsof: asof, extras });
    const m = r.methods.walk_forward!.eth;
    const start = (l: { equity_curve: { date: string }[] }) => l.equity_curve[0]!.date;
    expect(start(m.composite) > start(m.hodl)).toBe(true);
  });
});

describe("splitSamples on a series that crosses the adoption date (issue 1734)", () => {
  // 60 days from 2026-10-18; the split is 2026-11-17 (day 30). Value grows 1% a day, excess return is 1% less a 0.5% cash return.
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 9, 18 + i)).toISOString().slice(0, 10));
  const values = days.map((date, i) => ({ date, value: 1.01 ** i }));
  const excess = days.slice(1).map((date, i) => ({ date, value: i % 2 ? 0.015 : 0.005 }));

  test("both blocks are populated and their numbers asserted", () => {
    const s = splitSamples(values, excess);
    expect(s.sample_split_date).toBe("2026-11-17");
    expect(s.in_sample.start_date).toBe("2026-10-18");
    expect(s.in_sample.end_date).toBe("2026-11-17");
    expect(s.out_of_sample.start_date).toBe("2026-11-18");
    expect(s.out_of_sample.end_date).toBe(days[59]);
    expect(s.in_sample.n_days).toBe(30);
    expect(s.out_of_sample.n_days).toBe(29);
    expect(s.in_sample.max_drawdown).toBe(0);
    // Out of sample growth runs from the first value after the split (day 31) to the last (day 59): 1.01^28, over the years from the split.
    const yrs = (Date.parse(`${days[59]}T00:00:00Z`) - Date.parse("2026-11-17T00:00:00Z")) / (365.25 * 86_400_000);
    expect(s.out_of_sample.cagr!).toBeCloseTo(Math.expm1(Math.log(1.01 ** 28) / yrs), 6);
    // Excess alternates 0.005 and 0.015: mean 0.01, sample sd 0.005 x sqrt(n / (n - 1)).
    expect(s.in_sample.sharpe!).toBeGreaterThan(0);
    const xs = excess.filter((p) => p.date > "2026-11-17").map((p) => p.value);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    expect(s.out_of_sample.sharpe!).toBeCloseTo((mean * 365) / (sd * Math.sqrt(365)), 9);
  });
});

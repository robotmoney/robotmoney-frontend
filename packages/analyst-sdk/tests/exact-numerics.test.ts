// Proposed decision D78: the SDK's reductions are compensated, so on real data
// they return the correctly rounded exact value of the binary64 inputs. Every
// expectation here is an exact BigInt rational computation over the same
// doubles (support/exact-reference.ts), rounded once, never another
// floating-point code. Real data: the SPX and ETH closes and the indicator
// levels of the committed fixtures. Each family also asserts that the old
// plain loop misses the exact value on the same data, so these tests fail if
// the compensated code is swapped back for the plain one.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { mean, pearson, rollingBeta, rollingSum, sma, std, stddev } from "../src/transform/math.ts";
import { pearson as rankPearson, ranks } from "../src/analyze/correlations.ts";
import { rollingBetaSeries } from "../src/analyze/research-signals.ts";
import { periodStats, simulatePortfolio } from "../src/analyze/backtest.ts";
import { twoProd, twoSum } from "../src/transform/exact.ts";
import type { Point } from "../src/types.ts";
import {
  exactBeta,
  exactCompound,
  exactMean,
  exactPearson,
  exactSharpe,
  exactStd,
  exactSum,
  Q,
} from "./support/exact-reference.ts";

setDefaultTimeout(120_000);
const DIR = import.meta.dir;
const history = toHistory(parseRawHistory(readFileSync(join(DIR, "fixtures/raw-indicator-history.csv"), "utf8")));
const history8y = toHistory(parseRawHistory(readFileSync(join(DIR, "fixtures/allocate/raw-indicator-history-8y.csv"), "utf8")));

// Daily simple returns of a price series, by date.
function returnsOf(points: Point[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < points.length; i++) out.set(points[i]!.date, points[i]!.value / points[i - 1]!.value - 1);
  return out;
}
const spxR = returnsOf(history.SPX!);
const ethR = returnsOf(history.ETH!);
const common = [...spxR.keys()].filter((d) => ethR.has(d)).sort();
const SPX = common.map((d) => spxR.get(d)!);
const ETH = common.map((d) => ethR.get(d)!);
const ETH_ALL = [...ethR.values()];

// Indicator levels on the dates every one of them has a value (8-year fixture).
const LEVEL_IDS = ["VIX", "DXY", "T10Y2Y", "T5YIE", "DFII10", "XLU_SPY", "IWM_SPY", "COPPER_GOLD"];
const levelDates = [...new Set(history8y.VIX!.map((p) => p.date))]
  .filter((d) => LEVEL_IDS.every((id) => history8y[id]!.some((p) => p.date === d)))
  .sort();
const LEVELS = LEVEL_IDS.map((id) => {
  const m = new Map(history8y[id]!.map((p) => [p.date, p.value]));
  return levelDates.map((d) => m.get(d)!);
});

// The plain loops the SDK used before D78, for the "has teeth" checks.
const plainMean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function plainStd(xs: number[], ddof: number): number {
  const m = plainMean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - ddof));
}
function plainPearson(xs: number[], ys: number[]): number {
  const mx = plainMean(xs), my = plainMean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

describe("error-free primitives", () => {
  test("twoSum and twoProd are exact, checked in rationals on real returns", () => {
    for (let i = 1; i < 300; i++) {
      const a = ETH_ALL[i - 1]!, b = ETH_ALL[i]!;
      const [s, e] = twoSum(a, b);
      expect(Q.of(s).add(Q.of(e)).sub(Q.of(a)).sub(Q.of(b)).isZero()).toBe(true);
      const [p, pe] = twoProd(a, b);
      expect(Q.of(p).add(Q.of(pe)).sub(Q.of(a).mul(Q.of(b))).isZero()).toBe(true);
    }
  });
});

describe("mean, std, stddev and pearson equal the exact value on real data", () => {
  const series: [string, number[]][] = [["SPX returns", SPX], ["ETH returns", ETH], ["ETH all returns", ETH_ALL], ...LEVEL_IDS.map((id, i) => [`${id} levels`, LEVELS[i]!] as [string, number[]])];

  test("the fixtures are real and long", () => {
    expect(SPX.length).toBeGreaterThan(1000);
    expect(ETH_ALL.length).toBeGreaterThan(1500);
    expect(levelDates.length).toBeGreaterThan(1500);
  });

  for (const [name, xs] of series) {
    test(`${name}: mean, population std and sample stddev are correctly rounded`, () => {
      expect(mean(xs)).toBe(exactMean(xs));
      expect(std(xs)).toBe(exactStd(xs, 0));
      expect(stddev(xs)).toBe(exactStd(xs, 1));
    });
  }

  test("pearson of every pair of real series is correctly rounded", () => {
    const all = [SPX, ETH, ...LEVELS.map((l) => l.slice(0, SPX.length))];
    let pairs = 0;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(pearson(all[i]!, all[j]!)).toBe(exactPearson(all[i]!, all[j]!));
        pairs++;
      }
    }
    expect(pairs).toBe(45);
  });

  test("the rank pearson behind the Spearman correlations is correctly rounded", () => {
    for (const [a, b] of [[SPX, ETH], [LEVELS[0]!, LEVELS[1]!], [LEVELS[2]!, LEVELS[5]!]] as const) {
      const ra = ranks(a), rb = ranks(b);
      expect(rankPearson(ra, rb)).toBe(exactPearson(ra, rb));
    }
  });

  test("teeth: the plain loops miss the exact value on this same data", () => {
    const misses = series.filter(([, xs]) => plainMean(xs) !== exactMean(xs) || plainStd(xs, 0) !== exactStd(xs, 0) || plainStd(xs, 1) !== exactStd(xs, 1));
    expect(misses.length).toBeGreaterThan(0);
    let pearsonMisses = 0;
    for (let i = 0; i < LEVELS.length; i++) for (let j = i + 1; j < LEVELS.length; j++) if (plainPearson(LEVELS[i]!, LEVELS[j]!) !== exactPearson(LEVELS[i]!, LEVELS[j]!)) pearsonMisses++;
    expect(pearsonMisses).toBeGreaterThan(0);
  });
});

describe("pearson at any scale", () => {
  test("self-correlation is 1 at 1e150 and 1e-150 (plain dx*dy overflows to 0 and underflows to Infinity)", () => {
    for (const s of [1e150, 1e-150, 1e300, 1e-300]) {
      const a = [1, 2, 3, 4].map((x) => x * s);
      expect(exactPearson(a, a)).toBe(1);
      expect(pearson(a, a)).toBe(1);
      expect(rankPearson(a, a)).toBe(1);
      expect(std(a)).toBe(exactStd(a, 0));
      expect(stddev(a)).toBe(exactStd(a, 1));
    }
    const big = [1, 2, 3, 4].map((x) => x * 1e150);
    const tiny = [1, 2, 3, 4].map((x) => x * 1e-150);
    expect(plainPearson(big, big)).toBe(0);
    expect(plainPearson(tiny, tiny)).toBe(Infinity);
  });

  test("mixed scales and anti-correlation", () => {
    const a = [1, 2, 3, 4, 5].map((x) => x * 1e200);
    const b = [5, 3, 4, 1, 2].map((x) => x * 1e-200);
    expect(pearson(a, b)).toBe(exactPearson([1, 2, 3, 4, 5], [5, 3, 4, 1, 2]));
    expect(pearson(a, a.map((x) => -x))).toBe(-1);
  });
});

describe("edge-case contracts are unchanged", () => {
  test("mean, std, stddev", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, NaN])).toBeNaN();
    expect(mean([1, Infinity])).toBe(Infinity);
    expect(std([])).toBe(0);
    expect(std([5])).toBe(0);
    expect(std([1, NaN, 3])).toBeNaN();
    expect(stddev([5])).toBeNaN();
    expect(stddev([1, Infinity])).toBeNaN();
    expect(std([2, 2, 2])).toBe(0);
    expect(stddev([2, 2, 2])).toBe(0);
  });

  test("math.ts pearson: <3 finite pairs gives 0, zero variance gives 0, non-finite pairs are dropped", () => {
    expect(pearson([1, 2], [3, 4])).toBe(0);
    expect(pearson([1, 2, NaN, 4], [1, 2, 3, NaN])).toBe(0);
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
    expect(pearson([1, 2, NaN, 3, 4, Infinity], [2, 4, 5, 6, 8, 1])).toBe(exactPearson([1, 2, 3, 4], [2, 4, 6, 8]));
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6])).toBe(1);
  });

  test("correlations.ts pearson: n < 2 gives NaN, zero variance gives NaN", () => {
    expect(rankPearson([1], [1])).toBeNaN();
    expect(rankPearson([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(rankPearson([1, 2, 3], [3, 2, 1])).toBe(-1);
  });

  test("rollingBeta: 0 for zero x variance, the exact slope otherwise", () => {
    expect(rollingBeta([1, 2, 3], [5, 5, 5], 3)).toBe(0);
    expect(rollingBeta(ETH, SPX, 90)).toBe(exactBeta(SPX.slice(-90), ETH.slice(-90)));
  });
});

describe("sma and rollingSum: every window is the exact window sum, no running drift", () => {
  // The pre-D78 running loops, kept only to compare the missing-value contracts.
  function oldSma(xs: number[], n: number): number[] {
    const out = new Array(xs.length).fill(NaN);
    const minValid = Math.max(1, Math.floor(n / 2));
    let s = 0, c = 0;
    for (let i = 0; i < xs.length; i++) {
      if (Number.isFinite(xs[i])) { s += xs[i]!; c++; }
      if (i >= n && Number.isFinite(xs[i - n])) { s -= xs[i - n]!; c--; }
      if (i >= n - 1 && c >= minValid) out[i] = s / c;
    }
    return out;
  }
  function oldRollingSum(xs: number[], n: number): number[] {
    const out = new Array(xs.length).fill(NaN);
    let s = 0, bad = 0;
    for (let i = 0; i < xs.length; i++) {
      if (Number.isFinite(xs[i])) s += xs[i]!; else bad++;
      if (i >= n) { if (Number.isFinite(xs[i - n])) s -= xs[i - n]!; else bad--; }
      if (i >= n - 1 && bad === 0) out[i] = s;
    }
    return out;
  }

  for (const n of [7, 30, 200]) {
    test(`window ${n} over real ETH returns`, () => {
      const xs = ETH_ALL;
      const sums = rollingSum(xs, n);
      const avgs = sma(xs, n);
      for (let i = 0; i < xs.length; i++) {
        if (i < n - 1) {
          expect(sums[i]).toBeNaN();
          expect(avgs[i]).toBeNaN();
          continue;
        }
        const w = xs.slice(i - n + 1, i + 1);
        expect(sums[i]).toBe(exactSum(w));
        expect(avgs[i]).toBe(exactMean(w));
      }
    });
  }

  test("teeth: the running add/subtract loop drifts from the exact window sum on this data", () => {
    const xs = ETH_ALL;
    const old = oldRollingSum(xs, 200);
    let drift = 0;
    for (let i = 199; i < xs.length; i++) if (old[i] !== exactSum(xs.slice(i - 199, i + 1))) drift++;
    expect(drift).toBeGreaterThan(0);
  });

  test("missing values: sma averages the finite values it has; rollingSum needs a fully finite window", () => {
    const xs = [1, NaN, 3, 4, NaN, 6, 7, Infinity, 9, 10, 11];
    for (const n of [1, 2, 3, 4]) {
      const a = sma(xs, n), b = oldSma(xs, n);
      const c = rollingSum(xs, n), d = oldRollingSum(xs, n);
      expect(a.map(Number.isNaN)).toEqual(b.map(Number.isNaN));
      expect(c.map(Number.isNaN)).toEqual(d.map(Number.isNaN));
      for (let i = 0; i < xs.length; i++) {
        if (!Number.isNaN(b[i])) expect(a[i]).toBe(exactMean(xs.slice(Math.max(0, i - n + 1), i + 1).filter(Number.isFinite)));
        if (!Number.isNaN(d[i])) expect(c[i]).toBe(exactSum(xs.slice(i - n + 1, i + 1)));
      }
    }
    expect(sma([], 3)).toEqual([]);
    expect(rollingSum([1, 2], 3).every(Number.isNaN)).toBe(true);
  });
});

describe("rollingBetaSeries: every window is the exact OLS slope", () => {
  test("ETH on SPX returns, 90-day window", () => {
    const beta = rollingBetaSeries(ETH, SPX, 90);
    let checked = 0;
    for (let i = 89; i < ETH.length; i += 7) {
      expect(beta[i]).toBe(exactBeta(SPX.slice(i - 89, i + 1), ETH.slice(i - 89, i + 1)));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("gaps are skipped, a short window has no beta, a constant x has no beta", () => {
    const x = SPX.slice(0, 20), y = ETH.slice(0, 20);
    x[3] = NaN;
    y[7] = NaN;
    const b = rollingBetaSeries(y, x, 10);
    const keep = (lo: number, hi: number) => [...Array(hi - lo + 1).keys()].map((k) => k + lo).filter((j) => Number.isFinite(x[j]) && Number.isFinite(y[j]));
    const idx = keep(10, 19);
    expect(b[19]).toBe(exactBeta(idx.map((j) => x[j]!), idx.map((j) => y[j]!)));
    expect(rollingBetaSeries([1, 2, 3, 4], [1, NaN, NaN, NaN], 4)[3]).toBeNaN();
    expect(rollingBetaSeries([1, 2, 3, 4], [5, 5, 5, 5], 4)[3]).toBeNaN();
  });
});

describe("backtest: compounding, Sharpe and the constant-return regression", () => {
  const spxPoints = history.SPX!;
  const axis = spxPoints.map((p) => p.date);
  const sim = simulatePortfolio(axis, axis.map(() => ({ spx: 1 })), { spx: spxPoints }, []);
  const rets = sim.returns.map((p) => p.value);

  test("SPX buy-and-hold: every value is the exact product of (1 + r) rounded once", () => {
    expect(rets.length).toBe(spxPoints.length - 1);
    expect(sim.values.at(-1)!.value).toBe(exactCompound(rets));
    for (let k = 0; k < rets.length; k += 37) expect(sim.values[k + 1]!.value).toBe(exactCompound(rets.slice(0, k + 1)));
  });

  test("teeth: plain compounding misses the exact final value on this data", () => {
    let v = 1;
    for (const r of rets) v *= 1 + r;
    expect(v).not.toBe(exactCompound(rets));
  });

  test("periodStats Sharpe is the exact Sharpe of the pre-cost returns", () => {
    const st = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns });
    expect(st.sharpe).toBe(exactSharpe(rets, 365));
    expect(st.final_value).toBe(sim.values.at(-1)!.value);
  });

  test("a mixed portfolio with cash yield and rebalancing costs: Sharpe exact on its returns", () => {
    const tbill = history.TBILL3M!;
    const eth = history.ETH!;
    const sched = axis.map((_, i) => (i % 60 < 30 ? { spx: 0.5, eth: 0.3, cash: 0.2 } : { spx: 0.2, eth: 0.1, cash: 0.7 }));
    const m = simulatePortfolio(axis, sched, { spx: spxPoints, eth }, tbill);
    expect(m.trades.length).toBeGreaterThan(10);
    const st = periodStats(m.values, m.startDate, m.endDate, { returns: m.returns, trades: m.trades });
    expect(st.sharpe).toBe(exactSharpe(m.returns.map((p) => p.value), 365));
  });

  test("regression: 3,000 bit-identical returns have exact variance 0, so Sharpe is 0 (was 3.99e14)", () => {
    // 30% cash at a 5% yield, 70% in a flat asset: every daily return is the same double.
    const day = (i: number) => new Date(Date.UTC(1900, 0, i + 1)).toISOString().slice(0, 10);
    const ax = Array.from({ length: 3001 }, (_, i) => day(i));
    const c = simulatePortfolio(ax, ax.map(() => ({ cash: 0.3, flat: 0.7 })), { flat: ax.map((date) => ({ date, value: 1 })) }, [{ date: ax[0]!, value: 5 }]);
    const r = c.returns.map((p) => p.value);
    expect(r.length).toBe(3000);
    expect(new Set(r).size).toBe(1);
    expect(r[0]).toBeGreaterThan(0);
    expect(exactSharpe(r)).toBe(0);
    const st = periodStats(c.values, c.startDate, c.endDate, { returns: c.returns });
    expect(st.sharpe).toBe(0);
    // The old plain mean/variance made these returns look volatile.
    const m = plainMean(r);
    const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
    expect(v).toBeGreaterThan(0);
    expect((m * 365) / (Math.sqrt(v) * Math.sqrt(365))).toBeGreaterThan(1e12);
    // And the equity is the exact compounded product.
    expect(c.values.at(-1)!.value).toBe(exactCompound(r));
  });
});

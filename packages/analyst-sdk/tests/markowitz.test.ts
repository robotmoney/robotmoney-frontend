// Markowitz sizing, the point-in-time schedule and the backtest
// (src/allocate/markowitz.ts), and every tuning option of the schedule and the
// backtest. Real data: the committed SPX, ETH and DXY closes and the TBILL3M
// yield in tests/fixtures/raw-indicator-history.csv. The expected values come
// from the exported building blocks called directly (solvers, shrunkCov,
// simulatePortfolio, simulateDrift, periodStats), so each case checks that the
// workflow composes them without changing them.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { periodStats, simulateDrift, simulatePortfolio, type Schedule, type Weights } from "../src/analyze/backtest.ts";
import { dot2, sum2 } from "../src/transform/exact.ts";
import { correlationMatrix, type Mat } from "../src/transform/linalg.ts";
import { shrunkCov } from "../src/allocate/covariance.ts";
import { ercCertified, meanVarExact, meanVarResidual, minVarExact, sharpeResidual, tangencyExact } from "../src/allocate/optimize.ts";
import {
  canonZero, LAMBDA, markowitzBacktest, markowitzBooks, markowitzSchedule, markowitzSizing, MIN_OBS, ZERO_TOL,
  type MarkowitzScheduleOptions,
} from "../src/allocate/markowitz.ts";
import type { Point } from "../src/types.ts";

setDefaultTimeout(60_000);

const history = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));
const ASSETS = ["SPX", "ETH", "DXY"] as const;
const closes: Record<string, Point[]> = Object.fromEntries(ASSETS.map((a) => [a, history[a]!]));
const cashRate = history.TBILL3M!;
const MU: Record<string, number> = { SPX: 0.075, ETH: 0.3, DXY: 0.01 };
const muVec = ASSETS.map((a) => MU[a]!);

// Daily returns on consecutive common dates, keyed by date, one value per asset.
const maps = ASSETS.map((a) => new Map(closes[a]!.map((p) => [p.date, p.value])));
const common = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
const RETURNS = new Map<string, number[]>();
for (let i = 1; i < common.length; i++) RETURNS.set(common[i]!, maps.map((m) => m.get(common[i]!)! / m.get(common[i - 1]!)! - 1));
const RDAYS = [...RETURNS.keys()];

function calendar(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const AXIS = calendar("2022-01-03", "2024-12-31");
const rfOn = (d: string): number => {
  const ps = cashRate.filter((p) => p.date <= d);
  return ps.length ? ps[ps.length - 1]!.value / 100 : 0;
};
/** History rows strictly before d (and on or after `from` when given). */
const historyBefore = (d: string, from?: string): number[][] => RDAYS.filter((x) => x < d && (from === undefined || x >= from)).map((x) => RETURNS.get(x)!);
const constMu = (): Record<string, number> => MU;
const base = (): MarkowitzScheduleOptions => ({ dateAxis: AXIS, returns: RETURNS, assets: ASSETS, cashRate, mu: constMu });
/** The axis dates on which the schedule's weights differ from the previous date's. */
const changeDates = (s: Schedule): string[] => AXIS.filter((d, i) => i > 0 && JSON.stringify(s[i]) !== JSON.stringify(s[i - 1]));
/** Optimizer output as schedule weights: canonical zero, cash = 1 - sum w compensated. */
const asWeights = (w: readonly number[]): Weights => {
  const c = w.map((x) => canonZero(x));
  return { cash: canonZero(sum2([1, ...c.map((x) => -x)])), SPX: c[0]!, ETH: c[1]!, DXY: c[2]! };
};
const pricesOf = (): Record<string, Point[]> => ({ SPX: closes.SPX!, ETH: closes.ETH!, DXY: closes.DXY! });

describe("markowitzSizing and markowitzBooks", () => {
  const rf = 0.04;
  const lambdas = [2, 4, 8, 16];
  const out = markowitzSizing({ closes, mu: MU, rf, lambdas, from: "2022-06-01", end: "2026-06-30" });
  const days = common.filter((d) => d >= "2022-06-01" && d <= "2026-06-30");
  const R = days.slice(1).map((d) => RETURNS.get(d)!);
  const S = shrunkCov(R);
  const ex = muVec.map((m) => m - rf);
  test("the window is the common dates from `from` to `end`; corr is correlationMatrix of the same returns; cov is shrunkCov", () => {
    expect(out.from).toBe(days[0]!);
    expect(out.asof).toBe(days[days.length - 1]!);
    expect(out.nObs).toBe(days.length - 1);
    expect(out.assets).toEqual([...ASSETS]);
    expect(out.cov).toEqual(S);
    expect(out.corr).toEqual(correlationMatrix([0, 1, 2].map((j) => R.map((r) => r[j]!))));
    expect(out.vols).toEqual(S.map((row, i) => Math.sqrt(row[i]!)));
  });
  test("the tangency book sums to 1 with sharpeResidual below 1e-14; each lambda's book has meanVarResidual below 1e-14 and cash 1 - sum w", () => {
    const tw = ASSETS.map((a) => out.tangency.weights[a]!);
    expect(sum2(tw)).toBeCloseTo(1, 15);
    expect(out.tangency.cash).toBe(canonZero(sum2([1, ...tw.map((x) => -x)])));
    expect(sharpeResidual(S, ex, tw)).toBeLessThan(1e-14);
    expect(out.byLambda.map((b) => b.lambda)).toEqual(lambdas);
    for (const { lambda, book } of out.byLambda) {
      const w = ASSETS.map((a) => book.weights[a]!);
      expect(meanVarResidual(S, ex, lambda, w)).toBeLessThan(1e-14);
      expect(w).toEqual(meanVarExact(S, ex, lambda).map((x) => canonZero(x)));
      expect(book.cash).toBe(canonZero(sum2([1, ...w.map((x) => -x)])));
      expect(book.vol).toBe(Math.sqrt(dot2(w, S.map((row) => dot2(row, w)))));
      expect(book.expReturn).toBe(dot2([...w, book.cash], [...muVec, rf]));
      expect(book.sharpe).toBe(dot2([...w, book.cash, -1], [...muVec, rf, rf]) / book.vol);
    }
    expect(out.byLambda.some((b) => b.book.cash > 0)).toBe(true); // a slack budget holds cash
  });
  test("markowitzBooks over the same rows gives the same books, with mu as a record or an array; all cash when no excess return is positive", () => {
    const books = markowitzBooks({ returns: R, assets: ASSETS, rf, mu: muVec, lambdas });
    expect(books.tangency).toEqual(out.tangency);
    expect(books.byLambda).toEqual(out.byLambda);
    const neg = markowitzBooks({ returns: R, assets: ASSETS, rf: 0.5, mu: MU, lambdas: [4] });
    expect(neg.byLambda[0]!.book).toEqual({ weights: { SPX: 0, ETH: 0, DXY: 0 }, cash: 1, expReturn: 0.5, vol: 0, sharpe: null });
    expect(Object.values(neg.tangency.weights).filter((w) => w === 1).length).toBe(1);
  });
  test("refusals: an unknown mu asset, a non-finite rf or mu, a lambda of 0, too few dates and an unknown key throw RangeError", () => {
    expect(() => markowitzSizing({ closes, mu: { ...MU, GLD: 0.05 }, rf, lambdas })).toThrow(/"GLD" in mu has no closes/);
    expect(() => markowitzSizing({ closes, mu: MU, rf: NaN, lambdas })).toThrow(RangeError);
    expect(() => markowitzSizing({ closes, mu: { ...MU, ETH: Infinity }, rf, lambdas })).toThrow(/mu for "ETH"/);
    expect(() => markowitzSizing({ closes, mu: MU, rf, lambdas: [4, 0] })).toThrow(/lambda 1 must be positive/);
    expect(() => markowitzSizing({ closes, mu: MU, rf, lambdas, from: "2026-06-29", end: "2026-06-29" })).toThrow(/fewer than two common dates/);
    expect(() => markowitzSizing({ closes, mu: MU, rf, lambdas, lookback: 5 } as never)).toThrow(/unknown option "lookback"/);
    expect(() => markowitzBooks({ returns: R, assets: ASSETS, rf, mu: [0.1], lambdas })).toThrow(RangeError);
  });
});

describe("markowitzSchedule defaults", () => {
  const { schedule, rebalances } = markowitzSchedule(base());
  test("weights change only on the first axis date of a month, are null until 252 history rows exist, and equal meanVarExact on shrunkCov of the history before the date", () => {
    const firstOfMonth = new Set(AXIS.filter((d, i) => i === 0 || d.slice(0, 7) !== AXIS[i - 1]!.slice(0, 7)));
    for (const d of changeDates(schedule)) expect(firstOfMonth.has(d)).toBe(true);
    const i0 = schedule.findIndex((w) => w !== null);
    expect(AXIS[i0]).toBe(rebalances[0]!.date);
    // the first month start with 252 history rows, and none before it
    const monthStarts = [...firstOfMonth];
    const first = monthStarts.find((d) => historyBefore(d).length >= 252)!;
    expect(rebalances[0]!.date).toBe(first);
    expect(historyBefore(monthStarts[monthStarts.indexOf(first) - 1]!).length).toBeLessThan(252);
    expect(rebalances.map((r) => r.date)).toEqual(monthStarts.filter((d) => d >= first));
    for (const r of rebalances) {
      const H = historyBefore(r.date);
      const rf = rfOn(r.date);
      expect(r.rf).toBe(rf);
      expect(r.nObs).toBe(H.length);
      expect(r.weights).toEqual(asWeights(meanVarExact(shrunkCov(H), muVec.map((m) => m - rf), 4)));
      expect(schedule[AXIS.indexOf(r.date)]).toEqual(r.weights);
    }
  });
  test("no lookahead: changing every return dated on or after a rebalance date leaves that date's weights unchanged", () => {
    for (const r of [rebalances[0]!, rebalances[5]!, rebalances[rebalances.length - 1]!]) {
      const shifted = new Map([...RETURNS].map(([d, row]) => [d, d >= r.date ? row.map((x) => -2 * x + 0.01) : row]));
      const out = markowitzSchedule({ ...base(), returns: shifted });
      expect(out.schedule[AXIS.indexOf(r.date)]).toEqual(schedule[AXIS.indexOf(r.date)]);
    }
  });
  test("every optional constant defaults to today's value, and the default output is byte-identical to the defaults spelled out", () => {
    expect([MIN_OBS, LAMBDA, ZERO_TOL]).toEqual([252, 4, 1e-12]);
    const explicit = markowitzSchedule({
      ...base(), rule: "meanVar", reoptimise: "monthly", minObs: 252, shrink: 0.2, periodsPerYear: 252, lambda: 4, zeroTol: 1e-12,
    });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify({ schedule, rebalances }));
    const viaCallbacks = markowitzSchedule({
      ...base(), cov: (h) => shrunkCov(h, 0.2, 252), solve: (mu, S, rf) => meanVarExact(S, mu.map((m) => m - rf), 4), expand: (w) => w,
    });
    expect(JSON.stringify(viaCallbacks)).toBe(JSON.stringify({ schedule, rebalances }));
  });
  test("the tangency rule is fully invested and equals tangencyExact on the same history", () => {
    const t = markowitzSchedule({ ...base(), rule: "tangency" });
    for (const r of t.rebalances) {
      const rf = rfOn(r.date);
      expect(r.weights).toEqual(asWeights(tangencyExact(shrunkCov(historyBefore(r.date)), muVec.map((m) => m - rf))));
      expect(r.weights.cash).toBe(0);
    }
  });
  test("an unknown option key throws RangeError naming the key; invalid values throw RangeError naming the option", () => {
    expect(() => markowitzSchedule({ ...base(), lambdaa: 4 } as never)).toThrow(/unknown option "lambdaa"/);
    expect(() => markowitzSchedule({ ...base(), costBps: 10 } as never)).toThrow(/unknown option "costBps"/);
    expect(() => markowitzSchedule({ ...base(), lambda: 0 })).toThrow(/lambda must be positive/);
    expect(() => markowitzSchedule({ ...base(), minObs: 1.5 })).toThrow(/minObs/);
    expect(() => markowitzSchedule({ ...base(), shrink: 2 })).toThrow(/shrink/);
    expect(() => markowitzSchedule({ ...base(), zeroTol: -1 })).toThrow(/zeroTol/);
    expect(() => markowitzSchedule({ ...base(), periodsPerYear: 0 })).toThrow(/periodsPerYear/);
    expect(() => markowitzSchedule({ ...base(), reoptimise: "daily" as never })).toThrow(/reoptimise/);
    expect(() => markowitzSchedule({ ...base(), from: "2022/01/01" })).toThrow(/from/);
    expect(() => markowitzSchedule({ ...base(), lookback: 100 })).toThrow(/lookback 100 is below minObs 252/);
    expect(() => markowitzSchedule({ ...base(), solve: () => [0.7, 0.7, 0] })).toThrow(/sum above 1/);
    expect(() => markowitzSchedule({ ...base(), solve: () => [1.2, -0.2, 0] })).toThrow(/negative/);
  });
  test("from: the history starts at the first return on or after it", () => {
    const out = markowitzSchedule({ ...base(), from: "2022-06-01" });
    for (const r of out.rebalances) {
      expect(r.nObs).toBe(historyBefore(r.date, "2022-06-01").length);
      expect(r.weights).toEqual(asWeights(meanVarExact(shrunkCov(historyBefore(r.date, "2022-06-01")), muVec.map((m) => m - rfOn(r.date)), 4)));
    }
    expect(out.rebalances[0]!.date > rebalances[0]!.date).toBe(true);
  });
});

describe("markowitzSchedule tuning", () => {
  test("reoptimise weekly, quarterly and a predicate change weights exactly on the dates they name", () => {
    const weekly = markowitzSchedule({ ...base(), reoptimise: "weekly" });
    const mondays = AXIS.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1);
    expect(weekly.rebalances.map((r) => r.date)).toEqual(mondays.filter((d) => historyBefore(d).length >= 252));
    for (const d of changeDates(weekly.schedule)) expect(mondays).toContain(d);
    const quarterly = markowitzSchedule({ ...base(), reoptimise: "quarterly" });
    const qStarts = AXIS.filter((d) => /-(01|04|07|10)-01$/.test(d));
    expect(quarterly.rebalances.map((r) => r.date)).toEqual(qStarts.filter((d) => historyBefore(d).length >= 252));
    for (const d of changeDates(quarterly.schedule)) expect(qStarts).toContain(d);
    const seen: [string, string | null][] = [];
    const fifteenth = markowitzSchedule({ ...base(), reoptimise: (d, p) => (seen.push([d, p]), d.endsWith("-15")) });
    expect(seen[0]).toEqual([AXIS[0]!, null]);
    expect(seen.slice(1).every(([d, p], i) => d === AXIS[i + 1] && p === AXIS[i])).toBe(true);
    const fifteenths = AXIS.filter((d) => d.endsWith("-15"));
    expect(fifteenth.rebalances.map((r) => r.date)).toEqual(fifteenths.filter((d) => historyBefore(d).length >= 252));
    for (const d of changeDates(fifteenth.schedule)) expect(fifteenths).toContain(d);
  });
  test("cov with a rolling lookback of 252 replaces the expanding window; a cov callback replaces shrunkCov", () => {
    const rolling = markowitzSchedule({ ...base(), lookback: 252 });
    for (const r of rolling.rebalances) {
      const H = historyBefore(r.date).slice(-252);
      expect(r.nObs).toBe(252);
      expect(r.weights).toEqual(asWeights(meanVarExact(shrunkCov(H), muVec.map((m) => m - rfOn(r.date)), 4)));
    }
    expect(rolling.rebalances.at(-1)!.weights).not.toEqual(markowitzSchedule(base()).rebalances.at(-1)!.weights);
    const lens: number[] = [];
    const raw = markowitzSchedule({ ...base(), cov: (h) => (lens.push(h.length), shrunkCov(h, 0)) });
    for (const r of raw.rebalances) {
      expect(r.weights).toEqual(asWeights(meanVarExact(shrunkCov(historyBefore(r.date), 0), muVec.map((m) => m - rfOn(r.date)), 4)));
    }
    expect(lens).toEqual(raw.rebalances.map((r) => r.nObs));
  });
  test("solve set to the exported ERC, minimum-variance and risk-budget solvers matches each solver called directly on the same history", () => {
    const rules: [string, (S: Mat) => number[]][] = [
      ["erc", (S) => ercCertified(S)],
      ["minvar", (S) => minVarExact(S)],
      ["rb50", (S) => ercCertified(S, [0.5, 0.25, 0.25])],
    ];
    for (const [, rule] of rules) {
      const out = markowitzSchedule({ ...base(), lookback: 252, solve: (_mu, S) => rule(S) });
      expect(out.rebalances.length).toBeGreaterThan(10);
      for (const r of out.rebalances) {
        expect(r.weights).toEqual(asWeights(rule(shrunkCov(historyBefore(r.date).slice(-252)))));
        expect(r.weights.cash).toBe(0);
      }
    }
  });
  test("mu(date, history) gets the date and the history before it, so a client keeps point-in-time priors", () => {
    const calls: { d: string; n: number; last: string | undefined }[] = [];
    const out = markowitzSchedule({
      ...base(),
      mu: (d, h, dates) => {
        calls.push({ d, n: h.length, last: dates.at(-1) });
        return [0.05 + h.length / 1e5, 0.2, 0.0];
      },
    });
    expect(calls.map((c) => c.d)).toEqual(out.rebalances.map((r) => r.date));
    for (const c of calls) {
      expect(c.n).toBe(historyBefore(c.d).length);
      expect(c.last! < c.d).toBe(true);
    }
    expect(out.rebalances[0]!.mu[0]).toBe(0.05 + calls[0]!.n / 1e5);
  });
  test("expand(weights, date) receives each axis date with weights, and returning null leaves that day unset", () => {
    const got: string[] = [];
    const out = markowitzSchedule({
      ...base(),
      expand: (w, d) => {
        got.push(d);
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) return null; // Sundays unset
        const s = d < "2024-01-01" ? 0.5 : 1; // a date-dependent share of the risky book
        const out: Weights = { cash: 1 - s * (1 - w.cash!) };
        for (const a of ASSETS) out[a] = s * w[a]!;
        return out;
      },
    });
    const first = AXIS.indexOf(out.rebalances[0]!.date);
    expect(got).toEqual(AXIS.slice(first));
    AXIS.forEach((d, i) => {
      if (i < first || new Date(`${d}T00:00:00Z`).getUTCDay() === 0) expect(out.schedule[i]).toBeNull();
      else expect(out.schedule[i]!.SPX).toBe((d < "2024-01-01" ? 0.5 : 1) * markowitzSchedule(base()).schedule[i]!.SPX!);
    });
  });
});

describe("markowitzSchedule gives callbacks the date, rf, a longer trailing history and the rebalance in force", () => {
  test("cov(history, context) and solve(mu, S, rf, context) get the date, the history dates and rf; trailing(n) reaches past lookback", () => {
    const seen: { d: string; hd: string[]; rf: number; trail: string[]; trailRows: number[][] }[] = [];
    const out = markowitzSchedule({
      ...base(),
      lookback: 252,
      cov: (h, ctx) => {
        const t = ctx.trailing(500);
        seen.push({ d: ctx.date, hd: [...ctx.historyDates], rf: NaN, trail: t.dates, trailRows: t.rows });
        expect(h.length).toBe(252);
        return shrunkCov(h);
      },
      solve: (mu, S, rf, ctx) => {
        expect(ctx.date).toBe(seen.at(-1)!.d);
        seen.at(-1)!.rf = rf;
        return meanVarExact(S, mu.map((m) => m - rf), 4);
      },
    });
    expect(seen.map((x) => x.d)).toEqual(out.rebalances.map((r) => r.date));
    for (const x of seen) {
      expect(x.rf).toBe(rfOn(x.d));
      expect(x.hd).toEqual(RDAYS.filter((r) => r < x.d).slice(-252));
      expect(x.trail).toEqual(RDAYS.filter((r) => r < x.d).slice(-500));
      expect(x.trailRows).toEqual(x.trail.map((r) => RETURNS.get(r)!));
    }
    expect(seen.at(-1)!.trail.length).toBe(500);
  });
  test("trailing(n) is capped at the data from `from`, never reaches the date, and is a copy", () => {
    const from = "2020-01-01";
    markowitzSchedule({
      ...base(),
      from,
      cov: (h, ctx) => {
        const all = ctx.trailing(100_000);
        expect(all.dates).toEqual(RDAYS.filter((r) => r >= from && r < ctx.date));
        expect(all.dates.every((r) => r < ctx.date)).toBe(true);
        all.rows[0]![0] = 123;
        expect(ctx.trailing(100_000).rows[0]![0]).not.toBe(123);
        return shrunkCov(h);
      },
    });
    expect(() => markowitzSchedule({ ...base(), cov: (h, ctx) => (ctx.trailing(-1), shrunkCov(h)) })).toThrow(RangeError);
  });
  test("mu gets rf as its fourth argument: the same rf the rebalance records", () => {
    const rfs: number[] = [];
    const out = markowitzSchedule({ ...base(), mu: (_d, _h, _dates, rf) => (rfs.push(rf), MU) });
    expect(rfs).toEqual(out.rebalances.map((r) => r.rf));
    expect(rfs.some((r) => r > 0)).toBe(true);
  });
  test("a rebalance records vol = sqrt(w' S w) on the covariance the solver saw, the same for the default and a custom cov", () => {
    const out = markowitzSchedule(base());
    for (const r of out.rebalances) {
      const S = shrunkCov(historyBefore(r.date));
      const w = ASSETS.map((a) => r.weights[a]!);
      expect(r.vol).toBe(Math.sqrt(dot2(w, S.map((row) => dot2(row, w)))));
      expect(r.vol).toBeGreaterThan(0);
    }
    const custom = markowitzSchedule({ ...base(), cov: (h) => shrunkCov(h) });
    expect(custom.rebalances.map((r) => r.vol)).toEqual(out.rebalances.map((r) => r.vol));
  });
  test("expand(weights, date, rebalance) gets the rebalance in force, in ascending date order, as a copy", () => {
    const calls: { d: string; at: string }[] = [];
    const out = markowitzSchedule({
      ...base(),
      expand: (w, d, rb) => {
        calls.push({ d, at: rb.date });
        expect(rb.weights).toEqual(w);
        expect(rb.date <= d).toBe(true);
        rb.mu[0] = 999;
        rb.weights.SPX = 999;
        return w;
      },
    });
    expect(calls.map((c) => c.d)).toEqual([...calls.map((c) => c.d)].sort());
    expect(calls.map((c) => c.d)).toEqual(AXIS.slice(AXIS.indexOf(out.rebalances[0]!.date)));
    expect(new Set(calls.map((c) => c.at))).toEqual(new Set(out.rebalances.map((r) => r.date)));
    expect(out.rebalances.every((r) => r.mu[0] !== 999 && r.weights.SPX !== 999)).toBe(true);
  });
  test("a vol target in expand: scaling the book by sigma / rb.vol reproduces a hand-computed schedule", () => {
    const sigma = 0.1;
    const base0 = markowitzSchedule(base());
    const out = markowitzSchedule({
      ...base(),
      expand: (w, _d, rb) => {
        const s = Math.min(1, sigma / rb.vol);
        const o: Weights = { cash: 1 - s * (1 - w.cash!) };
        for (const a of ASSETS) o[a] = s * w[a]!;
        return o;
      },
    });
    out.schedule.forEach((row, i) => {
      if (row === null) return;
      const rb = base0.rebalances.filter((r) => r.date <= AXIS[i]!).at(-1)!;
      expect(row.SPX).toBe(Math.min(1, sigma / rb.vol) * base0.schedule[i]!.SPX!);
    });
  });
});

describe("markowitzBacktest", () => {
  test("the simulation and stats are bit-identical to simulatePortfolio and periodStats run on its own returned schedule", () => {
    const bt = markowitzBacktest({ ...base(), prices: pricesOf() });
    expect(bt.schedule).toEqual(markowitzSchedule(base()).schedule);
    const sim = simulatePortfolio(AXIS, bt.schedule, pricesOf(), cashRate);
    expect(bt.simulation).toEqual(sim);
    expect(bt.stats).toEqual(periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades }));
    expect(bt.simulation.trades.length).toBeGreaterThan(0);
    const cheap = markowitzBacktest({ ...base(), prices: pricesOf(), costBps: 0 });
    expect(cheap.simulation).toEqual(simulatePortfolio(AXIS, cheap.schedule, pricesOf(), cashRate, { costBps: 0 }));
  });
  test("simulate set to simulateDrift with { costBps: 10, freq: \"monthly\" } is bit-identical to simulateDrift and periodStats on its own schedule", () => {
    const bt = markowitzBacktest({ ...base(), prices: pricesOf(), simulate: { drift: { costBps: 10, freq: "monthly" } } });
    const sim = simulateDrift(AXIS, bt.schedule, pricesOf(), cashRate, { costBps: 10, freq: "monthly" });
    expect(bt.simulation).toEqual(sim);
    expect(bt.stats).toEqual(periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades }));
    expect(bt.simulation).not.toEqual(simulatePortfolio(AXIS, bt.schedule, pricesOf(), cashRate));
    const viaTop = markowitzBacktest({ ...base(), prices: pricesOf(), costBps: 10, simulate: { drift: { freq: "monthly" } } });
    expect(viaTop.simulation).toEqual(sim);
  });
  test("a simulator function receives the schedule and its result goes to periodStats unchanged", () => {
    const calls: number[] = [];
    const bt = markowitzBacktest({
      ...base(), prices: pricesOf(), splitDate: "2024-06-30",
      simulate: (a, s, p, c) => (calls.push(s.length), simulateDrift(a, s, p, c, { costBps: 5, freq: "quarterly", band: 0.1 })),
    });
    expect(calls).toEqual([AXIS.length]);
    const sim = simulateDrift(AXIS, bt.schedule, pricesOf(), cashRate, { costBps: 5, freq: "quarterly", band: 0.1 });
    expect(bt.simulation).toEqual(sim);
    expect(bt.stats).toEqual(periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades, splitDate: "2024-06-30" }));
  });
  test("unknown keys and conflicting or invalid options throw RangeError naming the key", () => {
    expect(() => markowitzBacktest({ ...base(), prices: pricesOf(), freq: "monthly" } as never)).toThrow(/unknown option "freq"/);
    expect(() => markowitzBacktest({ ...base(), prices: pricesOf(), costBps: -1 })).toThrow(/costBps/);
    expect(() => markowitzBacktest({ ...base(), prices: pricesOf(), costBps: 5, simulate: (a, s, p, c) => simulatePortfolio(a, s, p, c) })).toThrow(/costBps/);
    expect(() => markowitzBacktest({ ...base(), prices: pricesOf(), simulate: { drift: { freq: "hourly" as never } } })).toThrow(/freq/);
    expect(() => markowitzBacktest({ ...base(), prices: pricesOf(), simulate: { kind: "drift" } as never })).toThrow(/simulate/);
  });
});

// SDK-11: a custom cov callback's result is checked before the solve. A NaN or
// Infinity entry, or a wrong shape, throws RangeError naming the date.
describe("markowitzSchedule checks a custom cov result (SDK-11)", () => {
  const firstDue = (): string => markowitzSchedule(base()).rebalances[0]!.date;
  test("a NaN entry, an Infinity entry or a wrong shape throws RangeError naming the date", () => {
    const d = firstDue();
    const ok = (h: number[][]) => shrunkCov(h, 0.2, 252);
    const cases: Array<(h: number[][]) => number[][]> = [
      (h) => ok(h).map((r, i) => (i === 1 ? r.map((v, j) => (j === 0 ? NaN : v)) : r)),
      (h) => ok(h).map((r, i) => (i === 0 ? r.map((v, j) => (j === 0 ? Infinity : v)) : r)),
      (h) => ok(h).slice(0, 2),
      (h) => ok(h).map((r) => r.slice(0, 2)),
    ];
    for (const cov of cases) {
      expect(() => markowitzSchedule({ ...base(), cov })).toThrow(RangeError);
      expect(() => markowitzSchedule({ ...base(), cov })).toThrow(new RegExp(d));
    }
  });
  test("the default cov path is unchanged by the check", () => {
    const a = markowitzSchedule(base());
    const b = markowitzSchedule({ ...base(), cov: (h) => shrunkCov(h, 0.2, 252) });
    expect(JSON.stringify(b.schedule)).toBe(JSON.stringify(a.schedule));
  });
});

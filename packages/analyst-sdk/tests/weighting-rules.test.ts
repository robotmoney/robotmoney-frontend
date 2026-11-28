// Issue 1766: Lex's six portfolio weighting rules, their building blocks and
// OPTIMIZERS_PRESET (analytics requirements section 5.7).
import { describe, expect, test } from "bun:test";
import { discountToYield, simulateDrift } from "../src/analyze/backtest.ts";
import { shrunkCov } from "../src/allocate/covariance.ts";
import { canonZero, markowitzSchedule } from "../src/allocate/markowitz.ts";
import { ercCertified, minVarExact, riskContributions, type Mat } from "../src/allocate/optimize.ts";
import {
  assetClassReturns,
  computePortfolioWeighting,
  labelScaledTargets,
  OPTIMIZERS_PRESET,
  WEIGHTING_RULE_KEYS,
  weightingRuleSchedule,
  type WeightingRuleScheduleOptions,
} from "../src/allocate/weighting-rules.ts";
import { syntheticMarket } from "./support/optimizers-synthetic.ts";

const M = syntheticMarket();
const P = OPTIMIZERS_PRESET.weightingRules;
const CLASSES = Object.keys(P.assetClasses);
const returns = assetClassReturns(M.prices, P.assetClasses);
const SMALL = { lookback: 120, minObs: 60, markowitz: { minObs: 120, expectedReturn: P.markowitz.expectedReturn } };
const scheduleOptions: WeightingRuleScheduleOptions = {
  dateAxis: M.axis, returns, classes: CLASSES, lookback: SMALL.lookback, minObs: SMALL.minObs, riskBudget: P.riskBudget, markowitz: SMALL.markowitz, cashQuotes: M.cashQuotes, cashBasis: "discount",
};
const solves: Record<string, (S: Mat) => number[]> = {
  naive: (S) => S.map(() => 1 / S.length),
  inverse_vol: (S) => {
    const w = S.map((r, i) => 1 / Math.sqrt(r[i]!));
    const t = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / t);
  },
  equal_risk: (S) => ercCertified(S),
  risk_budget: (S) => ercCertified(S, CLASSES.map((c) => P.riskBudget[c as keyof typeof P.riskBudget])),
  min_variance: (S) => minVarExact(S).map((x) => canonZero(x)),
};
const covAt = (d: string, lookback?: number) => {
  const days = [...returns.keys()].filter((x) => x < d).sort();
  return shrunkCov((lookback === undefined ? days : days.slice(-lookback)).map((x) => [...returns.get(x)!]));
};
const vec = (w: Record<string, number>) => CLASSES.map((c) => w[c]!);
const variance = (S: number[][], w: number[]) => w.reduce((a, wi, i) => a + wi * S[i]!.reduce((b, s, j) => b + s * w[j]!, 0), 0);

describe("weightingRuleSchedule", () => {
  test("each risk rule deep-equals markowitzSchedule with the same solve, lookback and minObs", () => {
    for (const key of ["naive", "inverse_vol", "equal_risk", "risk_budget", "min_variance"] as const) {
      const got = weightingRuleSchedule(key, scheduleOptions);
      const want = markowitzSchedule({ dateAxis: M.axis, returns, assets: CLASSES, mu: () => CLASSES.map(() => 0), lookback: SMALL.lookback, minObs: SMALL.minObs, solve: (_m, S) => solves[key]!(S) });
      expect(got).toEqual(want);
      expect(got.rebalances.length).toBeGreaterThan(15);
    }
  });

  test("markowitz deep-equals markowitzSchedule tangency with rf 0 and the expected returns less the solve day's cash rate", () => {
    const er = SMALL.markowitz.expectedReturn;
    const rateBefore = (d: string) => {
      const q = M.cashQuotes.filter((p) => p.date < d).at(-1);
      return q === undefined ? 0 : discountToYield(q.value) / 100;
    };
    const want = markowitzSchedule({ dateAxis: M.axis, returns, assets: CLASSES, rule: "tangency", minObs: SMALL.markowitz.minObs, mu: (d) => CLASSES.map((c) => er[c as keyof typeof er] - rateBefore(d)) });
    const got = weightingRuleSchedule("markowitz", scheduleOptions);
    expect(got).toEqual(want);
    expect(got.rebalances.every((r) => r.rf === 0)).toBe(true);
    expect(got.rebalances.length).toBeGreaterThan(10);
  });

  test("each rule meets its own rule on its solve's covariance", () => {
    const last = (key: (typeof WEIGHTING_RULE_KEYS)[number]) => weightingRuleSchedule(key, scheduleOptions).rebalances.at(-1)!;
    const d = last("naive").date;
    const S = covAt(d, SMALL.lookback);
    const w = Object.fromEntries(WEIGHTING_RULE_KEYS.map((k) => [k, vec(last(k).weights)]));
    for (const x of w.naive!) expect(x).toBe(1 / 3);
    const iv = w.inverse_vol!.map((x, i) => x * Math.sqrt(S[i]![i]!));
    for (const x of iv) expect(Math.abs(x - iv[0]!)).toBeLessThan(1e-15);
    for (const x of riskContributions(S, w.equal_risk!)) expect(Math.abs(x - 1 / 3)).toBeLessThanOrEqual(1e-12);
    const rb = riskContributions(S, w.risk_budget!);
    expect(Math.abs(rb[0]! - 0.9)).toBeLessThanOrEqual(1e-12);
    for (const k of ["naive", "inverse_vol", "equal_risk", "risk_budget"]) expect(variance(S, w.min_variance!)).toBeLessThanOrEqual(variance(S, w[k]!));
  });
});

describe("assetClassReturns", () => {
  test("a day one member lacks is left out; the next return is measured from the previous day every member had a price", () => {
    const px = {
      a: [{ date: "2024-01-01", value: 100 }, { date: "2024-01-02", value: 110 }, { date: "2024-01-03", value: 121 }, { date: "2024-01-04", value: 121 }],
      b: [{ date: "2024-01-01", value: 10 }, { date: "2024-01-02", value: 10 }, { date: "2024-01-04", value: 12 }],
      c: [{ date: "2024-01-01", value: 50 }, { date: "2024-01-02", value: 55 }, { date: "2024-01-03", value: 60 }, { date: "2024-01-04", value: 66 }],
    };
    const r = assetClassReturns(px, { one: { a: 0.5, b: 0.5 }, two: { c: 1 } });
    expect([...r.keys()]).toEqual(["2024-01-02", "2024-01-04"]);
    expect(r.get("2024-01-02")).toEqual([0.5 * (110 / 100 - 1) + 0.5 * 0, 55 / 50 - 1]);
    const d4 = r.get("2024-01-04")!;
    expect(Math.abs(d4[0]! - (0.5 * (121 / 110 - 1) + 0.5 * (12 / 10 - 1)))).toBeLessThan(1e-16);
    expect(d4[1]).toBe(66 / 55 - 1);
  });
});

describe("labelScaledTargets", () => {
  const cw = [null, { crypto: 0.5, us_equities: 0.3, gold: 0.2 }, { crypto: 0.5, us_equities: 0.3, gold: 0.2 }, { crypto: 0.5, us_equities: 0.3, gold: 0.2 }];
  test("the risk-on share times the class weight times the member share, the rest in cash; null without a label or a solve", () => {
    const t = labelScaledTargets(cw, ["neutral", "neutral", null, "risk_on"], P.riskOnShare, P.assetClasses);
    expect(t[0]).toBeNull();
    expect(t[2]).toBeNull();
    expect(t[1]).toEqual({ cash: 1 - 0.5, btc: 0.5 * (0.5 * 0.5), eth: 0.5 * (0.5 * 0.5), sp500: 0.5 * (0.3 * 1), gld: 0.5 * (0.2 * 1) });
    expect(t[3]).toEqual({ cash: 1 - 0.95, btc: 0.95 * (0.5 * 0.5), eth: 0.95 * (0.5 * 0.5), sp500: 0.95 * (0.3 * 1), gld: 0.95 * (0.2 * 1) });
  });
  test("an unknown label is a RangeError naming it and its day", () => {
    const call = () => labelScaledTargets(cw, ["neutral", "neutral", "bullish", "risk_on"], P.riskOnShare, P.assetClasses);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/"bullish" on day 2/);
  });
});

describe("OPTIMIZERS_PRESET and computePortfolioWeighting", () => {
  const options = { trading: OPTIMIZERS_PRESET.trading, sampling: OPTIMIZERS_PRESET.sampling, windows: { trailingMonths: [12], commonPeriodMonths: 12 }, ...P };

  test("the preset is frozen at every depth, its cash basis is discount, and simulateDrift accepts its trading options", () => {
    const frozen = (o: unknown): boolean => o === null || typeof o !== "object" || (Object.isFrozen(o) && Object.values(o).every(frozen));
    expect(frozen(OPTIMIZERS_PRESET)).toBe(true);
    expect(OPTIMIZERS_PRESET.trading.cashBasis).toBe("discount");
    expect(OPTIMIZERS_PRESET.weightingRules.riskBudget.us_equities).toBe((1 - 0.9) / 2);
    const sim = simulateDrift(M.axis, M.axis.map(() => ({ cash: 0.5, btc: 0.1, eth: 0.1, sp500: 0.2, gld: 0.1 })), M.prices, M.cashQuotes, OPTIMIZERS_PRESET.trading);
    expect(sim.values.length).toBeGreaterThan(700);
  });

  test("computePortfolioWeighting composes the rules: targets, figures and the curves of the six rules and three benchmarks", () => {
    const out = computePortfolioWeighting(M.axis, M.labels.regime, M.prices, M.cashQuotes, options);
    expect(Object.keys(out.curves)).toEqual([...WEIGHTING_RULE_KEYS, "stables_only", "sp500_hodl", "eth_hodl"]);
    const f = out.figures;
    expect(f.asof).toBe("2024-12-31");
    expect(f.rebalance_date).toBe("2024-12-01");
    expect(f.covariance_1y).toEqual(covAt("2024-12-01", P.lookback));
    expect(f.covariance_full).toEqual(covAt("2024-12-01"));
    expect(f.volatility_1y).toEqual(Object.fromEntries(CLASSES.map((c, i) => [c, Math.sqrt(f.covariance_1y[i]![i]!)])));
    const q = M.cashQuotes.filter((p) => p.date < "2024-12-01").at(-1)!;
    expect(f.cash_rate).toBe(discountToYield(q.value) / 100);
    for (const key of WEIGHTING_RULE_KEYS) {
      const last = weightingRuleSchedule(key, { ...scheduleOptions, lookback: P.lookback, minObs: P.minObs, markowitz: P.markowitz }).rebalances.at(-1)!;
      expect(f.engines[key].money).toEqual(Object.fromEntries(CLASSES.map((c) => [c, last.weights[c]!])));
      expect(f.engines[key].risk).toEqual(Object.fromEntries(CLASSES.map((c, i) => [c, riskContributions(key === "markowitz" ? f.covariance_full : f.covariance_1y, vec(last.weights))[i]!])));
    }
    const first = new Set(Object.values(out.curves).filter((c) => c.kind !== "strategy").map((c) => c.first_day));
    expect(first.size).toBe(1);
    expect([...first][0]).toBe(WEIGHTING_RULE_KEYS.map((k) => out.curves[k]!.first_day).sort()[0]!);
  });

  test("an unknown option key is a RangeError naming it", () => {
    const call = () => computePortfolioWeighting(M.axis, M.labels.regime, M.prices, M.cashQuotes, { ...options, labelStrategies: {} } as never);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/labelStrategies/);
  });
});

// Issue 1766: the output checks every stored figure passes (curve-checks.ts).
// Clean synthetic outputs of both groups pass every validator; each fault,
// planted alone on a copy, is named.
import { describe, expect, test } from "bun:test";
import { labelStrategyCurves, type CurveGroup } from "../src/analyze/equity-curves.ts";
import { crossCurveViolations, equityCurveViolations, weightingRuleViolations } from "../src/analyze/curve-checks.ts";
import { computePortfolioWeighting, OPTIMIZERS_PRESET, type WeightingFigures } from "../src/allocate/weighting-rules.ts";
import { syntheticMarket } from "./support/optimizers-synthetic.ts";

const M = syntheticMarket("2022-01-01", "2024-12-31");
const P = OPTIMIZERS_PRESET;
const windows = { trailingMonths: [12, 36], commonPeriodMonths: 12 };
const groupOptions = { trading: P.trading, sampling: P.sampling, windows };
const labelGroups = labelStrategyCurves(M.axis, M.labels, M.prices, M.cashQuotes, groupOptions);
const weighting = computePortfolioWeighting(M.axis, M.labels.regime, M.prices, M.cashQuotes, { ...groupOptions, ...P.weightingRules });
const clean = (): Record<string, CurveGroup> => structuredClone({ ...labelGroups, portfolio_weighting_rules: weighting.curves });
const negativeQuoteDays = M.cashQuotes.filter((q) => q.value < 0).map((q) => q.date);
const curveOptions = { trailingMonths: windows.trailingMonths, sampling: P.sampling, negativeQuoteDays };
const crossOptions = { lastAxisDay: M.axis.at(-1)!, ...windows };
const newestLabel = M.labels.regime.filter((l) => l !== null).at(-1)!;
const ruleOptions = { riskBudget: P.weightingRules.riskBudget, expectedReturn: P.weightingRules.markowitz.expectedReturn, riskOnShare: P.weightingRules.riskOnShare, label: newestLabel };

const allCurveViolations = (groups: Record<string, CurveGroup>) =>
  Object.entries(groups).flatMap(([g, cs]) => Object.entries(cs).flatMap(([n, c]) => equityCurveViolations(`${g}.${n}`, c, curveOptions)));

describe("clean outputs", () => {
  test("every validator returns an empty list on both groups", () => {
    const groups = clean();
    expect(Object.keys(groups.portfolio_weighting_rules!).length).toBe(9);
    expect(allCurveViolations(groups)).toEqual([]);
    expect(crossCurveViolations(groups, crossOptions)).toEqual([]);
    expect(weightingRuleViolations(weighting.figures, ruleOptions)).toEqual([]);
    // the trailing 36-month window is null on this three-year market's weighting curves
    expect(groups.portfolio_weighting_rules!.naive!.windows.trailing_36m).toBeNull();
  });
});

describe("each planted fault is named", () => {
  const curveFault = (plant: (g: Record<string, CurveGroup>) => void, says: RegExp) => {
    const groups = clean();
    plant(groups);
    const found = allCurveViolations(groups);
    expect(found.some((s) => says.test(s))).toBe(true);
  };
  const crossFault = (plant: (g: Record<string, CurveGroup>) => void, says: RegExp) => {
    const groups = clean();
    plant(groups);
    expect(crossCurveViolations(groups, crossOptions).some((s) => says.test(s))).toBe(true);
  };
  const ruleFault = (plant: (f: WeightingFigures) => void, says: RegExp) => {
    const f = structuredClone(weighting.figures);
    plant(f);
    expect(weightingRuleViolations(f, ruleOptions).some((s) => says.test(s))).toBe(true);
  };
  const W = (g: Record<string, CurveGroup>) => g.portfolio_weighting_rules!;

  test("a curve that does not start at 1", () => curveFault((g) => (W(g).naive!.equity_curve[0]!.value = 1.01), /naive: the equity curve starts on .* at 1.01, not at 1/));
  test("a sampled point off the weekday", () =>
    curveFault((g) => {
      const p = W(g).naive!.equity_curve[3]!;
      p.date = new Date(Date.parse(`${p.date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    }, /naive: the equity curve has a point on .*, not on weekday 5/));
  test("a final value off the curve's end", () => curveFault((g) => (W(g).inverse_vol!.windows.since_inception.final_value *= 1.01), /inverse_vol: final value .* is not the curve's last value/));
  test("cash with a Sharpe ratio", () => curveFault((g) => (W(g).stables_only!.windows.trailing_12m!.sharpe = 0.4), /stables_only trailing_12m: cash has Sharpe ratio 0.4/));
  test("a trailing window present on a curve that does not cover it", () =>
    curveFault((g) => (W(g).naive!.windows.trailing_36m = structuredClone(W(g).naive!.windows.trailing_12m!)), /naive trailing_36m: present on a curve that does not cover it/));
  test("a window whose day count is not its calendar days", () => curveFault((g) => (W(g).equal_risk!.windows.trailing_12m!.n_days -= 1), /equal_risk trailing_12m: \d+ daily returns, not the \d+ days/));
  test("a benchmark that trades", () => curveFault((g) => (W(g).sp500_hodl!.windows.trailing_12m!.trades = 1), /sp500_hodl trailing_12m: a buy-and-hold benchmark traded 1 times/));
  test("cash that loses value with no negative quote", () =>
    curveFault((g) => {
      const w = W(g).stables_only!.windows.trailing_12m!;
      expect(negativeQuoteDays.every((d) => d < w.first_day)).toBe(true);
      w.final_value = 0.99;
    }, /stables_only trailing_12m: cash ends at 0.99, below 1, with no cash quote below zero/));
  test("two cash curves with different figures", () =>
    crossFault((g) => (g.eth!.stables_only!.windows.trailing_12m!.final_value *= 1 + 1e-6), /eth.stables_only and .*stables_only hold the same thing, and their trailing_12m final_value differs/));
  test("a common period that starts on two days", () =>
    crossFault((g) => (W(g).markowitz!.windows.trailing_12m!.first_day = "2024-01-02"), /the common periods start on different days/));
  test("equal weight that is not a third each", () =>
    ruleFault((f) => {
      f.engines.naive.money = { crypto: 0.4, us_equities: 0.3, gold: 0.3 };
    }, /naive: the money shares are not 1\/3 each/));
  test("a risk budget that misses 0.9", () =>
    ruleFault((f) => {
      f.engines.risk_budget.money = { ...f.engines.equal_risk.money };
      f.engines.risk_budget.risk = { ...f.engines.equal_risk.risk };
    }, /risk_budget: the classes do not carry their risk budget/));
  test("a minimum variance another rule beats", () =>
    ruleFault((f) => {
      f.engines.min_variance.money = { ...f.engines.inverse_vol.money };
      f.engines.min_variance.risk = { ...f.engines.inverse_vol.risk };
      f.engines.inverse_vol.money = { ...weighting.figures.engines.min_variance.money };
      f.engines.inverse_vol.risk = { ...weighting.figures.engines.min_variance.risk };
    }, /min_variance: another risk rule has a lower variance/));
  test("money shares that do not sum to 1", () =>
    ruleFault((f) => {
      f.engines.inverse_vol.money = Object.fromEntries(Object.entries(f.engines.inverse_vol.money).map(([c, x]) => [c, x * 1.01]));
    }, /inverse_vol: the money shares sum to 1.01/));
});

// Issue 1421: the established backtest behaviours the shared calculation must
// keep (review findings AN-5, AN-6, AN-9, AN-10, AN-14), each asserted against
// a NAMED original value captured from the pre-refactor computeBacktest
// (fixtures/originals/an-behaviours.json.gz), plus the property that makes
// each one what it is. backend/tests/backtest-correlations-fidelity.test.ts
// asserts the same pins through the backend shim. Since decision D78
// (compensated arithmetic) the originals match up to rounding: same structure
// and labels, no number moved by more than rounding (support/numeric-diff.ts).
import { describe, expect, test } from "bun:test";
import { computeBacktest } from "../src/analyze/backtest.ts";
import { AN_SCENARIO_DAYS, AN_SKIPPED_DAY, anPins, anScenario } from "./support/an-scenario.ts";
import { originalFile, readOriginal } from "./support/originals.ts";
import { expectSameUpToRounding } from "./support/numeric-diff.ts";

const original = JSON.parse(readOriginal(originalFile.anBehaviours)) as { pins: Record<string, unknown>; backtest: unknown };
const s = anScenario();
const bt = computeBacktest(s.dateAxis, s.result, s.extras);
const pins = anPins(bt);

describe("AN behaviours against the named original values", () => {
  test("the whole unstripped backtest of the scenario equals the original up to rounding", () => {
    expectSameUpToRounding(JSON.stringify(bt, null, 2), JSON.stringify(original.backtest, null, 2), "AN scenario backtest");
  });

  for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
    test(`${name} equals its original value up to rounding`, () => {
      expect(name in original.pins).toBe(true);
      expectSameUpToRounding(JSON.stringify(pins[name]), JSON.stringify(original.pins[name]), name);
    });
  }

  test("AN-5: blend_hodl runs every priced day at fixed 50/50 weights and is never charged for the daily reset", () => {
    const daily = bt.mixed!.blend_hodl!._daily!;
    expect(daily.map((p) => p.date)).toEqual(AN_SCENARIO_DAYS);
    expect(bt.mixed!.blend_hodl!.transitions).toBe(0);
    // Day 2's value is exactly one daily-reset step: 0.5·ΔETH + 0.5·ΔSPX, no cost.
    const e = s.extras.eth, x = s.extras.spx;
    expect(daily[1]!.value).toBe(1 * (1 + (0.5 * (e[1]!.value / e[0]!.value - 1) + 0.5 * (x[1]!.value / x[0]!.value - 1))));
  });

  test("AN-6: strategies start at the first labelled date, baselines at the first priced date", () => {
    expect(bt.eth!.composite!.start_date).toBe("2024-01-27");
    expect(bt.eth!.eth_hodl!.start_date).toBe(AN_SCENARIO_DAYS[0]);
    expect(bt.eth!.stables_only!.start_date).toBe(AN_SCENARIO_DAYS[0]);
  });

  test("AN-9: the unlabelled day is skipped, including its market move", () => {
    const daily = bt.eth!.composite!._daily!;
    expect(daily.map((p) => p.date)).not.toContain(AN_SKIPPED_DAY);
    // 11 labelled days give 10 returns; the skipped day contributes none.
    expect(daily.length).toBe(11);
    expect(bt.eth!.composite!.n_days).toBe(10);
  });

  test("AN-10: out-of-sample CAGR starts from the first point after the split and counts years from the split", () => {
    const m = bt.eth!.composite!;
    const after = m._daily!.filter((p) => p.date > "2024-01-31");
    const years = (+new Date(m.end_date) - +new Date("2024-01-31")) / (365.25 * 86400 * 1000);
    // D78: expm1(log(ratio) / years), the same quantity as ratio^(1/years) - 1
    // without the cancellation in the final "- 1".
    const ratio = after[after.length - 1]!.value / after[0]!.value;
    // The SDK keeps the ratio unrounded (double-double); rounding it first moves
    // the result by up to (1 + cagr) * (eps / 2) / years, plus a few ulps.
    const formula = Math.expm1(Math.log(ratio) / years);
    const bound = (1 + Math.abs(formula)) * (Number.EPSILON / 2 / years) + 4 * Number.EPSILON * Math.abs(formula);
    expect(Math.abs(m.cagr_out_sample! - formula)).toBeLessThanOrEqual(bound);
    expect(Math.abs(m.cagr_out_sample! - (Math.pow(ratio, 1 / years) - 1))).toBeLessThanOrEqual(2 * bound);
  });

  test("AN-14: Sharpe uses pre-cost daily returns while the net value carries the rebalance cost", () => {
    const m = bt.eth!.composite!;
    expect(m.transitions).toBeGreaterThan(0);
    // Rebuild the pre-cost daily returns from the net values by undoing each
    // day's close-of-day cost; their Sharpe is the reported one.
    const daily = m._daily!;
    const labels = new Map(s.dateAxis.map((d, i) => [d, s.result.regime[i]]));
    const w = (l: string | null | undefined) => (l === "risk_on" ? 1 : l === "neutral" ? 0.5 : 0);
    const preCost: number[] = [];
    for (let i = 1; i < daily.length; i++) {
      const prevW = w(labels.get(daily[i - 1]!.date));
      const curW = w(labels.get(daily[i]!.date));
      const cost = prevW !== curW ? 1 - Math.abs(curW - prevW) * 0.001 : 1;
      preCost.push(daily[i]!.value / cost / daily[i - 1]!.value - 1);
    }
    const mean = preCost.reduce((a, b) => a + b, 0) / preCost.length;
    const sd = Math.sqrt(preCost.reduce((a, b) => a + (b - mean) ** 2, 0) / (preCost.length - 1));
    expect(Math.abs((mean * 365) / (sd * Math.sqrt(365)) - m.sharpe!)).toBeLessThan(1e-9);
    // The net final value is below the cost-free compounding of the same returns.
    expect(m.final_value!).toBeLessThan(preCost.reduce((v, r) => v * (1 + r), 1));
  });
});

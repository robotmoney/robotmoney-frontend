// Issue 1421: the established backtest behaviours the shared calculation must
// keep (review findings AN-5, AN-6, AN-9, AN-10, AN-14), each asserted against
// a NAMED original value captured from the pre-refactor computeBacktest
// (fixtures/originals/an-behaviours.json.gz), plus the property that makes
// each one what it is. backend/tests/backtest-correlations-fidelity.test.ts
// asserts the same pins through the backend shim. Since decision D78
// (compensated arithmetic) the originals match up to rounding: same structure
// and labels, no number moved by more than rounding (support/numeric-diff.ts).
// Issue 1559 replaced AN-6: every line of a market now starts on the
// strategies' first labelled date. The original is compared with that rule
// applied (support/issue-1559.ts), and the pins are read from it.
import { describe, expect, test } from "bun:test";
import { computeBacktest } from "../src/analyze/backtest.ts";
import { AN_SCENARIO_DAYS, AN_SKIPPED_DAY, anPins, anScenario } from "./support/an-scenario.ts";
import { originalFile, readOriginal } from "./support/originals.ts";
import { expectSameUpToRounding } from "./support/numeric-diff.ts";
import { apply1559 } from "./support/issue-1559.ts";
import type { BacktestPayload } from "../src/analyze/backtest.ts";

const original = JSON.parse(readOriginal(originalFile.anBehaviours)) as { pins: Record<string, unknown>; backtest: BacktestPayload };
const expected = apply1559(original.backtest);
const expectedPins = anPins(expected) as Record<string, unknown>;
// The pins issue 1559 moves: the baselines' daily values, starts and growth.
const MOVED_BY_1559 = new Set(["AN-5 blend_hodl daily values (mixed)", "AN-6 baseline start (eth_hodl)", "AN-6 baseline start (stables_only)", "AN-10 cagr_out_sample (mixed blend_hodl)"]);
const s = anScenario();
const bt = computeBacktest(s.dateAxis, s.result, s.extras);
const pins = anPins(bt);

describe("AN behaviours against the named original values", () => {
  test("the whole unstripped backtest of the scenario equals the original, under the issue 1559 rule, up to rounding", () => {
    expectSameUpToRounding(JSON.stringify(bt, null, 2), JSON.stringify(expected, null, 2), "AN scenario backtest");
  });

  for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
    test(`${name} equals its original value up to rounding`, () => {
      expect(name in original.pins).toBe(true);
      // A pin issue 1559 does not move is still the captured original.
      if (!MOVED_BY_1559.has(name)) expectSameUpToRounding(JSON.stringify(expectedPins[name]), JSON.stringify(original.pins[name]), `${name} (original)`);
      expectSameUpToRounding(JSON.stringify(pins[name]), JSON.stringify(expectedPins[name]), name);
    });
  }

  test("AN-5: blend_hodl runs every day from the start at fixed 50/50 weights and is never charged for the daily reset", () => {
    const daily = bt.mixed!.blend_hodl!._daily!;
    expect(daily.map((p) => p.date)).toEqual(AN_SCENARIO_DAYS.slice(2));
    expect(bt.mixed!.blend_hodl!.transitions).toBe(0);
    // The day after the start is exactly one daily-reset step: 0.5·ΔETH + 0.5·ΔSPX, no cost.
    const e = s.extras.eth, x = s.extras.spx;
    expect(daily[0]!.value).toBe(1);
    expect(daily[1]!.value).toBe(1 * (1 + (0.5 * (e[3]!.value / e[2]!.value - 1) + 0.5 * (x[3]!.value / x[2]!.value - 1))));
  });

  test("AN-6 (issue 1559): every strategy and baseline of a market starts on the first labelled date, at 1", () => {
    for (const market of Object.values(bt)) {
      for (const m of Object.values(market)) {
        expect(m.start_date).toBe("2024-01-27");
        expect(m.equity_curve[0]).toEqual({ date: "2024-01-27", value: 1 });
      }
    }
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

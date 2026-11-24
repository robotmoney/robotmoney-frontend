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
//
// Issue 1734 (D94): the backtest no longer equals the original numbers: a label trades
// one session later, a trade waits for an open market, Sharpe is post-cost and net of
// cash, and the cash leg is a bond-equivalent yield. The behaviours below still hold,
// read with those rules, and the pin names are still the original's.
import { describe, expect, test } from "bun:test";
import { computeBacktest, discountToYield } from "../src/analyze/backtest.ts";
import { periodicRate } from "../src/transform/exact.ts";
import { AN_SCENARIO_DAYS, AN_SKIPPED_DAY, anPins, anScenario } from "./support/an-scenario.ts";
import { originalFile, readOriginal } from "./support/originals.ts";
import { shapeDiffs } from "./support/shape-diff.ts";
import { apply1559 } from "./support/issue-1559.ts";

const original = JSON.parse(readOriginal(originalFile.anBehaviours)) as { pins: Record<string, unknown>; backtest: Parameters<typeof apply1559>[0] };
const s = anScenario();
// AN-10 needs a year on each side of the split: the scenario predates the adoption date, so it splits where the original did.
const bt = computeBacktest(s.dateAxis, s.result, s.extras, { splitDate: "2024-01-31" });
const pins = anPins(bt);
// The first label is dated 2024-01-27; it trades the next session.
const START = "2024-01-28";
const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe("AN behaviours (issue 1421), read with next-session execution (issue 1734)", () => {
  test("the pins are the original's, in the original's order, and the report keeps its shape", () => {
    expect(Object.keys(pins)).toEqual(Object.keys(original.pins));
    expect(shapeDiffs(bt, apply1559(original.backtest))).toEqual([]);
  });

  test("AN-5: blend_hodl runs every day from the start at fixed 50/50 weights and is never charged for the daily reset", () => {
    const daily = bt.mixed!.blend_hodl!._daily!;
    expect(daily.map((p) => p.date)).toEqual(AN_SCENARIO_DAYS.slice(3));
    expect(bt.mixed!.blend_hodl!.transitions).toBe(0);
    // The day after the start is exactly one daily-reset step: 0.5·ΔETH + 0.5·ΔSPX, no cost.
    const e = s.extras.eth, x = s.extras.spx;
    expect(daily[0]!.value).toBe(1);
    expect(daily[1]!.value).toBe(1 * (1 + (0.5 * (e[4]!.value / e[3]!.value - 1) + 0.5 * (x[4]!.value / x[3]!.value - 1))));
  });

  test("AN-6 (issue 1559): every strategy and baseline of a market starts on the first label's next session, at 1", () => {
    for (const market of Object.values(bt)) {
      for (const m of Object.values(market)) {
        expect(m.start_date).toBe(START);
        expect(m.equity_curve[0]).toEqual({ date: START, value: 1 });
      }
    }
  });

  test("AN-9: the unlabelled day has no weights, so the next session is skipped with its market move", () => {
    const daily = bt.eth!.composite!._daily!;
    expect(AN_SKIPPED_DAY).toBe("2024-01-28");
    expect(daily.map((p) => p.date)).not.toContain(dayAfter(AN_SKIPPED_DAY));
    expect(daily.length).toBe(AN_SCENARIO_DAYS.length - 3 - 1);
    expect(bt.eth!.composite!.n_days).toBe(daily.length - 1);
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
    // The labelled blocks split on the same day.
    expect(m.sample_split_date).toBe("2024-01-31");
    expect(m.in_sample.end_date! <= "2024-01-31").toBe(true);
    expect(m.out_of_sample.start_date! > "2024-01-31").toBe(true);
  });

  test("AN-14: Sharpe uses post-cost daily returns in excess of cash, and the net value carries the rebalance cost", () => {
    const m = bt.eth!.composite!;
    expect(m.transitions).toBeGreaterThan(0);
    // Rebuild the post-cost daily returns from the net values and take off that
    // day's cash return (the 5.25 DTB3 quote as a bond-equivalent yield).
    const daily = m._daily!;
    const cash = periodicRate(discountToYield(5.25) / 100, 365);
    const excess: number[] = [];
    for (let i = 1; i < daily.length; i++) excess.push(daily[i]!.value / daily[i - 1]!.value - 1 - cash);
    const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
    const sd = Math.sqrt(excess.reduce((a, b) => a + (b - mean) ** 2, 0) / (excess.length - 1));
    expect(Math.abs((mean * 365) / (sd * Math.sqrt(365)) - m.sharpe!)).toBeLessThan(1e-9);
  });
});

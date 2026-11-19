// Issue 1554: the declared fill-policy cases every simulator must pass. Called
// from tests/backtest.test.ts (simulatePortfolio) and
// tests/backtest-drift.test.ts (simulateDrift), so both simulators are held to
// the same rules: a gap the policy covers runs, an uncovered gap on a held day
// throws a RangeError naming the series, the date and the policy, a gap on a day
// the series is not held runs, the cash rate earns zero before its first
// observation, and a missing or unknown `fill` entry is refused.
import { describe, expect, test } from "bun:test";
import { withDefaultSimulatorFill, type DeclaredFill, type Schedule, type SimulationResult, type SimulatorFill } from "../../src/analyze/backtest.ts";
import type { Point } from "../../src/types.ts";

type Sim = (dateAxis: readonly string[], schedule: Schedule, prices: Record<string, Point[]>, cashRate: Point[], options?: { fill?: SimulatorFill }) => SimulationResult;

const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
const AXIS = Array.from({ length: 12 }, (_, i) => day(i));
// A price on each listed axis index, rising 1% a day.
const priced = (idx: number[]): Point[] => idx.map((i) => ({ date: day(i), value: 100 * 1.01 ** i }));
const all = (except: number[] = []) => AXIS.map((_, i) => i).filter((i) => !except.includes(i));
const every = <T>(w: T) => AXIS.map(() => w);

export const forward = (maxAgeDays: number | null): DeclaredFill => ({ kind: "forward", maxAgeDays, reason: "test" });
export const NONE: DeclaredFill = { kind: "none", reason: "test" };
export const ZERO: DeclaredFill = { kind: "zero", reason: "test" };

export function simulatorFillCases(name: string, sim: Sim): void {
  describe(`${name}: declared fill policies (issue 1554)`, () => {
    // Observations on days 0, 1 and 7: days 2..6 carry day 1's price at ages 1..5.
    const gap5 = priced([0, 1, ...all().filter((i) => i >= 7)]);
    // Observations on days 0, 1 and 6: days 2..5 carry day 1's price at ages 1..4.
    const gap4 = priced([0, 1, ...all().filter((i) => i >= 6)]);
    const held = every({ A: 1 });

    test("forward 4: a carried age of 5 on a held day throws naming the asset, the date and the policy; age 4 runs", () => {
      expect(() => sim(AXIS, held, { A: gap5 }, [], { fill: { A: forward(4) } })).toThrow(RangeError);
      expect(() => sim(AXIS, held, { A: gap5 }, [], { fill: { A: forward(4) } })).toThrow(`price "A" has no value on ${day(6)} (fill forward 4 days)`);
      const ok = sim(AXIS, held, { A: gap4 }, [], { fill: { A: forward(4) } });
      expect(ok).toEqual(sim(AXIS, held, { A: gap4 }, []));
    });

    test("forward with no age limit runs the same gap, with the undeclared carry's values", () => {
      const run = sim(AXIS, held, { A: gap5 }, [], { fill: { A: forward(null), cash: forward(null) } });
      expect(run).toEqual(sim(AXIS, held, { A: gap5 }, []));
      expect(run.values.length).toBe(AXIS.length);
    });

    test("none: a 1-day gap on a held day throws", () => {
      expect(() => sim(AXIS, held, { A: priced(all([3])) }, [], { fill: { A: NONE } })).toThrow(`price "A" has no value on ${day(3)} (fill none)`);
    });

    test("a gap on a day the asset's held weight is 0 runs", () => {
      const out = sim(AXIS, every({ A: 0, cash: 1 }), { A: priced(all([3, 4, 5])) }, [], { fill: { A: NONE } });
      expect(out.values.map((p) => p.value)).toEqual(every(1));
    });

    test("a cash rate declared forward 4 with a 5-day gap after its first observation throws while cash is held", () => {
      const rate = AXIS.map((d) => ({ date: d, value: 5 })).filter((_, i) => i < 2 || i >= 7);
      expect(() => sim(AXIS, every({ cash: 1 }), {}, rate, { fill: { cash: forward(4) } })).toThrow(`the cash rate has no value on ${day(6)} (fill forward 4 days)`);
      expect(() => sim(AXIS, every({ cash: 1 }), {}, rate, { fill: { cash: forward(5) } })).not.toThrow();
    });

    test("a cash rate with no observation before day 3 earns zero on days 1 and 2 under every policy", () => {
      const rate = AXIS.map((d) => ({ date: d, value: 5 })).slice(3);
      for (const f of [NONE, forward(4), forward(null), ZERO]) {
        const out = sim(AXIS, every({ cash: 1 }), {}, rate, { fill: { cash: f } });
        expect(out.values.slice(0, 4).map((p) => p.value)).toEqual([1, 1, 1, 1]);
        expect(out.values[4]!.value).toBeGreaterThan(1);
      }
    });

    test("with DEFAULT_SIMULATOR_FILL null, a missing fill entry for a price or for cash throws naming it", () => {
      const undeclared = sim(AXIS, held, { A: gap4 }, []);
      withDefaultSimulatorFill(null, () => {
        expect(() => sim(AXIS, held, { A: gap4 }, [], { fill: { cash: forward(null) } })).toThrow('fill policy missing for price "A"');
        expect(() => sim(AXIS, held, { A: gap4 }, [], { fill: { A: forward(null) } })).toThrow("fill policy missing for the cash rate");
        expect(() => sim(AXIS, held, { A: gap4 }, [])).toThrow(RangeError);
        // Every series declared: runs, with the values the shipped default gives.
        expect(sim(AXIS, held, { A: gap4 }, [], { fill: { A: forward(null), cash: forward(null) } })).toEqual(undeclared);
      });
    });

    test("a fill key that names no series throws naming the key; an invalid policy throws", () => {
      expect(() => sim(AXIS, held, { A: gap4 }, [], { fill: { Z: forward(null) } })).toThrow(/fill key "Z" names no series/);
      expect(() => sim(AXIS, held, { A: gap4 }, [], { fill: { A: { kind: "forward", maxAgeDays: 0, reason: "r" } } })).toThrow(RangeError);
      expect(() => sim(AXIS, held, { A: gap4 }, [], { fill: { A: { kind: "forward", maxAgeDays: 4 } as never } })).toThrow(/reason|fillReason/);
    });

    test("non-vacuity: DEFAULT_SIMULATOR_FILL forward 4 turns values into a RangeError over a 5-day gap on a held day", () => {
      expect(sim(AXIS, held, { A: gap5 }, []).values.length).toBe(AXIS.length);
      withDefaultSimulatorFill(forward(4), () => {
        expect(() => sim(AXIS, held, { A: gap5 }, [])).toThrow(`price "A" has no value on ${day(6)} (fill forward 4 days)`);
      });
    });
  });
}

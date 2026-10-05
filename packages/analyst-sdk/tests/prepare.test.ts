// prepareRegimeInputs unit tests with synthetic registries. The shipped registry
// has no zero_fill indicator, so these are the only red controls for that branch,
// for lastRaw, and for the empty-series rule (all NaN, for every transform).
import { describe, expect, test } from "bun:test";
import { prepareRegimeInputs } from "../src/prepare.ts";
import type { Indicator } from "../src/analyze/indicators.ts";

const mk = (id: string, transform: string, align?: "zero_fill"): Indicator => ({
  id, name: id, panel: "macro", source: "test", sign: 1, transform, unit: "x", ...(align ? { align } : {}),
});
const TRANSFORMS = ["level", "change30", "change90", "sma4", "sma7", "trend_50_200", "rolling_sum_7"];
const START = "2024-01-01";
const ASOF = "2024-01-10";

describe("prepareRegimeInputs", () => {
  test("zero_fill: gaps are 0, no age is produced; forward-fill carries the value and has an age", () => {
    const rows = [{ date: "2024-01-03", value: 5 }, { date: "2024-01-06", value: 7 }];
    const p = prepareRegimeInputs(
      { Z: rows, F: rows },
      { start: START, asof: ASOF, indicators: [mk("Z", "level", "zero_fill"), mk("F", "level")] },
    );
    expect(p.dateAxis.length).toBe(10);
    expect(p.transformed.Z).toEqual([NaN, NaN, 5, 0, 0, 7, 0, 0, 0, 0]);
    expect(p.transformed.F).toEqual([NaN, NaN, 5, 5, 5, 7, 7, 7, 7, 7]);
    expect("Z" in p.ages).toBe(false);
    expect(p.ages.F).toEqual([NaN, NaN, 0, 1, 2, 0, 1, 2, 3, 4]);
  });

  test("lastRaw is each series' last row as given (even after asof) and null when empty or absent", () => {
    const p = prepareRegimeInputs(
      { A: [{ date: "2024-01-02", value: 1 }, { date: "2024-01-20", value: 9 }], E: [] },
      { start: START, asof: ASOF, indicators: [mk("A", "level"), mk("E", "level"), mk("M", "level")] },
    );
    expect(p.lastRaw.A).toEqual({ date: "2024-01-20", value: 9 });
    expect(p.lastRaw.E).toBeNull();
    expect(p.lastRaw.M).toBeNull();
    // The row after asof never reaches the axis.
    expect(p.transformed.A!.length).toBe(10);
    expect(p.transformed.A![9]).toBe(1);
  });

  test("an empty or absent series is all NaN for every transform and zero_fill, with ages still NaN-filled for forward-fill", () => {
    const inds = TRANSFORMS.flatMap((t) => [mk(`E_${t}`, t), mk(`Z_${t}`, t, "zero_fill")]);
    const p = prepareRegimeInputs({ E_level: [] }, { start: START, asof: ASOF, indicators: inds });
    for (const ind of inds) {
      expect(p.transformed[ind.id]!.length).toBe(10);
      expect(p.transformed[ind.id]!.every(Number.isNaN)).toBe(true);
      expect(ind.id in p.ages).toBe(ind.align !== "zero_fill");
      if (ind.align !== "zero_fill") expect(p.ages[ind.id]!.every(Number.isNaN)).toBe(true);
    }
  });
});

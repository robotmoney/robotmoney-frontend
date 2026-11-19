// Issue 1421 (review TEST-export-coverage): every exported helper the review
// found without a package test (applyRatio, ratioByDate, shapeDaily,
// combineConservativeN, combineAggressiveN) gets a happy, an error and an edge
// case. None of them throws: the "error" case is the input they reject, and
// the assertion is the documented rejected result (NaN, a dropped row, null).
import { describe, expect, test } from "bun:test";
import { applyRatio } from "../src/transform/transforms.ts";
import { mergeRatioSeries, shapeDaily } from "../src/transform/grid.ts";
import { combineAggressiveN, combineConservativeN, REFERENCE_FILL_POLICIES, referenceStrategies } from "../src/analyze/backtest.ts";
import { PLAIN_DECIMAL, parsePlainDecimal } from "../src/input/load.ts";

describe("applyRatio", () => {
  test("happy: element-wise numerator / denominator", () => {
    expect(applyRatio([2, 9, 1], [4, 3, 8])).toEqual([0.5, 3, 0.125]);
  });
  test("error: a zero or non-finite operand gives NaN at that index, never Infinity", () => {
    const out = applyRatio([1, NaN, 3, 4], [0, 2, Infinity, NaN]);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });
  test("edge: unequal lengths are cut to the shorter; empty input gives an empty array", () => {
    expect(applyRatio([6, 8, 10], [3, 4])).toEqual([2, 2]);
    expect(applyRatio([], [1, 2])).toEqual([]);
  });
});

// ratioByDate is gone (SDK-10): mergeRatioSeries is the one ratio function.
describe("mergeRatioSeries", () => {
  const a = [{ date: "2024-01-01", value: 10 }, { date: "2024-01-02", value: 12 }, { date: "2024-01-03", value: 9 }];
  test("happy: a/b on the dates both series share, in a's order", () => {
    const b = [{ date: "2024-01-03", value: 3 }, { date: "2024-01-01", value: 5 }];
    expect(mergeRatioSeries(a, b)).toEqual([{ date: "2024-01-01", value: 2 }, { date: "2024-01-03", value: 3 }]);
  });
  test("error: a zero denominator drops the row instead of producing Infinity", () => {
    expect(mergeRatioSeries(a, [{ date: "2024-01-02", value: 0 }])).toEqual([]);
  });
  test("edge: no shared date, or an empty series, gives an empty result", () => {
    expect(mergeRatioSeries(a, [{ date: "2023-12-31", value: 1 }])).toEqual([]);
    expect(mergeRatioSeries([], a)).toEqual([]);
  });
});

describe("shapeDaily", () => {
  test("happy: a gappy series is forward-filled onto lookbackDays consecutive days ending at asof", () => {
    const out = shapeDaily([{ date: "2024-01-02", value: 1 }, { date: "2024-01-04", value: 3 }], "2024-01-05", 4);
    expect(out).toEqual([
      { date: "2024-01-02", value: 1 },
      { date: "2024-01-03", value: 1 },
      { date: "2024-01-04", value: 3 },
      { date: "2024-01-05", value: 3 },
    ]);
  });
  test("error: no finite observation on or before asof gives null", () => {
    expect(shapeDaily([{ date: "2024-02-01", value: 5 }, { date: "2024-01-01", value: NaN }], "2024-01-31", 3)).toBeNull();
    expect(shapeDaily([], "2024-01-31", 3)).toBeNull();
  });
  test("edge: days before the first observation are back-filled with it, unsorted input is sorted", () => {
    const out = shapeDaily([{ date: "2024-01-05", value: 7 }, { date: "2024-01-04", value: 6 }], "2024-01-05", 4);
    expect(out!.map((p) => p.value)).toEqual([6, 6, 6, 7]);
  });
});

describe("combineConservativeN", () => {
  test("happy: any risk_off wins; all risk_on is risk_on; otherwise neutral", () => {
    expect(combineConservativeN(["risk_on", "risk_off", "risk_on"])).toBe("risk_off");
    expect(combineConservativeN(["risk_on", "risk_on"])).toBe("risk_on");
    expect(combineConservativeN(["risk_on", "neutral"])).toBe("neutral");
  });
  test("error: any missing panel label gives null (an unlabelled day)", () => {
    expect(combineConservativeN(["risk_on", null])).toBeNull();
    expect(combineConservativeN([null, "risk_off"])).toBeNull();
  });
  test("edge: the 2-panel truth table of the original, and an empty panel list", () => {
    expect(combineConservativeN(["neutral", "neutral"])).toBe("neutral");
    expect(combineConservativeN(["risk_off", "neutral"])).toBe("risk_off");
    // every() over no labels is true: an empty list reads as all risk_on.
    expect(combineConservativeN([])).toBe("risk_on");
  });
});

describe("combineAggressiveN", () => {
  test("happy: the sign of the vote (risk_on +1, risk_off -1) decides", () => {
    expect(combineAggressiveN(["risk_on", "neutral", "risk_off", "risk_on"])).toBe("risk_on");
    expect(combineAggressiveN(["risk_off", "neutral"])).toBe("risk_off");
  });
  test("error: any missing panel label gives null (an unlabelled day)", () => {
    expect(combineAggressiveN(["risk_on", null, "risk_on"])).toBeNull();
  });
  test("edge: a tied vote is neutral, and an empty panel list is neutral", () => {
    expect(combineAggressiveN(["risk_on", "risk_off"])).toBe("neutral");
    expect(combineAggressiveN(["neutral", "neutral"])).toBe("neutral");
    expect(combineAggressiveN([])).toBe("neutral");
  });
});

// Issue 1554: the helpers a backtest client copies.
describe("parsePlainDecimal and PLAIN_DECIMAL", () => {
  test("happy: a finite number or a plain decimal string is its number", () => {
    expect(parsePlainDecimal("1.5")).toBe(1.5);
    expect(parsePlainDecimal(2)).toBe(2);
    expect(PLAIN_DECIMAL.test("-2E+4")).toBe(true);
  });
  test("error: an overflowing, blank, word, hex or padded value, NaN and Infinity throw RangeError", () => {
    for (const v of ["1e400", "", "abc", "0x10", " 1", NaN, Infinity]) expect(() => parsePlainDecimal(v)).toThrow(RangeError);
  });
  test("edge: '1e400' matches the pattern but is not finite, so it is refused", () => {
    expect(PLAIN_DECIMAL.test("1e400")).toBe(true);
    expect(() => parsePlainDecimal("1e400")).toThrow(/1e400/);
  });
});

describe("referenceStrategies and REFERENCE_FILL_POLICIES", () => {
  const regime = ["risk_on", "risk_off", null];
  const panelRegimes = { macro: ["risk_on", "risk_off", "neutral"], onchain: ["risk_on", "neutral", "neutral"] };
  test("happy: composite, one per panel, macro_inverted, conservative and aggressive", () => {
    const s = referenceStrategies({ regime, panelRegimes });
    expect(Object.keys(s)).toEqual(["composite", "macro", "onchain", "macro_inverted", "conservative", "aggressive"]);
    expect(s.macro_inverted).toEqual(["risk_off", "risk_on", "neutral"]);
    expect(s.conservative).toEqual(["risk_on", "risk_off", "neutral"]);
    expect(s.aggressive).toEqual(["risk_on", "risk_off", "neutral"]);
  });
  test("error: a missing panel label gives a null conservative and aggressive label", () => {
    const s = referenceStrategies({ regime, panelRegimes: { macro: ["risk_on", null, "neutral"], onchain: panelRegimes.onchain } });
    expect(s.conservative![1]).toBeNull();
    expect(s.aggressive![1]).toBeNull();
  });
  test("edge: with no macro panel there is no macro_inverted; the reference policies are forward with no age limit", () => {
    const s = referenceStrategies({ regime, panelRegimes: { onchain: panelRegimes.onchain }, panels: ["onchain"] });
    expect(Object.keys(s)).toEqual(["composite", "onchain", "conservative", "aggressive"]);
    for (const p of Object.values(REFERENCE_FILL_POLICIES)) expect(p).toMatchObject({ kind: "forward", maxAgeDays: null });
  });
});

// Issue 1653: the collected-series registry. BAA10Y is fetched, stored and
// served, never scored; collectionRegistry() is INDICATORS then
// COLLECTED_SERIES, and an id in both throws.
import { describe, expect, test } from "bun:test";
import { COLLECTED_SERIES, collectionRegistry, INDICATORS, PANELS } from "../src/index.ts";
import { sourceCalendar } from "../src/extract/floor-seed-calendar.ts";

describe("COLLECTED_SERIES and collectionRegistry() (issue 1653)", () => {
  test("COLLECTED_SERIES holds the BAA10Y entry: fred, series BAA10Y, unit percent, a FRED source_url", () => {
    expect(COLLECTED_SERIES.map((s) => s.id)).toEqual(["BAA10Y"]);
    const baa = COLLECTED_SERIES[0]!;
    expect(baa).toMatchObject({
      id: "BAA10Y",
      name: "Baa corporate credit spread",
      source: "fred",
      series: "BAA10Y",
      unit: "percent",
      source_url: "https://fred.stlouisfed.org/series/BAA10Y",
    });
    expect(baa.description).toMatch(/Moody's seasoned Baa/);
    expect(baa.description).toMatch(/10-year Treasury/);
    expect(baa.description).toMatch(/daily by FRED/);
  });

  test("an entry carries no scoring field", () => {
    for (const s of COLLECTED_SERIES) {
      for (const field of ["panel", "sign", "transform", "fill", "fillReason", "weight"]) expect(field in s).toBe(false);
    }
  });

  test("collectionRegistry() returns INDICATORS then COLLECTED_SERIES, in order", () => {
    expect(collectionRegistry().map((s) => s.id)).toEqual([...INDICATORS.map((i) => i.id), ...COLLECTED_SERIES.map((s) => s.id)]);
    expect(collectionRegistry().slice(0, INDICATORS.length)).toEqual(INDICATORS);
  });

  test("an id declared in both lists, or twice, throws", () => {
    const dup = { id: "T10Y2Y", name: "dup", source: "fred", series: "T10Y2Y", unit: "percent" };
    expect(() => collectionRegistry(INDICATORS, [dup])).toThrow(/T10Y2Y is declared twice/);
    expect(() => collectionRegistry([], [dup, dup])).toThrow(/declared twice/);
    expect(() => collectionRegistry(INDICATORS, COLLECTED_SERIES)).not.toThrow();
  });

  test("the scoring registry is unchanged: no BAA10Y in INDICATORS, PANELS stays macro and onchain", () => {
    expect(INDICATORS.some((i) => i.id === "BAA10Y")).toBe(false);
    expect(PANELS).toEqual(["macro", "onchain"]);
  });

  test("sourceCalendar reads the combined list: BAA10Y is business_day", () => {
    expect(sourceCalendar("BAA10Y")).toBe("business_day");
    expect(sourceCalendar("ICSA")).toBe("weekly_saturday");
    expect(sourceCalendar("NOT_COLLECTED")).toBe("any");
  });
});

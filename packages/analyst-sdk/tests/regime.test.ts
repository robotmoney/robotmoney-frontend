import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CsvHeaderError,
  InputRowError,
  buildReport,
  parseRawCsv,
  parseRawHistory,
  runRegime,
  toHistory,
} from "../src/index.ts";

const DIR = import.meta.dir;
const csvText = await Bun.file(join(DIR, "fixtures/raw-indicator-history.csv")).text();
const jsonText = await Bun.file(join(DIR, "fixtures/raw-indicator-history.json")).text();
const goldenText = await Bun.file(join(DIR, "golden/regime-report.json")).text();

const report = (text: string) => JSON.stringify(buildReport(runRegime(toHistory(parseRawHistory(text)))), null, 2);

describe("analyst-sdk regime", () => {
  test("globalThis.fetch is the preload thrower", () => {
    expect(() => fetch("http://localhost")).toThrow(/must not use the network/);
  });

  test("CSV fixture and JSON fixture give byte-identical regime output", () => {
    expect(report(jsonText)).toBe(report(csvText));
  });

  test("the CLI report reproduces the golden output", () => {
    expect(report(csvText) + "\n").toBe(goldenText);
  });

  test("correlation and backtest output is present when SPX, ETH and TBILL3M are supplied", () => {
    const r = buildReport(runRegime(toHistory(parseRawCsv(csvText))));
    expect(r.correlations).not.toBeNull();
    expect(r.backtest).not.toBeNull();
    expect(r.regime.label).toBeTruthy();
  });
});

describe("input loader", () => {
  test("a header that does not match date,indicator,value,source raises CsvHeaderError", () => {
    for (const bad of ["date,indicator,value\n2024-01-01,X,1", "indicator,date,value,source\n", "", "Date,indicator,value,source\n"]) {
      expect(() => parseRawCsv(bad)).toThrow(CsvHeaderError);
    }
    expect(() => parseRawCsv("date,indicator,value\n")).toThrow(/CSV header must be exactly/);
  });

  test("bad rows raise InputRowError with the row number", () => {
    const head = "date,indicator,value,source\n";
    expect(() => parseRawCsv(head + "2024-01-01,X,abc,s")).toThrow(InputRowError);
    expect(() => parseRawCsv(head + "01/01/2024,X,1,s")).toThrow(/row 2/);
    expect(() => parseRawCsv(head + "2024-01-01,X,1")).toThrow(InputRowError);
  });

  test("a repeated (indicator, date) keeps the last row and series sort ascending", () => {
    const h = toHistory(parseRawCsv("date,indicator,value,source\n2024-01-02,X,2,a\n2024-01-01,X,1,a\n2024-01-02,X,3,b\n"));
    expect(h.X).toEqual([{ date: "2024-01-01", value: 1 }, { date: "2024-01-02", value: 3 }]);
  });
});

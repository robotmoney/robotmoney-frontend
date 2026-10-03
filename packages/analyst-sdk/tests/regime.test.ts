import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  CsvHeaderError,
  CsvQuotedFieldError,
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

// The regime computation is the slow part (seconds under CPU load). Compute each
// report ONCE here, at module scope, and let every test assert on the results.
// The generous timeout is a backstop for a loaded CI box, not a budget: with the
// work done up front, no test below does anything heavier than a string compare.
const TEST_TIMEOUT_MS = 120_000;
setDefaultTimeout(TEST_TIMEOUT_MS);

const reportObject = buildReport(runRegime(toHistory(parseRawHistory(csvText))));
const csvReport = JSON.stringify(reportObject, null, 2);
const jsonReport = JSON.stringify(buildReport(runRegime(toHistory(parseRawHistory(jsonText)))), null, 2);

describe("analyst-sdk regime", () => {
  test("globalThis.fetch is the preload thrower", () => {
    expect(() => fetch("http://localhost")).toThrow(/must not use the network/);
  }, TEST_TIMEOUT_MS);

  test("CSV fixture and JSON fixture give byte-identical regime output", () => {
    expect(jsonReport).toBe(csvReport);
  }, TEST_TIMEOUT_MS);

  test("the CLI report reproduces the golden output", () => {
    expect(csvReport + "\n").toBe(goldenText);
  }, TEST_TIMEOUT_MS);

  test("correlation and backtest output is present when SPX, ETH and TBILL3M are supplied", () => {
    expect(reportObject.correlations).not.toBeNull();
    expect(reportObject.backtest).not.toBeNull();
    expect(reportObject.regime.label).toBeTruthy();
  }, TEST_TIMEOUT_MS);
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

  test("a quoted field raises the named CsvQuotedFieldError, which is also an InputRowError", () => {
    const head = "date,indicator,value,source\n";
    for (const row of ['2024-01-01,"X",1,s', '2024-01-01,X,1,"s"', '2024-01-01,X,"1",s', '2024-01-01,"X,Y",1,s']) {
      expect(() => parseRawCsv(head + row)).toThrow(CsvQuotedFieldError);
      expect(() => parseRawCsv(head + row)).toThrow(InputRowError);
    }
    expect(() => parseRawCsv(head + '2024-01-01,X,1,"s"')).toThrow(/quoted CSV fields are not supported/);
  }, TEST_TIMEOUT_MS);

  test("a row with more than four fields raises InputRowError", () => {
    const head = "date,indicator,value,source\n";
    expect(() => parseRawCsv(head + "2024-01-01,X,1,s,extra")).toThrow(InputRowError);
    expect(() => parseRawCsv(head + "2024-01-01,X,1,s,")).toThrow(/more/);
    expect(() => parseRawCsv(head + "2024-01-01,X,1,s,extra")).not.toThrow(CsvQuotedFieldError);
  }, TEST_TIMEOUT_MS);

  test("a BOM and CRLF line endings still parse", () => {
    const rows = parseRawCsv("\uFEFFdate,indicator,value,source\r\n2024-01-01,X,1,a\r\n2024-01-02,X,2,b\r\n");
    expect(rows).toEqual([
      { date: "2024-01-01", indicator: "X", value: 1, source: "a" },
      { date: "2024-01-02", indicator: "X", value: 2, source: "b" },
    ]);
  }, TEST_TIMEOUT_MS);
});

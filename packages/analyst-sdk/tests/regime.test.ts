import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  CsvHeaderError,
  INDICATORS,
  MAX_FORWARD_FILL_DAYS,
  forwardFillAge,
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

describe("runRegime asof, panels and forward-fill ages", () => {
  const raw = toHistory(parseRawHistory(csvText));
  const newest = Object.values(raw).reduce((m, rows) => (rows.length && rows[rows.length - 1]!.date > m ? rows[rows.length - 1]!.date : m), "");
  const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const D = addDays(newest, -30);
  const D1 = addDays(D, 1);

  test("rows after asof are ignored, equal to the input with those rows removed, and the input is not mutated", () => {
    const before = JSON.stringify(raw);
    const withTrailing = buildReport(runRegime(raw, { asof: D }), { full: true });
    expect(JSON.stringify(raw)).toBe(before);
    const trimmed: typeof raw = {};
    for (const id in raw) trimmed[id] = raw[id]!.filter((r) => r.date <= D);
    const without = buildReport(runRegime(trimmed), { full: true });
    expect(JSON.stringify(withTrailing)).toBe(JSON.stringify(without));
    expect(withTrailing.asof).toBe(D);
  }, TEST_TIMEOUT_MS);

  test("asof D vs D+1 changes only the D row (forced final-day weight refresh), by < 1e-3", () => {
    const a = buildReport(runRegime(raw, { asof: D }), { full: true }).series!;
    const b = buildReport(runRegime(raw, { asof: D1 }), { full: true }).series!;
    expect(b.length).toBe(a.length + 1);
    let differing = 0;
    for (let i = 0; i < a.length; i++) {
      if (Object.is(a[i]!.composite, b[i]!.composite) && Object.is(a[i]!.compositePercentile, b[i]!.compositePercentile) && a[i]!.regime === b[i]!.regime) continue;
      differing++;
      expect(a[i]!.date).toBe(D);
      expect(Math.abs(a[i]!.composite - b[i]!.composite)).toBeLessThan(1e-2);
    }
    expect(differing).toBeLessThanOrEqual(1);
  }, TEST_TIMEOUT_MS);

  test("a factor-panel run yields finite factor index and percentile", () => {
    const run = runRegime(raw, { panels: ["macro", "onchain", "factor"] });
    const last = run.dateAxis.length - 1;
    expect(Number.isFinite(run.result.factorIndex![last]!)).toBe(true);
    expect(Number.isFinite(run.result.factorPercentile![last]!)).toBe(true);
    const report = buildReport(run);
    expect(Number.isFinite(report.regime.panels.factor!.index!)).toBe(true);
    expect(Number.isFinite(report.regime.panels.factor!.percentile!)).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("forwardFillAge is exported and an indicator last observed >120 days before asof gets weight 0", () => {
    expect(MAX_FORWARD_FILL_DAYS).toBe(120);
    expect(forwardFillAge([{ date: "2024-01-02", value: 1 }], ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-05"])).toEqual([NaN, 0, 1, 2]);
    const victim = INDICATORS.find((i) => i.panel === "macro" && i.align !== "zero_fill" && (raw[i.id]?.length ?? 0) > 400)!;
    const baseline = buildReport(runRegime(raw, { asof: newest }));
    expect(baseline.indicators.find((i) => i.id === victim.id)!.weight).toBeGreaterThan(0);
    // Keep only the first ~100 days of the victim: its last observation is far
    // more than 120 days before asof, so every later day is aged out (NaN) and
    // too few valid observations remain in the trailing window to earn weight.
    const cutoff = addDays(raw[victim.id]![0]!.date, 100);
    const stale: typeof raw = { ...raw, [victim.id]: raw[victim.id]!.filter((r) => r.date <= cutoff) };
    const run = runRegime(stale, { asof: newest });
    const last = run.dateAxis.length - 1;
    expect(Number.isNaN(run.result.signed[victim.id]![last]!)).toBe(true);
    expect(buildReport(run).indicators.find((i) => i.id === victim.id)!.weight ?? 0).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("invalid asof, start and panels are rejected", () => {
    const bad = (o: Parameters<typeof runRegime>[1]) => expect(() => runRegime(raw, o)).toThrow(RangeError);
    for (const asof of ["banana", "", "2026-13-45", "2026-02-30", "2000-01-01", "2017-12-31"]) bad({ asof });
    bad({ start: "nope" });
    bad({ start: addDays(D, 1), asof: D });
    bad({ panels: ["bogus" as never] });
    bad({ panels: [] });
    bad({ panels: ["macro", "macro", "onchain"] });
  }, TEST_TIMEOUT_MS);

  test("the CLI rejects a trailing --asof or --panels and an empty --panels", async () => {
    const fx = join(DIR, "fixtures/raw-indicator-history.csv");
    for (const a of [["--asof"], ["--panels"], ["--panels", ""], ["--asof", "banana"]]) {
      const p = Bun.spawnSync(["bun", join(DIR, "../bin/regime.ts"), fx, ...a], { stderr: "pipe", stdout: "pipe" });
      expect(p.exitCode).not.toBe(0);
    }
  }, TEST_TIMEOUT_MS);
});

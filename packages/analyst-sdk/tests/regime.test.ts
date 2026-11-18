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
  prepareRegimeInputs,
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

describe("runRegime asof, factor and forward-fill ages", () => {
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

  test("asof D vs D+1 changes only the D row (forced final-day weight refresh), by < 1e-2", () => {
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

  test("factor:true leaves the two-panel result identical and adds finite factor figures", () => {
    const base = runRegime(raw);
    const run = runRegime(raw, { factor: true });
    expect(JSON.stringify(run.result)).toBe(JSON.stringify(base.result));
    const last = run.dateAxis.length - 1;
    expect(Number.isFinite(run.factor!.factorIndex![last]!)).toBe(true);
    expect(Number.isFinite(run.factor!.factorPercentile![last]!)).toBe(true);
    const report = buildReport(run, { full: true });
    const plain = buildReport(base, { full: true });
    const { factor, ...rest } = report as typeof report & { factor: any };
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
    expect(Number.isFinite(factor.index)).toBe(true);
    expect(Number.isFinite(factor.percentile)).toBe(true);
    expect(typeof factor.regime).toBe("string");
    expect(Object.keys(factor.weights).length).toBeGreaterThan(0);
    expect(factor.series.length).toBe(report.days);
    expect("factor" in buildReport(base)).toBe(false);
  }, TEST_TIMEOUT_MS);

  test("prepareRegimeInputs is pure, ignores rows after asof and matches runRegime", () => {
    const before = JSON.stringify(raw);
    const a = prepareRegimeInputs(raw, { start: "2018-01-01", asof: D });
    const b = prepareRegimeInputs(raw, { start: "2018-01-01", asof: D });
    expect(JSON.stringify(raw)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.dateAxis[a.dateAxis.length - 1]).toBe(D);
    const trimmed: typeof raw = {};
    for (const id in raw) trimmed[id] = raw[id]!.filter((r) => r.date <= D);
    const c = prepareRegimeInputs(trimmed, { start: "2018-01-01", asof: D });
    expect(JSON.stringify(a.transformed)).toBe(JSON.stringify(c.transformed));
    expect(JSON.stringify(a.ages)).toBe(JSON.stringify(c.ages));
    const empty = prepareRegimeInputs({}, { start: "2018-01-01", asof: "2018-01-05" });
    for (const id in empty.transformed) {
      expect(empty.transformed[id]!.length).toBe(5);
      expect(empty.transformed[id]!.every(Number.isNaN)).toBe(true);
      expect(empty.lastRaw[id]).toBeNull();
    }
    expect(Object.keys(runRegime(raw, { asof: D }).result.signed).sort()).toEqual(Object.keys(a.transformed).sort());
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

  test("invalid asof and start are rejected", () => {
    const bad = (o: Parameters<typeof runRegime>[1]) => expect(() => runRegime(raw, o)).toThrow(RangeError);
    for (const asof of ["banana", "", "2026-13-45", "2026-02-30", "2000-01-01", "2017-12-31"]) bad({ asof });
    bad({ start: "nope" });
    bad({ start: addDays(D, 1), asof: D });
    bad({ panels: ["macro", "onchain", "factor"] } as never);
    bad({ factor: "yes" } as never);
    bad({ bogus: 1 } as never);
  }, TEST_TIMEOUT_MS);

  test("the CLI rejects a trailing --start/--asof, a bad --asof and unknown flags such as --panels", async () => {
    const fx = join(DIR, "fixtures/raw-indicator-history.csv");
    for (const a of [["--asof"], ["--start"], ["--asof", "banana"], ["--panels", "macro,onchain,factor"], ["--panels"], ["--bogus"]]) {
      const p = Bun.spawnSync(["bun", join(DIR, "../bin/regime.ts"), fx, ...a], { stderr: "pipe", stdout: "pipe" });
      expect(p.exitCode).toBe(2);
    }
    // A runtime failure, not a usage error: exit 1.
    const missing = Bun.spawnSync(["bun", join(DIR, "../bin/regime.ts"), join(DIR, "fixtures/no-such-file.csv")], { stderr: "pipe", stdout: "pipe" });
    expect(missing.exitCode).toBe(1);
    const ok = Bun.spawnSync(["bun", join(DIR, "../bin/regime.ts"), fx, "--factor"], { stderr: "pipe", stdout: "pipe" });
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout.toString()).factor.index).toBeDefined();
  }, TEST_TIMEOUT_MS);
});

// D74 (issue 1423): raw_indicator_history:SPX_TREND and backtest:^GSPC both map
// to yahoo:^GSPC but are different streams. Here they hold different values on
// the same dates; each consumer must receive only its own stream, by exact
// value and version id, and the regime must not see the backtest's stream.
describe("two stored streams for one source id stay separate", async () => {
  const { SERIES_MAPPING, inputHistoryFromStorage, selectConsumerObservations } = await import("../src/series-ids.ts");
  const fixture = toHistory(parseRawHistory(csvText));
  const keyOf = new Map(SERIES_MAPPING.map((m) => [m.inputId, m.storageKey]));
  // A non-monotone change (ranks and returns move), so the correlations and backtest notice it.
  const bump = (v: number, i: number) => v * (i % 2 === 0 ? 1.02 : 0.98);
  let nextId = 1;
  const rows: Array<{ sourceKey: string; marketDate: string; value: number; versionId: string }> = [];
  for (const id of Object.keys(fixture)) {
    for (const [i, p] of fixture[id]!.entries()) {
      // The backtest's stream differs from SPX_TREND's on every shared date.
      const value = id === "SPX" ? bump(p.value, i) : p.value;
      rows.push({ sourceKey: keyOf.get(id)!, marketDate: p.date, value, versionId: String(nextId++) });
    }
  }
  const spxTrend = rows.filter((r) => r.sourceKey === "raw_indicator_history:SPX_TREND");
  const gspc = rows.filter((r) => r.sourceKey === "backtest:^GSPC");
  const shared = spxTrend.filter((r) => gspc.some((g) => g.marketDate === r.marketDate && g.value !== r.value));
  const conflicted = buildReport(runRegime(inputHistoryFromStorage(rows)));
  const golden = JSON.parse(goldenText);

  test("the fixture really holds conflicting same-date values", () => {
    expect(shared.length).toBeGreaterThan(1000);
  });

  test("each consumer receives only its own stream: exact values and version ids", () => {
    const strip = (xs: typeof rows) => xs.map((r) => ({ storageKey: r.sourceKey, date: r.marketDate, value: r.value, versionId: r.versionId }));
    const got = (c: string) => selectConsumerObservations(rows, c).map(({ series: _s, ...o }) => o);
    expect(got("indicator:SPX_TREND")).toEqual(strip(spxTrend));
    for (const c of ["correlations", "backtest"]) {
      expect(got(c).filter((o) => o.storageKey === "backtest:^GSPC")).toEqual(strip(gspc));
      expect(got(c).some((o) => o.storageKey === "raw_indicator_history:SPX_TREND")).toBe(false);
    }
    expect(selectConsumerObservations(rows, "indicator:SPX_TREND").every((o) => o.series === "yahoo:^GSPC")).toBe(true);
    expect(selectConsumerObservations(rows, "backtest").filter((o) => o.storageKey === "backtest:^GSPC").every((o) => o.series === "yahoo:^GSPC")).toBe(true);
  });

  test("neither stream is merged, overwritten or substituted in the history the run reads", () => {
    const h = inputHistoryFromStorage(rows);
    expect(h.SPX_TREND).toEqual(fixture.SPX_TREND!);
    expect(h.SPX).toEqual(fixture.SPX!.map((p, i) => ({ date: p.date, value: bump(p.value, i) })));
  });

  test("the regime reads SPX_TREND's stream (unchanged), the correlations and backtest read the backtest stream", () => {
    expect(conflicted.indicators).toEqual(golden.indicators);
    expect(conflicted.regime).toEqual(golden.regime);
    expect(JSON.stringify(conflicted.correlations)).not.toBe(JSON.stringify(golden.correlations));
    expect(JSON.stringify(conflicted.backtest)).not.toBe(JSON.stringify(golden.backtest));
  });

  test("with the original values, storage rows give the golden bytes", () => {
    const original = rows.map((r) => (r.sourceKey === "backtest:^GSPC" ? { ...r, value: fixture.SPX!.find((p) => p.date === r.marketDate)!.value } : r));
    expect(JSON.stringify(buildReport(runRegime(inputHistoryFromStorage(original))), null, 2) + "\n").toBe(goldenText);
  });
});

// Issue 1652 (methodology v5): the regime label is cut on the composite itself
// and each panel label on its panel index, never on a second rolling rank of
// it. The 5-day confirmation and the 2σ fast switch act on that same series.
// A run under v3 keeps the rank-then-cut path, so a v3 run replays exactly.
describe("v5: labels are cut on the composite and the panel indices (issue 1652)", async () => {
  const { bucketFn, smoothRegimes, regimeLabels } = await import("../src/analyze/compute.ts");
  const { rollingPercentileRank } = await import("../src/transform/math.ts");
  const { ROLLING_WINDOW_DAYS } = await import("../src/analyze/indicators.ts");
  const { CURRENT_REGIME_VERSION } = await import("../src/analyze/regime-versions.ts");
  const run = runRegime(toHistory(parseRawHistory(csvText)));
  const v3 = runRegime(toHistory(parseRawHistory(csvText)), { version: "v3" });

  test("the current version is v5, and the report and run carry the version they computed", () => {
    expect(CURRENT_REGIME_VERSION).toBe("v5");
    expect(run.version).toBe("v5");
    expect(reportObject.version).toBe("v5");
    expect(v3.version).toBe("v3");
    expect(buildReport(v3).version).toBe("v3");
  });

  test("a synthetic composite inside 0.33 to 0.67 whose rolling rank falls below 0.33 is neutral every day", () => {
    // Three years near 0.6, then a slow slide to 0.36: always inside the cut-offs,
    // while the rolling rank of the slide sinks to the bottom of its window.
    const n = ROLLING_WINDOW_DAYS + 400;
    const composite = Array.from({ length: n }, (_, i) =>
      (i < ROLLING_WINDOW_DAYS ? 0.6 : 0.6 - (0.24 * (i - ROLLING_WINDOW_DAYS)) / 400) + 0.01 * Math.sin(i / 7),
    );
    for (const c of composite) {
      expect(c).toBeGreaterThanOrEqual(0.33);
      expect(c).toBeLessThanOrEqual(0.67);
    }
    const rank = rollingPercentileRank(composite, ROLLING_WINDOW_DAYS);
    expect(rank.filter((r) => Number.isFinite(r) && r < 0.33).length).toBeGreaterThan(200);
    const labels = regimeLabels(composite, rank, CURRENT_REGIME_VERSION);
    expect(labels.length).toBe(n);
    for (const l of labels) expect(l).toBe("neutral");
    // Non-vacuity: the v3 path cuts on the rank and reads risk-off.
    expect(regimeLabels(composite, rank, "v3")).toContain("risk_off");
  });

  test("each panel label equals smoothRegimes(panel index, bucketFn) on the fixture", () => {
    for (const p of run.result.panels) {
      expect(run.result.panelRegimes[p]).toEqual(smoothRegimes(run.result.panelIndices[p]!, bucketFn));
    }
    expect(run.result.macroRegime).toEqual(smoothRegimes(run.result.macroIndex!, bucketFn));
    // Non-vacuity: the fixture's last macro index 0.662 ranks 0.897; v3 reads risk-on, v5 neutral.
    const last = run.dateAxis.length - 1;
    expect(run.result.panelRegimes.macro![last]).toBe("neutral");
    expect(v3.result.panelRegimes.macro![last]).toBe("risk_on");
    for (const p of v3.result.panels) {
      expect(v3.result.panelRegimes[p]).toEqual(smoothRegimes(v3.result.panelPercentiles[p]!, bucketFn));
    }
  });

  test("the regime label equals smoothRegimes(composite, bucketFn) on the fixture; v3 keeps the rank cut", () => {
    expect(run.result.regime).toEqual(smoothRegimes(run.result.composite, bucketFn));
    expect(v3.result.regime).toEqual(smoothRegimes(v3.result.compositePercentile, bucketFn));
    // The numbers themselves do not depend on the version.
    expect(v3.result.composite).toEqual(run.result.composite);
    expect(v3.result.compositePercentile).toEqual(run.result.compositePercentile);
    expect(v3.result.panelIndices).toEqual(run.result.panelIndices);
    expect(v3.result.regime).not.toEqual(run.result.regime);
  });

  test("the fast switch fires on a 2σ move of the composite, without the 5-day confirmation", () => {
    // 60 quiet days near 0.5, then one jump to 0.2: risk-off the same day.
    const quiet = Array.from({ length: 60 }, (_, i) => 0.5 + 0.002 * Math.sin(i));
    const jump = [...quiet, 0.2, 0.2, 0.2];
    const labels = regimeLabels(jump, rollingPercentileRank(jump, ROLLING_WINDOW_DAYS), CURRENT_REGIME_VERSION);
    expect(labels.slice(0, 60).every((l) => l === "neutral")).toBe(true);
    expect(labels[60]).toBe("risk_off");
    // A slow drift below 0.33 is not a 2σ move: it waits for 5 days in the new bucket.
    const drift = [...quiet, ...Array.from({ length: 40 }, (_, i) => 0.5 - 0.005 * (i + 1))];
    const d = regimeLabels(drift, [], CURRENT_REGIME_VERSION);
    const firstBelow = drift.findIndex((c) => c < 0.33);
    expect(d[firstBelow]).toBe("neutral");
    expect(d[firstBelow + 4]).toBe("risk_off");
  });

  test("an unknown version is rejected", () => {
    expect(() => runRegime(toHistory(parseRawHistory(csvText)), { version: "v4" as never })).toThrow(RangeError);
  });
});

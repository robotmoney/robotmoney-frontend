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
  runRegime as runRegimeOutcome, requireComplete,
  prepareRegimeInputs,
  computeRegime,
  toHistory,
  PANELS,
  ALL_PANELS,
  PANEL_MEMBERSHIP,
  type Indicator,
  type Panel,
  type PanelMembership,
} from "../src/index.ts";
import { COLLECTED_SERIES } from "../src/extract/collected-series.ts";
// Each run here scores a complete day (issue 1655): an IncompleteDay fails the test.
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));

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
    const victim = INDICATORS.find((i) => i.panel === "macro" && i.fill.kind !== "zero" && (raw[i.id]?.length ?? 0) > 400)!;
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
    bad({ panels: [] });
    bad({ panels: ["macro", "macro"] });
    bad({ panels: ["bogus"] } as never);
    bad({ factor: "yes" } as never);
    bad({ bogus: 1 } as never);
  }, TEST_TIMEOUT_MS);

  test("the CLI rejects a trailing --start/--asof, a bad --asof and a bad --panels value and unknown flags", async () => {
    const fx = join(DIR, "fixtures/raw-indicator-history.csv");
    for (const a of [["--asof"], ["--start"], ["--asof", "banana"], ["--panels", "macro,bogus"], ["--panels"], ["--bogus"]]) {
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

// Issue 1652 (methodology v4): the regime label is cut on the composite itself
// and each panel label on its panel index, never on a second rolling rank of
// it. The 5-day confirmation and the 2σ fast switch act on that same series.
// A run under v3 keeps the rank-then-cut path, so a v3 run replays exactly.
describe("v4: labels are cut on the composite and the panel indices (issue 1652)", async () => {
  const { bucketFn, smoothRegimes, regimeLabels } = await import("../src/analyze/compute.ts");
  const { rollingPercentileRank } = await import("../src/transform/math.ts");
  const { ROLLING_WINDOW_DAYS } = await import("../src/analyze/indicators.ts");
  const { CURRENT_REGIME_VERSION } = await import("../src/analyze/regime-versions.ts");
  const run = runRegime(toHistory(parseRawHistory(csvText)));
  const v3 = runRegime(toHistory(parseRawHistory(csvText)), { version: "v3" });

  test("the current version is v4, and the report and run carry the version they computed", () => {
    expect(CURRENT_REGIME_VERSION).toBe("v4");
    expect(run.version).toBe("v4");
    expect(reportObject.version).toBe("v4");
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
    // Non-vacuity: the fixture's last macro index 0.662 ranks 0.897; v3 reads risk-on, v4 neutral.
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
    expect(() => runRegime(toHistory(parseRawHistory(csvText)), { version: "v5" as never })).toThrow(RangeError);
  });
});

// Issue 1659: the rank, weight and percentile windows are methodology
// parameters declared per version in REGIME_LOOKBACK, and computeRegime takes
// an optional `lookback` that defaults to the declaration of its version.
describe("lookback windows are methodology parameters (issue 1659)", async () => {
  const { computeRegime } = await import("../src/analyze/compute.ts");
  const { rollingPercentileRank, inverseCorrelationWeights } = await import("../src/transform/math.ts");
  const { PANELS } = await import("../src/analyze/indicators.ts");
  const { CURRENT_REGIME_VERSION, REGIME_LOOKBACK, REGIME_VERSIONS } = await import("../src/index.ts");
  const { BACKFILL_START } = await import("../src/run.ts");
  const { resolveInputHistory } = await import("../src/series-ids.ts");
  const { ratiosFromLegs } = await import("../src/transform/ratios.ts");
  type Lookback = (typeof REGIME_LOOKBACK)["v4"];
  type Window = Lookback["rank"];

  // The fixture's regime inputs, built the way runRegime builds them.
  const raw = toHistory(parseRawHistory(csvText));
  const rawIn = ratiosFromLegs(raw, resolveInputHistory(raw));
  let newest = BACKFILL_START;
  for (const id in rawIn) for (const r of rawIn[id]!) if (r.date > newest) newest = r.date;
  const { dateAxis, transformed } = prepareRegimeInputs(rawIn, { start: BACKFILL_START, asof: newest });
  const n = dateAxis.length;
  const T1095: Window = { kind: "trailing", days: 1095 };
  const INCEPTION: Window = { kind: "inception" };
  const lb = (rank: Window, weight: Window, percentile: Window): Lookback => ({ rank, weight, percentile });
  const run = (lookback?: Lookback, version: "v3" | "v4" = "v4") =>
    computeRegime(transformed, dateAxis, PANELS, undefined, undefined, version, lookback);

  const base = run();
  const rankInc = run(lb(INCEPTION, T1095, T1095));
  const weightInc = run(lb(T1095, INCEPTION, T1095));
  const pctInc = run(lb(T1095, T1095, INCEPTION));
  const T500: Window = { kind: "trailing", days: 500 };
  const t500 = run(lb(T500, T500, T500));
  const allInc = run(lb(INCEPTION, INCEPTION, INCEPTION));

  const sameEach = (a: readonly unknown[], b: readonly unknown[]) => {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) expect([i, a[i]]).toEqual([i, b[i]]);
  };
  const sameRecord = (a: Record<string, readonly unknown[]>, b: Record<string, readonly unknown[]>) => {
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a)) sameEach(a[k]!, b[k]!);
  };
  const finalWeights = (signed: Record<string, number[]>, start: number) => {
    const out: Record<string, Record<string, number>> = {};
    for (const p of PANELS) {
      const w: Record<string, number[]> = {};
      for (const ind of INDICATORS.filter((i) => i.panel === p)) w[ind.id] = signed[ind.id]!.slice(start, n);
      out[p] = inverseCorrelationWeights(w);
    }
    return out;
  };

  test("REGIME_LOOKBACK declares every version; v3 and v4 are the trailing 1095 days for every window", () => {
    expect(Object.keys(REGIME_LOOKBACK).sort()).toEqual([...REGIME_VERSIONS].sort());
    for (const v of ["v3", "v4"] as const) {
      expect(REGIME_LOOKBACK[v]).toEqual({ rank: T1095, weight: T1095, percentile: T1095 });
    }
  });

  test("the version stays v4 and the versions stay [v3, v4]", () => {
    expect(CURRENT_REGIME_VERSION).toBe("v4");
    expect([...REGIME_VERSIONS]).toEqual(["v3", "v4"]);
  });

  test("no lookback argument equals the version's declared lookback, field by field", () => {
    for (const v of ["v3", "v4"] as const) {
      const a = v === "v4" ? base : run(undefined, "v3");
      const b = run(REGIME_LOOKBACK[v], v);
      sameRecord(a.ranks, b.ranks);
      sameRecord(a.signed, b.signed);
      expect(a.weightsByPanel).toEqual(b.weightsByPanel);
      sameRecord(a.panelIndices, b.panelIndices);
      sameRecord(a.panelPercentiles, b.panelPercentiles);
      sameRecord(a.panelRegimes, b.panelRegimes);
      sameEach(a.composite, b.composite);
      sameEach(a.compositePercentile, b.compositePercentile);
      sameEach(a.regime, b.regime);
    }
  });

  test("rank at inception: each rank is its all-history rank; weights read the last 1095 days", () => {
    expect(n).toBeGreaterThan(1095);
    for (const ind of INDICATORS) {
      const xs = transformed[ind.id]!;
      sameEach(rankInc.ranks[ind.id]!, rollingPercentileRank(xs, xs.length));
    }
    expect(rankInc.weightsByPanel).toEqual(finalWeights(rankInc.signed, n - 1095));
    // Non-vacuity: the inception ranks differ from the 1095-day ranks.
    expect(rankInc.ranks).not.toEqual(base.ranks);
  });

  test("weight at inception: ranks equal the default run; weights read day 0 to the last day", () => {
    sameRecord(weightInc.ranks, base.ranks);
    expect(weightInc.weightsByPanel).toEqual(finalWeights(weightInc.signed, 0));
    expect(weightInc.weightsByPanel).not.toEqual(base.weightsByPanel);
  });

  test("percentile at inception: ranks, indices and composite equal the default run; percentiles rank all history", () => {
    sameRecord(pctInc.ranks, base.ranks);
    sameRecord(pctInc.panelIndices, base.panelIndices);
    sameEach(pctInc.composite, base.composite);
    sameEach(pctInc.compositePercentile, rollingPercentileRank(pctInc.composite, pctInc.composite.length));
    for (const p of PANELS) {
      sameEach(pctInc.panelPercentiles[p]!, rollingPercentileRank(pctInc.panelIndices[p]!, n));
    }
    sameEach(pctInc.macroPercentile!, pctInc.panelPercentiles.macro!);
    sameEach(pctInc.onchainPercentile!, pctInc.panelPercentiles.onchain!);
    expect(pctInc.compositePercentile).not.toEqual(base.compositePercentile);
  });

  test("a trailing value other than 1095 takes effect: 500 days", () => {
    for (const ind of INDICATORS) sameEach(t500.ranks[ind.id]!, rollingPercentileRank(transformed[ind.id]!, 500));
    sameEach(t500.compositePercentile, rollingPercentileRank(t500.composite, 500));
  });

  test("non-vacuity: the all-inception composite differs from the default composite", () => {
    expect(allInc.composite.some((c, i) => Number.isFinite(c) && !Object.is(c, base.composite[i]))).toBe(true);
  });

  test("point in time: an all-inception run cut at a refresh day d gives the full run's ranks, panel indices and composite at d", () => {
    let checked = 0;
    for (let d = 1095 + ((21 - (1095 % 21)) % 21); d < n; d += 21) {
      const cut: Record<string, number[]> = {};
      for (const id in transformed) cut[id] = transformed[id]!.slice(0, d + 1);
      const r = computeRegime(cut, dateAxis.slice(0, d + 1), PANELS, undefined, undefined, "v4", lb(INCEPTION, INCEPTION, INCEPTION));
      for (const ind of INDICATORS) expect(Object.is(r.ranks[ind.id]![d], allInc.ranks[ind.id]![d])).toBe(true);
      for (const p of PANELS) expect(Object.is(r.panelIndices[p]![d], allInc.panelIndices[p]![d])).toBe(true);
      expect(Object.is(r.composite[d], allInc.composite[d])).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("short history: a late indicator ranks only among its own values and earns weight from its 60th signed value", () => {
    // Deterministic noise for every registry series; one macro indicator starts at day k.
    let seed = 1659;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const N = 420;
    const k = 150;
    const axis = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
    const data: Record<string, number[]> = {};
    for (const ind of INDICATORS) data[ind.id] = Array.from({ length: N }, () => rnd());
    const late = INDICATORS.find((i) => i.panel === "macro")!;
    data[late.id] = data[late.id]!.map((v, i) => (i < k ? NaN : v));
    const inc = lb(INCEPTION, INCEPTION, INCEPTION);
    const full = computeRegime(data, axis, PANELS, undefined, undefined, "v4", inc);
    const own = rollingPercentileRank(data[late.id]!.slice(k), Infinity);
    for (let i = 0; i < N; i++) {
      const r = full.ranks[late.id]![i]!;
      if (i < k + 29) expect(Number.isNaN(r)).toBe(true);
      else expect(Object.is(r, own[i - k])).toBe(true);
    }
    // The weights on refresh day r are the final weights of the run cut at r.
    let firstFull = -1;
    for (let r = 0; r < N; r += 21) {
      const cut: Record<string, number[]> = {};
      for (const id in data) cut[id] = data[id]!.slice(0, r + 1);
      const w = computeRegime(cut, axis.slice(0, r + 1), PANELS, undefined, undefined, "v4", inc).weightsByPanel.macro![late.id]!;
      const finite = full.signed[late.id]!.slice(0, r + 1).filter(Number.isFinite).length;
      if (finite < 60) expect(w).toBe(0);
      else if (firstFull < 0) {
        firstFull = r;
        expect(w).toBeGreaterThan(0);
      }
    }
    expect(firstFull).toBeGreaterThan(k);
  });

  test("an invalid lookback throws RangeError naming the window", () => {
    const tiny = { dateAxis: dateAxis.slice(0, 40), data: {} as Record<string, number[]> };
    for (const id in transformed) tiny.data[id] = transformed[id]!.slice(0, 40);
    const call = (l: unknown) => () =>
      computeRegime(tiny.data, tiny.dateAxis, PANELS, undefined, undefined, "v4", l as Lookback);
    expect(call({ rank: T1095, weight: T1095 })).toThrow(/percentile/);
    expect(call({ rank: T1095, weight: T1095 })).toThrow(RangeError);
    expect(call({ rank: { kind: "rolling", days: 10 }, weight: T1095, percentile: T1095 })).toThrow(/rank/);
    for (const days of [0, -1, 1.5, NaN]) {
      expect(call({ rank: T1095, weight: { kind: "trailing", days }, percentile: T1095 })).toThrow(RangeError);
      expect(call({ rank: T1095, weight: { kind: "trailing", days }, percentile: T1095 })).toThrow(/weight/);
    }
  });
});

// Issue 1653: BAA10Y is collected, not scored. Its rows in a run's input change
// nothing; an indicators list that holds it as a macro entry scores it.
describe("collected series: BAA10Y is stored, not scored (issue 1653)", () => {
  const raw = toHistory(parseRawHistory(csvText));
  // Deterministic BAA10Y rows on the fixture's own business days (T10Y2Y's dates).
  const baa10y = raw.T10Y2Y!.map((p, i) => ({ date: p.date, value: 2 + Math.sin(i / 40) + i / 2000 }));
  const withBaa = { ...raw, BAA10Y: baa10y };
  const entry = COLLECTED_SERIES.find((s) => s.id === "BAA10Y")!;
  // A trial macro entry: the collected fields plus scoring fields, no registry edit.
  const promoted: Indicator = {
    ...entry, panel: "macro", sign: -1, transform: "level",
    fill: { kind: "forward", maxAgeDays: MAX_FORWARD_FILL_DAYS }, fillReason: "test: a trial promotion",
  };
  const trial = [...INDICATORS, promoted];

  test("INDICATORS has no BAA10Y entry", () => {
    expect(INDICATORS.some((i) => i.id === "BAA10Y")).toBe(false);
    expect(entry).toBeDefined();
  }, TEST_TIMEOUT_MS);

  test("a regime run gives identical output with and without BAA10Y rows in its raw input", () => {
    const without = buildReport(runRegime(raw, { factor: true }), { full: true });
    const withRows = buildReport(runRegime(withBaa, { factor: true }), { full: true });
    expect(JSON.stringify(withRows)).toBe(JSON.stringify(without));
    // The plain report is the golden bytes either way.
    expect(JSON.stringify(buildReport(runRegime(withBaa)), null, 2) + "\n").toBe(goldenText);
  }, TEST_TIMEOUT_MS);

  test("prepareRegimeInputs given a BAA10Y macro entry returns its transformed series, built from its stored rows", () => {
    const asof = baa10y[baa10y.length - 1]!.date;
    const prepared = prepareRegimeInputs(withBaa, { start: "2018-01-01", asof, indicators: trial });
    const series = prepared.transformed.BAA10Y!;
    expect(series.length).toBe(prepared.dateAxis.length);
    // transform "level": each day on which a row is stored is that row's value.
    const byDate = new Map(baa10y.map((p) => [p.date, p.value]));
    let matched = 0;
    prepared.dateAxis.forEach((d, i) => {
      if (!byDate.has(d)) return;
      expect(series[i]).toBe(byDate.get(d)!);
      matched++;
    });
    expect(matched).toBeGreaterThan(1000);
    expect(prepared.lastRaw.BAA10Y).toEqual(baa10y[baa10y.length - 1]!);
    // The shipped registry builds no BAA10Y series from the same input.
    expect("BAA10Y" in prepareRegimeInputs(withBaa, { start: "2018-01-01", asof }).transformed).toBe(false);
  }, TEST_TIMEOUT_MS);

  test("non-vacuity: runRegime with BAA10Y as a macro entry (sign -1, level) changes the macro index and composite", () => {
    const shipped = runRegime(withBaa);
    const scored = runRegime(withBaa, { indicators: trial });
    expect(scored.dateAxis).toEqual(shipped.dateAxis);
    expect(Object.keys(scored.result.weightsByPanel.macro!)).toContain("BAA10Y");
    const last = shipped.dateAxis.length - 1;
    expect(scored.result.macroIndex![last]).not.toBe(shipped.result.macroIndex![last]);
    expect(scored.result.composite[last]).not.toBe(shipped.result.composite[last]);
    // The onchain panel does not read BAA10Y.
    expect(JSON.stringify(scored.result.onchainIndex)).toBe(JSON.stringify(shipped.result.onchainIndex));
  }, TEST_TIMEOUT_MS);

  test("runRegime rejects an indicators option that is not an array", () => {
    expect(() => runRegimeOutcome(raw, { indicators: "BAA10Y" as never })).toThrow(RangeError);
  }, TEST_TIMEOUT_MS);
});

// Issue 1708 (D89): the composite is the naive 1/n mean of the included panels
// finite that day, and an excluded panel is still emitted for display.
describe("the composite averages every included panel at 1/n", () => {
  const history = toHistory(parseRawHistory(csvText));
  const run = runRegime(history);
  const r = run.result;

  test("the default composite covers macro, onchain and factor", () => {
    expect(r.panels).toEqual(PANELS);
    expect(r.panels).toContain("factor");
  });

  test("on each fixture day with all three panels finite, the composite is their arithmetic mean", () => {
    let checked = 0;
    for (let i = 0; i < run.dateAxis.length; i++) {
      const vs = [r.macroIndex![i]!, r.onchainIndex![i]!, r.factorIndex![i]!];
      if (!vs.every(Number.isFinite)) continue;
      expect(r.composite[i]!).toBeCloseTo((vs[0]! + vs[1]! + vs[2]!) / 3, 12);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("with a panel NaN, the composite is the mean of the finite panels", () => {
    // Blank every factor series after transform, so the factor index is NaN on every day.
    const p = prepareRegimeInputs(history, { start: "2018-01-01", asof: run.dateAxis[run.dateAxis.length - 1]! });
    for (const x of INDICATORS) if (x.panel === "factor") p.transformed[x.id] = p.transformed[x.id]!.map(() => NaN);
    const nf = computeRegime(p.transformed, p.dateAxis, PANELS, p.ages);
    let checked = 0;
    for (let i = 0; i < nf.composite.length; i++) {
      expect(Number.isNaN(nf.factorIndex![i]!)).toBe(true);
      const m = nf.macroIndex![i]!, o = nf.onchainIndex![i]!;
      if (!Number.isFinite(m) || !Number.isFinite(o)) continue;
      expect(nf.composite[i]!).toBeCloseTo((m + o) / 2, 12);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("a panel marked excluded leaves the composite while its index is still emitted", () => {
    const membership: Record<Panel, PanelMembership> = { ...PANEL_MEMBERSHIP, factor: "excluded" };
    const panels = ALL_PANELS.filter((p) => membership[p] === "included");
    const ex = runRegime(history, { panels, factor: true });
    expect(ex.result.panels).toEqual(["macro", "onchain"]);
    const last = ex.dateAxis.length - 1;
    const m = ex.result.macroIndex![last]!, o = ex.result.onchainIndex![last]!;
    expect(ex.result.composite[last]!).toBeCloseTo((m + o) / 2, 12);
    expect(Number.isFinite(ex.factor!.factorIndex![last]!)).toBe(true);
    expect(buildReport(ex).factor).toBeDefined();
  });
});

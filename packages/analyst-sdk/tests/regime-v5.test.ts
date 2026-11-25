// Issue 1753: methodology v5, the model ported from the downstream
// experiment-lex-equity, on hand-built inputs: its registry, its backtest rule
// row, each rule of the kept record (the score, the day's weights, the
// composite mean, the since-inception composite, the labels), the four derived
// declarations and their publication lags, and that a day never reads a value
// dated after it. The byte-for-byte reproduction is tests/regime-v5-golden.test.ts.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_PANELS,
  BACKFILL_START,
  INDICATORS,
  PANELS,
  REGIME_BACKTEST_RULES,
  REGIME_REGISTRY,
  REGIME_RULES,
  REFERENCE_CALENDARS,
  BACKTEST_IN_SAMPLE_END,
  V5_DERIVED_SERIES,
  V5_INDICATORS,
  V5_INPUT_IDS,
  bucketFn,
  buildReport,
  computeBacktest,
  computeKeptRegime,
  computeRegime,
  deriveKeptRecord,
  deriveSeries,
  fitDay,
  fitPanelWeights,
  keptDayOf,
  keptRegimeRows,
  parseRawHistory,
  prepareRegimeInputs,
  requireComplete,
  runRegime,
  scoreDays,
  smoothRegimes,
  toHistory,
  walkForward,
  weightedMeanOnDay,
  withDerivedSeries,
  type DerivedSeries,
  type Indicator,
  type KeptDay,
  type Point,
  type RawIndicatorHistory,
} from "../src/index.ts";
import { rollingPercentileRank, inverseCorrelationWeights } from "../src/transform/math.ts";

setDefaultTimeout(300_000);

const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const same = (a: number, b: number) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

// ── The backtest rule rows ──────────────────────────────────────────────────

describe("REGIME_BACKTEST_RULES (issue 1753)", () => {
  const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.json"), "utf8")));
  const v4 = requireComplete(runRegime(raw, { version: "v4" }));
  const extras = { spx: raw["SPX"]!, eth: raw["ETH"]!, tbill3m: raw["TBILL3M"]! };

  test("the v3 and v4 rows are computeBacktest's defaults: a run with the row passed deep-equals the run with no options", () => {
    const plain = computeBacktest(v4.dateAxis, v4.result, extras);
    expect(Object.keys(plain).sort()).toEqual(["eth", "mixed", "sp500"]);
    for (const v of ["v3", "v4"] as const) {
      expect(REGIME_BACKTEST_RULES[v]).toEqual({ splitDate: BACKTEST_IN_SAMPLE_END, lagSessions: 1, calendars: { ...REFERENCE_CALENDARS }, cashBasis: "discount", sharpeBasis: "excess" });
      const withRow = computeBacktest(v4.dateAxis, v4.result, extras, REGIME_BACKTEST_RULES[v]);
      expect(withRow).toEqual(plain);
      expect(JSON.stringify(withRow)).toBe(JSON.stringify(plain));
    }
    // runRegime passes the row of the version it computes: its v4 backtest is the default one.
    expect(JSON.stringify(v4.backtest)).toBe(JSON.stringify(requireComplete(runRegime(raw)).backtest));
  });

  test("the v5 row holds exactly the golden's rule set", () => {
    expect(REGIME_BACKTEST_RULES.v5).toEqual({ splitDate: "2024-01-31", lagSessions: 0, calendars: { eth: "continuous", sp500: "continuous" }, cashBasis: "yield", sharpeBasis: "returns" });
    expect(Object.keys(REGIME_BACKTEST_RULES.v5).sort()).toEqual(["calendars", "cashBasis", "lagSessions", "sharpeBasis", "splitDate"]);
    // Its split is not the adoption date of v5.
    expect(REGIME_BACKTEST_RULES.v5.splitDate).not.toBe(REGIME_RULES.v5.adoptionDate);
    // The row changes the figures: it is not the default rule set.
    const v5Row = computeBacktest(v4.dateAxis, v4.result, extras, REGIME_BACKTEST_RULES.v5);
    expect(JSON.stringify(v5Row)).not.toBe(JSON.stringify(computeBacktest(v4.dateAxis, v4.result, extras)));
    expect(v5Row.eth!.composite!.sample_split_date).toBe("2024-01-31");
  });
});

// ── The registry ────────────────────────────────────────────────────────────

describe("the v5 registry (issue 1753)", () => {
  test("v5 has 30 indicators with VIX in factor; INDICATORS still has 26 with VIX in macro", () => {
    expect(INDICATORS.length).toBe(26);
    expect(INDICATORS.find((i) => i.id === "VIX")!.panel).toBe("macro");
    expect(REGIME_REGISTRY.v5).toBe(V5_INDICATORS);
    expect(V5_INDICATORS.length).toBe(30);
    expect(V5_INDICATORS.find((i) => i.id === "VIX")!.panel).toBe("factor");
    const ids = (p: string) => V5_INDICATORS.filter((i) => i.panel === p).map((i) => i.id).sort();
    expect(ids("macro")).toEqual(["COPPER_GOLD", "DFII10", "DXY", "FISCAL", "HY_OAS", "ICSA", "T10Y2Y", "T5YIE"]);
    expect(ids("onchain")).toEqual(INDICATORS.filter((i) => i.panel === "onchain").map((i) => i.id).sort());
    expect(ids("onchain").length).toBe(10);
    expect(ids("factor")).toEqual(["IWF_IWD", "IWM_SPY", "MTUM_SPY", "SHILLER_CAPE", "SKEW", "SPHB_SPLV", "SPX_TREND", "UPVOL_SHARE", "VIX", "VIX_TERM", "XLP_XLY", "XLU_SPY"]);
  });

  test("every registry indicator but VIX is the INDICATORS entry itself, in order; VIX keeps its sign, transform and dating", () => {
    V5_INDICATORS.slice(0, INDICATORS.length).forEach((ind, k) => {
      if (ind.id === "VIX") expect(ind).toEqual({ ...INDICATORS[k]!, panel: "factor" });
      else expect(ind).toBe(INDICATORS[k]!);
    });
    const vix = V5_INDICATORS.find((i) => i.id === "VIX")!;
    expect([vix.sign, vix.transform, vix.publication]).toEqual([-1, "level", { kind: "same-day" }]);
  });

  test("the four derived indicators: panel, sign, level, and the forward fill of at most 120 days every v5 indicator keeps", () => {
    const derived = V5_INDICATORS.slice(INDICATORS.length);
    expect(derived.map((i) => [i.id, i.panel, i.sign, i.transform])).toEqual([
      ["FISCAL", "macro", 1, "level"],
      ["VIX_TERM", "factor", 1, "level"],
      ["SKEW", "factor", -1, "level"],
      ["UPVOL_SHARE", "factor", 1, "level"],
    ]);
    for (const ind of V5_INDICATORS) expect(ind.fill, ind.id).toEqual({ kind: "forward", maxAgeDays: 120 });
    expect(V5_DERIVED_SERIES.map((d) => d.id)).toEqual(derived.map((i) => i.id));
  });
});

// ── Hand-built inputs: a small registry on a short axis ─────────────────────

const START = "2020-01-01";
const DAYS = 260;
const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const entry = (id: string, panel: Indicator["panel"], sign: 1 | -1): Indicator => ({
  id, name: id, panel, source: "test", sign, transform: "level", unit: "index",
  fill: { kind: "forward", maxAgeDays: 120 }, fillReason: "test", calendar: "daily", publication: { kind: "same-day" },
});
const SMALL: Indicator[] = [entry("M1", "macro", 1), entry("M2", "macro", -1), entry("O1", "onchain", 1), entry("O2", "onchain", 1), entry("F1", "factor", -1), entry("F2", "factor", 1)];
// M2 has an observation only every third day (the two days after are carried); F2 starts 40 days late.
function smallRaw(): RawIndicatorHistory {
  const raw: RawIndicatorHistory = {};
  SMALL.forEach((ind, k) => {
    const next = lcg(17 + k * 101);
    const points: Point[] = [];
    let level = 10 + k;
    for (let d = 0; d < DAYS; d++) {
      level += next() - 0.5;
      if (ind.id === "M2" && d % 3 !== 0) continue;
      if (ind.id === "F2" && d < 40) continue;
      points.push({ date: addDays(START, d), value: Number(level.toFixed(4)) });
    }
    raw[ind.id] = points;
  });
  return raw;
}
const small = { version: "v5" as const, indicators: SMALL, derived: [] as DerivedSeries[] };
const ASOF = addDays(START, DAYS - 1);
const first = computeKeptRegime(smallRaw(), { ...small, asof: ASOF, start: START });

describe("the day (issue 1753)", () => {
  test("a score is the mid-rank within the trailing 1095 calendar days including the day, counts a carried day, and needs 30 values", () => {
    const { transformed, dateAxis, ages } = first.prepared;
    // M2 is carried two days out of three: its carried rows are in the window, each counted once.
    expect(ages["M2"]!.slice(0, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
    for (const ind of SMALL) {
      const xs = transformed[ind.id]!;
      for (let i = 0; i < dateAxis.length; i++) {
        const window = xs.slice(Math.max(0, i - 1095 + 1), i + 1).filter(Number.isFinite);
        const got = first.scores.ranks[ind.id]![i]!;
        if (!Number.isFinite(xs[i]!) || window.length < 30) {
          expect(got, `${ind.id} day ${i}`).toBeNaN();
          continue;
        }
        const below = window.filter((v) => v < xs[i]!).length;
        const equal = window.filter((v) => v === xs[i]!).length;
        expect(got, `${ind.id} day ${i}`).toBe((below + 0.5 * equal) / window.length);
        expect(first.scores.signed[ind.id]![i]!).toBe(ind.sign >= 0 ? got : 1 - got);
      }
    }
    // The 29th value has no score, the 30th has one.
    expect(first.scores.ranks["M1"]![28]!).toBeNaN();
    expect(Number.isFinite(first.scores.ranks["M1"]![29]!)).toBe(true);
    // F2 starts on day 40: its 30th value is day 69.
    expect(first.scores.ranks["F2"]![68]!).toBeNaN();
    expect(Number.isFinite(first.scores.ranks["F2"]![69]!)).toBe(true);
    // The window is trailing: a longer axis leaves a day's score unchanged, and 1095 days is the length.
    expect(scoreDays(transformed, dateAxis, small).ranks["M1"]).toEqual(rollingPercentileRank(transformed["M1"]!, 1095));
  });

  test("weights on a day equal fitPanelWeights on the window ending that day, and the panel index is weightedMeanOnDay", () => {
    for (const k of [100, 177, DAYS - 1]) {
      const fit = fitDay(first.scores, k, small);
      for (const p of ALL_PANELS) {
        const inds = SMALL.filter((i) => i.panel === p);
        const expected = fitPanelWeights(first.scores.signed, inds, k, { rules: REGIME_RULES.v5 });
        expect(fit.weightsByPanel[p]).toEqual(expected);
        // The fit reads only the scores of the window ending on the day.
        const window = Object.fromEntries(inds.map((i) => [i.id, first.scores.signed[i.id]!.slice(Math.max(0, k - 1095 + 1), k + 1)]));
        expect(fit.weightsByPanel[p]).toEqual(inverseCorrelationWeights(window));
        expect(same(fit.panelIndices[p]!, weightedMeanOnDay(first.scores.signed, expected, inds, k))).toBe(true);
      }
    }
    // An indicator needs at least 60 scores: F2 has 30 scores on day 98 (day 69 + 29) and 60 on day 128.
    expect(fitDay(first.scores, 127, small).weightsByPanel["factor"]!["F2"]).toBe(0);
    expect(fitDay(first.scores, 128, small).weightsByPanel["factor"]!["F2"]).toBeGreaterThan(0);
    // The as-of fit of a run is the fit of its last day.
    expect(first.fit).toEqual(fitDay(first.scores, DAYS - 1, small));
  });

  test("a day computed alone equals the same day inside a longer walk-forward", () => {
    const walked = walkForward(first.scores, DAYS - 1, small);
    expect(walked.length).toBe(DAYS - 1);
    expect(first.computed.length).toBe(DAYS);
    const placeholder: KeptDay[] = [{ date: START, panelIndices: {} }];
    for (const k of [95, 150, 201]) {
      const day = addDays(START, k);
      // A run as of `day` with kept days computes only its own day, from inputs cut at that day.
      const alone = computeKeptRegime(smallRaw(), { ...small, asof: day, start: START, kept: placeholder });
      expect(alone.computed.length).toBe(1);
      expect(alone.computed[0]).toEqual(walked[k]!);
      expect(alone.computed[0]).toEqual(first.computed[k]!);
      expect(keptDayOf(first.scores, k, small)).toEqual(walked[k]!);
      expect(alone.fit.weightsByPanel).toEqual(fitDay(first.scores, k, small).weightsByPanel);
    }
  });

  test("a later run derives its own day from the kept days plus its own, and equals the first run's walk", () => {
    const cut = 200;
    const kept = first.computed.slice(0, cut).map((d): KeptDay => ({ date: d.date, panelIndices: d.panelIndices }));
    const later = computeKeptRegime(smallRaw(), { ...small, asof: addDays(START, cut), start: START, kept });
    const i = cut;
    expect(same(later.record.composite[i]!, first.record.composite[i]!)).toBe(true);
    expect(same(later.record.compositeMean[i]!, first.record.compositeMean[i]!)).toBe(true);
    expect(later.record.regime[i]).toBe(first.record.regime[i]!);
    for (const p of ALL_PANELS) expect(later.record.panelRegimes[p]![i]).toBe(first.record.panelRegimes[p]![i]!);
    // It publishes exactly one row, its own day; the first run publishes every day that has a composite mean.
    const rows = keptRegimeRows(later, { source: "fixture" }, small);
    expect(rows.map((r) => r.date)).toEqual([addDays(START, cut)]);
    const firstRows = keptRegimeRows(first, { source: "fixture" }, small);
    expect(firstRows.length).toBe(first.record.compositeMean.filter(Number.isFinite).length);
    expect(firstRows.at(-1)!.date).toBe(ASOF);
    // A kept day on or after the as-of day is refused.
    expect(() => computeKeptRegime(smallRaw(), { ...small, asof: addDays(START, cut), start: START, kept: first.computed.slice(0, cut + 1) })).toThrow(RangeError);
  });
});

describe("the kept record (issue 1753)", () => {
  // Hand-built kept days: 80 days, a gap on day 10, the factor panel missing on days 20..24, no panel on day 30.
  const axis = Array.from({ length: 80 }, (_, i) => addDays(START, i));
  const next = lcg(5);
  const days: KeptDay[] = [];
  axis.forEach((date, i) => {
    if (i === 10) return;
    const idx = { macro: next(), onchain: next(), factor: next() };
    if (i >= 20 && i <= 24) idx.factor = NaN;
    if (i === 30) Object.assign(idx, { macro: NaN, onchain: NaN, factor: NaN });
    days.push({ date, panelIndices: idx });
  });
  const record = deriveKeptRecord(axis, days);
  const dayAt = new Map(days.map((d) => [d.date, d]));

  test("the composite mean is the mean of the panels present; undefined on a gap or when none is present", () => {
    axis.forEach((date, i) => {
      const d = dayAt.get(date);
      const present = d ? PANELS.map((p) => d.panelIndices[p]!).filter(Number.isFinite) : [];
      expect(record.kept[i]).toBe(d !== undefined);
      if (present.length === 0) expect(record.compositeMean[i]!).toBeNaN();
      else expect(record.compositeMean[i]!).toBeCloseTo(present.reduce((a, b) => a + b, 0) / present.length, 15);
    });
    expect(record.compositeMean[10]!).toBeNaN();
    expect(record.compositeMean[30]!).toBeNaN();
    // Two panels present: the mean of those two, not a third of their sum.
    const d22 = dayAt.get(axis[22]!)!;
    expect(record.compositeMean[22]!).toBeCloseTo((d22.panelIndices["macro"]! + d22.panelIndices["onchain"]!) / 2, 15);
  });

  test("the composite is the mid-rank within every kept mean up to the day, defined from the 30th mean", () => {
    const seen: number[] = [];
    axis.forEach((_, i) => {
      const m = record.compositeMean[i]!;
      if (!Number.isFinite(m)) {
        expect(record.composite[i]!).toBeNaN();
        return;
      }
      seen.push(m);
      if (seen.length < 30) {
        expect(record.composite[i]!).toBeNaN();
        return;
      }
      const below = seen.filter((v) => v < m).length;
      const equal = seen.filter((v) => v === m).length;
      expect(record.composite[i]!).toBe((below + 0.5 * equal) / seen.length);
    });
    // 30 means are present on day 31 (days 0..31 without the gap and the empty day).
    expect(record.composite[30]!).toBeNaN();
    expect(Number.isFinite(record.composite[31]!)).toBe(true);
    expect(record.composite).toEqual(rollingPercentileRank(record.compositeMean, Infinity));
  });

  test("labels equal smoothRegimes on the composite and on each panel index", () => {
    expect(record.regime).toEqual(smoothRegimes(record.composite, bucketFn));
    for (const p of ALL_PANELS) expect(record.panelRegimes[p]).toEqual(smoothRegimes(record.panelIndices[p]!, bucketFn));
    expect(record.regime.filter((l) => l !== null).length).toBeGreaterThan(40);
  });

  test("a kept day never changes: a day given twice, or off the axis, is refused; later days do not move earlier ones", () => {
    expect(() => deriveKeptRecord(axis, [...days, days[3]!])).toThrow(/given twice/);
    expect(() => deriveKeptRecord(axis, [{ date: "2019-12-31", panelIndices: {} }])).toThrow(/not on the axis/);
    const shorter = deriveKeptRecord(axis.slice(0, 60), days.filter((d) => d.date <= axis[59]!));
    for (let i = 0; i < 60; i++) {
      expect(same(shorter.composite[i]!, record.composite[i]!)).toBe(true);
      expect(shorter.regime[i]).toBe(record.regime[i]!);
    }
  });
});

// ── The derived declarations ────────────────────────────────────────────────

describe("the derived declarations (issue 1753)", () => {
  const byId = Object.fromEntries(V5_DERIVED_SERIES.map((d) => [d.id, d]));
  const monthly: Point[] = Array.from({ length: 15 }, (_, k) => ({ date: `${2023 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-01`, value: -(100_000 + 7_000 * k) }));
  const gdp: Point[] = [
    { date: "2023-07-01", value: 27_000 },
    { date: "2023-10-01", value: 27_500 },
    { date: "2024-01-01", value: 28_000 },
  ];

  test("FISCAL: minus the plain 12-month sum, over 1000, over the latest GDP public 120 days after its date, times 100, dated 43 days later", () => {
    const out = deriveSeries(byId["FISCAL"]!, { [V5_INPUT_IDS.deficit]: monthly, [V5_INPUT_IDS.gdp]: gdp });
    // The first value needs 12 months: December 2023, dated 43 days later.
    expect(out.map((p) => p.date)).toEqual(["2024-01-13", "2024-02-13", "2024-03-15", "2024-04-13"]);
    const sum = (endIdx: number) => {
      let s = 0;
      for (let k = endIdx - 11; k <= endIdx; k++) s += monthly[k]!.value;
      return s;
    };
    // 2023-12-01 and 2024-01-01: the 2023-07-01 GDP is public from 2023-10-29; the 2023-10-01 one only from 2024-01-29.
    expect(out[0]!.value).toBe((-sum(11) / 1000 / 27_000) * 100);
    expect(out[1]!.value).toBe((-sum(12) / 1000 / 27_000) * 100);
    // 2024-02-01: the 2023-10-01 GDP (public 2024-01-29) is the latest public one.
    expect(out[2]!.value).toBe((-sum(13) / 1000 / 27_500) * 100);
    expect(out[3]!.value).toBe((-sum(14) / 1000 / 27_500) * 100);
    expect(byId["FISCAL"]).toMatchObject({ periods: 12, summation: "plain", negate: true, divisor: 1000, multiplier: 100, levelPublication: { kind: "calendar-days", days: 120 }, publication: { kind: "calendar-days", days: 43 } });
  });

  const closes = (base: number, n: number, seed: number, skip: number[] = []): Point[] => {
    const next = lcg(seed);
    const out: Point[] = [];
    for (let d = 0; d < n; d++) if (!skip.includes(d)) out.push({ date: addDays("2024-03-01", d), value: Number((base + next() * 5).toFixed(3)) });
    return out;
  };

  test("VIX_TERM is ^VIX3M over ^VIX on the dates both have a close, SKEW the ^SKEW close, each dated 1 day later", () => {
    const vix3m = closes(20, 12, 3, [4]);
    const vix = closes(18, 12, 4, [7]);
    const term = deriveSeries(byId["VIX_TERM"]!, { [V5_INPUT_IDS.vix3m]: vix3m, [V5_INPUT_IDS.vix]: vix });
    const shared = vix3m.filter((p) => vix.some((q) => q.date === p.date));
    expect(shared.length).toBe(10);
    expect(term).toEqual(shared.map((p) => ({ date: addDays(p.date, 1), value: p.value / vix.find((q) => q.date === p.date)!.value })));
    const skewIn = closes(140, 9, 5);
    expect(deriveSeries(byId["SKEW"]!, { [V5_INPUT_IDS.skew]: skewIn })).toEqual(skewIn.map((p) => ({ date: addDays(p.date, 1), value: p.value })));
  });

  test("UPVOL_SHARE: over the last 20 rows with a close and a volume above 0, the volume on strictly-up rows over the total, dated 1 day later; the first value needs 21 rows", () => {
    const close = closes(5000, 30, 6, [9]);
    const volume = closes(3e9, 30, 7).map((p, k) => (k === 14 ? { ...p, value: 0 } : p));
    const out = deriveSeries(byId["UPVOL_SHARE"]!, { [V5_INPUT_IDS.close]: close, [V5_INPUT_IDS.volume]: volume });
    const rows = volume.filter((p) => p.value > 0 && close.some((c) => c.date === p.date)).map((p) => ({ date: p.date, volume: p.value, close: close.find((c) => c.date === p.date)!.value }));
    expect(rows.length).toBe(28);
    expect(out.length).toBe(rows.length - 20);
    out.forEach((p, n) => {
      const i = 20 + n;
      let all = 0;
      let up = 0;
      for (let j = i - 19; j <= i; j++) {
        all += rows[j]!.volume;
        if (rows[j]!.close > rows[j - 1]!.close) up += rows[j]!.volume;
      }
      expect(p).toEqual({ date: addDays(rows[i]!.date, 1), value: up / all });
    });
    expect(byId["UPVOL_SHARE"]).toMatchObject({ window: 20, close: "SPX", volume: "SPX_VOLUME", publication: { kind: "calendar-days", days: 1 } });
  });

  test("a v5 run on day t reads no derived value dated after t, and no input dated after t moves it", () => {
    const t = "2024-04-02";
    const inputs: RawIndicatorHistory = {
      [V5_INPUT_IDS.deficit]: monthly,
      [V5_INPUT_IDS.gdp]: gdp,
      [V5_INPUT_IDS.vix3m]: closes(20, 40, 3),
      [V5_INPUT_IDS.vix]: closes(18, 40, 4),
      [V5_INPUT_IDS.skew]: closes(140, 40, 5),
      [V5_INPUT_IDS.close]: closes(5000, 40, 6),
      [V5_INPUT_IDS.volume]: closes(3e9, 40, 7),
    };
    const known = withDerivedSeries(inputs, t);
    for (const d of V5_DERIVED_SERIES) {
      expect(known[d.id]!.length, d.id).toBeGreaterThan(0);
      for (const p of known[d.id]!) expect(p.date <= t, `${d.id} ${p.date}`).toBe(true);
    }
    // The newest daily value known on t is the close of t - 1; FISCAL's is the February month (dated 2024-03-15).
    expect(known["SKEW"]!.at(-1)!.date).toBe(t);
    expect(known["SKEW"]!.at(-1)!.value).toBe(inputs[V5_INPUT_IDS.skew]!.find((p) => p.date === addDays(t, -1))!.value);
    expect(known["FISCAL"]!.at(-1)!.date).toBe("2024-03-15");
    // Every raw input is cut at t too.
    for (const id of Object.values(V5_INPUT_IDS)) for (const p of known[id]!) expect(p.date <= t).toBe(true);
    // Changing every input dated after t changes nothing the day reads.
    const later: RawIndicatorHistory = Object.fromEntries(Object.entries(inputs).map(([id, pts]) => [id, pts.map((p) => (p.date > t ? { date: p.date, value: p.value * 3 + 1 } : p))]));
    expect(withDerivedSeries(later, t)).toEqual(known);
    // A missing input leaves the derived series empty (its indicator is missing), never an error.
    const { [V5_INPUT_IDS.skew]: _skew, ...withoutSkew } = inputs;
    expect(withDerivedSeries(withoutSkew, t)["SKEW"]).toEqual([]);
    // A stored derived series is refused: it is computed from raw inputs, never read as stored.
    expect(() => withDerivedSeries({ ...inputs, SKEW: [{ date: t, value: 1 }] }, t)).toThrow(/already an input/);
  });
});

// ── runRegime accepts v5, and the two engines agree ─────────────────────────

describe("runRegime with version v5 (issue 1753)", () => {
  const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.json"), "utf8")));
  const run = requireComplete(runRegime(raw, { version: "v5" }));
  const last = run.dateAxis.length - 1;

  test("it computes the v5 registry, walked forward from the input, with no trailing percentile", () => {
    expect(run.version).toBe("v5");
    expect(run.registry).toBe(V5_INDICATORS);
    expect(run.result.regime[last]).not.toBeNull();
    expect(run.result.compositePercentile.every(Number.isNaN)).toBe(true);
    expect(run.result.weightFitDate).toBe(run.dateAxis[last]!);
    const report = buildReport(run);
    expect(report.version).toBe("v5");
    expect(report.indicators.length).toBe(30);
    expect(report.indicators.find((i) => i.id === "VIX")!.panel).toBe("factor");
    expect(report.regime.compositePercentile).toBeNaN();
    expect(JSON.parse(JSON.stringify(report)).regime.compositePercentile).toBeNull();
    // The input carries none of the five raw series, so the derived indicators are missing with weight 0.
    for (const id of ["FISCAL", "VIX_TERM", "SKEW", "UPVOL_SHARE"]) expect(report.indicators.find((i) => i.id === id)!.weight).toBe(0);
    // Its backtest is the v5 rule row's.
    expect(run.backtest!.eth!.composite!.sample_split_date).toBe("2024-01-31");
    // A v4 run of the same input is unchanged by v5: it reads INDICATORS and carries no registry.
    const v4 = requireComplete(runRegime(raw));
    expect(v4.registry).toBeUndefined();
    expect(buildReport(v4).indicators.length).toBe(26);
  });

  test("the kept walk-forward equals computeRegime under REGIME_RULES.v5 on the same prepared inputs, day for day", () => {
    const asof = run.dateAxis[last]!;
    const input = withDerivedSeries(raw, asof);
    const p = prepareRegimeInputs(input, { start: BACKFILL_START, asof, indicators: V5_INDICATORS, version: "v5" });
    const engine = computeRegime(p.transformed, p.dateAxis, PANELS, p.ages, undefined, "v5", undefined, V5_INDICATORS, undefined, p.carried);
    expect(engine.dateAxis).toEqual(run.dateAxis);
    for (let i = 0; i <= last; i++) {
      expect(same(engine.composite[i]!, run.result.composite[i]!)).toBe(true);
      expect(same(engine.compositeMean![i]!, run.result.compositeMean![i]!)).toBe(true);
      expect(engine.regime[i]).toBe(run.result.regime[i]!);
      for (const panel of PANELS) {
        expect(same(engine.panelIndices[panel]![i]!, run.result.panelIndices[panel]![i]!)).toBe(true);
        expect(engine.panelRegimes[panel]![i]).toBe(run.result.panelRegimes[panel]![i]!);
      }
    }
    expect(engine.weightsByPanel).toEqual(run.result.weightsByPanel);
    expect(engine.weightFitDate).toBe(asof);
  });

  test("an input naming the VIX_TERM denominator keeps it; one that omits it reads the VIX stream", () => {
    const vix = raw["VIX"]!;
    const vix3m = vix.map((p) => ({ date: p.date, value: p.value * 1.1 }));
    const asof = run.dateAxis[last]!;
    const fromVix = requireComplete(runRegime({ ...raw, [V5_INPUT_IDS.vix3m]: vix3m }, { version: "v5", asof }));
    const own = requireComplete(runRegime({ ...raw, [V5_INPUT_IDS.vix3m]: vix3m, [V5_INPUT_IDS.vix]: vix.map((p) => ({ date: p.date, value: p.value * 2 })) }, { version: "v5", asof }));
    const term = (r: typeof fromVix) => buildReport(r).indicators.find((i) => i.id === "VIX_TERM")!;
    expect(term(fromVix).weight).toBeGreaterThan(0);
    expect(term(own).weight).toBeGreaterThan(0);
    // The ratio is 1.1 everywhere in one input and 0.55 in the other: a constant, so both rank 0.5 on every day.
    expect(term(fromVix).rank).toBe(0.5);
    expect(term(own).rank).toBe(0.5);
    // Under v4 the same extra series change nothing.
    expect(JSON.stringify(buildReport(requireComplete(runRegime({ ...raw, [V5_INPUT_IDS.vix3m]: vix3m }, { asof }))))).toBe(JSON.stringify(buildReport(requireComplete(runRegime(raw, { asof })))));
  });
});

// ── The regime command accepts v5 ───────────────────────────────────────────

describe("bun run regime --methodology v5 (issue 1753)", () => {
  const PKG = join(import.meta.dir, "..");
  const cli = async (args: string[]) => {
    const p = Bun.spawn(["bun", join(PKG, "bin/regime.ts"), ...args], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  };

  test("the command, run as a process, prints the v5 report runRegime gives; an unknown methodology is a usage error", async () => {
    const out = await cli([join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "--methodology", "v5"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));
    expect(out.stdout).toBe(JSON.stringify(buildReport(requireComplete(runRegime(raw, { version: "v5", factor: false }))), null, 2) + "\n");
    const report = JSON.parse(out.stdout) as { version: string; indicators: unknown[] };
    expect(report.version).toBe("v5");
    expect(report.indicators.length).toBe(30);
    const bad = await cli([join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "--methodology", "v99"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("version must be one of v3, v4, v5");
    expect(bad.stderr).toContain("--methodology v3|v4|v5");
  });
});

// ── No private copy of an SDK function on the v5 path ───────────────────────

describe("the kept-record module is built from the SDK's own functions (issue 1753)", () => {
  const source = readFileSync(join(import.meta.dir, "../src/analyze/kept-regime.ts"), "utf8");
  const imported = (name: string, from: string) => new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "${from.replace(/[.]/g, "\\.")}"`).test(source);

  test("fitPanelWeights, weightedMeanOnDay, deriveSeries, smoothRegimes and rollingPercentileRank are read by import and called", () => {
    for (const [name, from] of [
      ["fitPanelWeights", "./compute.ts"],
      ["weightedMeanOnDay", "./compute.ts"],
      ["smoothRegimes", "./compute.ts"],
      ["panelMean", "./compute.ts"],
      ["deriveSeries", "../transform/derived.ts"],
      ["rollingPercentileRank", "../transform/math.ts"],
      ["prepareRegimeInputs", "../prepare.ts"],
    ] as const) {
      expect(imported(name, from), `${name} from ${from}`).toBe(true);
      expect(source.includes(`${name}(`), `${name} is called`).toBe(true);
      // No local definition under the same name.
      expect(new RegExp(`(function|const|let)\\s+${name}\\b`).test(source), `${name} defined locally`).toBe(false);
    }
  });

  test("it defines no weighting, ranking, correlation or smoothing of its own", () => {
    for (const forbidden of ["inverseCorrelationWeights", "pearson", "correlation(", "capWeights", "ddDiv", "dotDD", "sumDD", "Math.sqrt", ".sort("]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    // run.ts routes v5 to it rather than repeating it.
    const run = readFileSync(join(import.meta.dir, "../src/run.ts"), "utf8");
    expect(run.includes('import { computeKeptRegime, withDerivedSeries, type KeptRegimeRun } from "./analyze/kept-regime.ts"')).toBe(true);
    expect(run.includes("rollingPercentileRank")).toBe(false);
  });
});

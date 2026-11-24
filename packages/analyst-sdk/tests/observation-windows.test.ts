// Observation-day windows (issue 1741, decision D93): an exchange series is
// transformed, ranked and correlated over its own real observations; a day
// with a missing panel has a NaN composite. v3, daily and periodic are unchanged.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareRegimeInputs } from "../src/prepare.ts";
import { computeRegime } from "../src/analyze/compute.ts";
import {
  CalendarError, INDICATORS, calendarOf, type Calendar, type FillPolicy, type Indicator,
} from "../src/analyze/indicators.ts";
import { REGIME_MISSING_PANEL, REGIME_OBSERVATION_WINDOWS } from "../src/analyze/regime-versions.ts";
import { applyTransform } from "../src/transform/transforms.ts";
import { buildDateAxis, inverseCorrelationWeights, rollingPercentileRank } from "../src/transform/math.ts";
import { computeDiffNote, NOTE_PATH } from "./support/regime-diff-note.ts";

const FORWARD: FillPolicy = { kind: "forward", maxAgeDays: 120 };
const mk = (id: string, calendar: Calendar, transform = "level", panel: Indicator["panel"] = "macro"): Indicator => ({
  id, name: id, panel, source: "test", sign: 1, transform, unit: "x", fill: FORWARD, fillReason: "test", calendar, publication: { kind: "same-day" },
});
const START = "2021-12-20"; // a refresh date of the 21-day calendar
const ASOF = "2023-12-31";
const AXIS = buildDateAxis(START, ASOF);
const isWeekday = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
// Deterministic pseudo-random walk value for the day index.
const val = (k: number, salt: number) => 100 + 10 * Math.sin(k / (7 + salt)) + ((k * 7919 + salt * 104729) % 13) / 3;
const weekdays = (salt: number) => AXIS.filter(isWeekday).map((date, k) => ({ date, value: val(k, salt) }));
const everyDay = (salt: number) => AXIS.map((date, k) => ({ date, value: val(k, salt) }));

describe("calendar declaration", () => {
  test("the 26 registry rows match the scoped table: 10 daily, 14 exchange, 2 periodic", () => {
    const by = (c: string) => INDICATORS.filter((i) => i.calendar === c).map((i) => i.id).sort();
    expect(INDICATORS.length).toBe(26);
    expect(by("periodic")).toEqual(["ICSA", "SHILLER_CAPE"]);
    expect(by("exchange")).toEqual(["COPPER_GOLD", "DFII10", "DXY", "HY_OAS", "IWF_IWD", "IWM_SPY", "MTUM_SPY", "SPHB_SPLV", "SPX_TREND", "T10Y2Y", "T5YIE", "VIX", "XLP_XLY", "XLU_SPY"]);
    expect(by("daily").length).toBe(10);
  });

  test("a row with a missing or unknown calendar throws the named error from prepareRegimeInputs before any computation", () => {
    const bad = { ...mk("X", "daily"), calendar: undefined } as unknown as Indicator;
    expect(() => prepareRegimeInputs({}, { start: START, asof: ASOF, indicators: [bad] })).toThrow(CalendarError);
    expect(() => prepareRegimeInputs({}, { start: START, asof: ASOF, indicators: [bad] })).toThrow(/indicator X/);
    const odd = { ...mk("Y", "daily"), calendar: "weekly" } as unknown as Indicator;
    expect(() => calendarOf(odd)).toThrow(/unknown calendar/);
  });
});

describe("carried mask", () => {
  test("carried is true exactly where the fill age is above 0, with a weekend and a holiday gap", () => {
    const rows = weekdays(1).filter((p) => p.date !== "2022-01-19");
    const p = prepareRegimeInputs({ E: rows }, { start: START, asof: ASOF, indicators: [mk("E", "exchange")] });
    expect(p.carried.E!.length).toBe(AXIS.length);
    p.ages.E!.forEach((a, i) => expect(p.carried.E![i]).toBe(a > 0));
    expect(p.carried.E![AXIS.indexOf("2022-01-08")]).toBe(true); // Saturday
    expect(p.carried.E![AXIS.indexOf("2022-01-19")]).toBe(true); // the holiday
    expect(p.carried.E![AXIS.indexOf("2022-01-20")]).toBe(false);
  });
});

describe("transform over observation days", () => {
  test("SPX_TREND equals SMA50/SMA200 over the unfilled closes, and a closed day repeats the prior trading day", () => {
    const rows = weekdays(2);
    const ind = mk("S", "exchange", "trend_50_200");
    const v4 = prepareRegimeInputs({ S: rows }, { start: START, asof: ASOF, indicators: [ind], version: "v4" }).transformed.S!;
    const v3 = prepareRegimeInputs({ S: rows }, { start: START, asof: ASOF, indicators: [ind], version: "v3" }).transformed.S!;
    // Independent calculation.
    const closes = rows.map((r) => r.value);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const trend = closes.map((_, k) => (k >= 199 ? mean(closes.slice(k - 49, k + 1)) / mean(closes.slice(k - 199, k + 1)) : NaN));
    rows.forEach((r, k) => {
      const got = v4[AXIS.indexOf(r.date)]!;
      if (Number.isNaN(trend[k]!)) expect(got).toBeNaN();
      else expect(got).toBeCloseTo(trend[k]!, 12);
    });
    expect(v4[AXIS.indexOf("2023-12-30")]).toBe(v4[AXIS.indexOf("2023-12-29")]!); // Saturday = Friday
    expect(v4[AXIS.indexOf("2023-12-31")]).toBe(v4[AXIS.indexOf("2023-12-29")]!);
    expect(v3[AXIS.indexOf("2023-12-29")]).not.toBe(v4[AXIS.indexOf("2023-12-29")]!);
  });
});

describe("rank over observation days", () => {
  test("a real day ranks among the real observations in the calendar window, and a carried day repeats it", () => {
    const rows = weekdays(3);
    const filled = prepareRegimeInputs({ E: rows }, { start: START, asof: ASOF, indicators: [mk("E", "exchange")] });
    const xs = filled.transformed.E!;
    const masked = rollingPercentileRank(xs, 365, filled.carried.E!);
    // Independent: rank each real observation over the real observations whose axis index is in its window.
    const real = rows.map((r) => ({ i: AXIS.indexOf(r.date), v: r.value }));
    let last = NaN;
    AXIS.forEach((d, i) => {
      const r = real.find((x) => x.i === i);
      if (r) {
        const w = real.filter((x) => x.i > i - 365 && x.i <= i);
        last = w.length < 30 ? NaN : (w.filter((x) => x.v < r.v).length + 0.5 * w.filter((x) => x.v === r.v).length) / w.length;
      }
      if (Number.isNaN(last)) expect(masked[i]).toBeNaN();
      else expect(masked[i]).toBeCloseTo(last, 12);
    });
  });

  test("fewer than 30 real observations is NaN", () => {
    const xs = AXIS.slice(0, 40).map((_, i) => 1 + i);
    const carried = xs.map((_, i) => i % 7 >= 5 || i < 12); // 12 leading carried, plus weekends
    expect(rollingPercentileRank(xs, 365, carried).every(Number.isNaN)).toBe(true);
  });

  test("no mask, or no carried rows, ranks exactly as before", () => {
    const xs = everyDay(4).map((p) => p.value);
    expect(rollingPercentileRank(xs, 365, xs.map(() => false))).toEqual(rollingPercentileRank(xs, 365));
  });
});

describe("weights over observation days", () => {
  const ids = ["A", "B", "C"];
  const series = ids.map((_, k) => weekdays(10 + k));
  const prepared = prepareRegimeInputs(
    Object.fromEntries(ids.map((id, k) => [id, series[k]!])),
    { start: START, asof: ASOF, indicators: ids.map((id) => mk(id, "exchange")) },
  );
  const panel = Object.fromEntries(ids.map((id) => [id, rollingPercentileRank(prepared.transformed[id]!, 365)]));

  test("weights equal those fitted with the carried rows removed", () => {
    const withMask = inverseCorrelationWeights(panel, 60, 0.25, prepared.carried);
    const removed = Object.fromEntries(ids.map((id) => [id, panel[id]!.filter((_, i) => !prepared.carried[id]![i])]));
    expect(withMask).toEqual(inverseCorrelationWeights(removed));
  });

  test("a series with fewer than 60 real observations gets weight 0", () => {
    const short = { ...panel, S: panel.A!.map((v, i) => (i < 700 ? NaN : v)) };
    const carried = { ...prepared.carried, S: AXIS.map((d, i) => i < 700 || !isWeekday(d) || i >= 760) };
    const real = carried.S!.filter((c, i) => !c && Number.isFinite(short.S![i])).length;
    expect(real).toBeLessThan(60);
    expect(inverseCorrelationWeights(short, 60, 0.25, carried).S).toBe(0);
  });
});

describe("periodic and daily series are unchanged", () => {
  const weekly = AXIS.filter((_, i) => i % 7 === 5).map((date, k) => ({ date, value: val(k, 20) }));
  const monthly = AXIS.filter((d) => d.endsWith("-01")).map((date, k) => ({ date, value: val(k, 21) }));
  const daily = everyDay(22);

  test("v4 and v3 give identical transformed values for periodic and daily series", () => {
    const inds = [mk("W", "periodic", "sma4"), mk("M", "periodic"), mk("D", "daily", "change30")];
    const raw = { W: weekly, M: monthly, D: daily };
    const a = prepareRegimeInputs(raw, { start: START, asof: ASOF, indicators: inds, version: "v4", observationDays: true });
    const b = prepareRegimeInputs(raw, { start: START, asof: ASOF, indicators: inds, version: "v3", observationDays: false });
    expect(a.transformed).toEqual(b.transformed);
  });

  test("a periodic series keeps counting carried rows in rank and weight, and a monthly series keeps a nonzero weight", () => {
    const inds = [mk("W", "periodic"), mk("M", "periodic"), mk("D", "daily")];
    const raw = { W: weekly, M: monthly, D: daily };
    const prep = prepareRegimeInputs(raw, { start: START, asof: ASOF, indicators: inds, version: "v4" });
    const withMask = computeRegime(prep.transformed, prep.dateAxis, ["macro"], prep.ages, undefined, "v4", undefined, inds, undefined, prep.carried);
    const noMask = computeRegime(prep.transformed, prep.dateAxis, ["macro"], prep.ages, undefined, "v4", undefined, inds);
    expect(withMask.ranks).toEqual(noMask.ranks);
    expect(withMask.weightsByPanel).toEqual(noMask.weightsByPanel);
    expect(withMask.weightsByPanel.macro!.M!).toBeGreaterThan(0);
  });

  test("masked and unmasked kernels agree on a series with no carried rows", () => {
    const xs = daily.map((p) => p.value);
    const none = xs.map(() => false);
    expect(rollingPercentileRank(xs, 365, none)).toEqual(rollingPercentileRank(xs, 365));
    const panel = { A: rollingPercentileRank(xs, 365), B: rollingPercentileRank(xs.map((v) => -v * 1.01 + Math.sin(v)), 365) };
    expect(inverseCorrelationWeights(panel, 60, 0.25, { A: none, B: none })).toEqual(inverseCorrelationWeights(panel));
  });
});

describe("composite with a missing panel", () => {
  const inds = [mk("A", "daily", "level", "macro"), mk("B", "daily", "level", "onchain")];
  const axis = AXIS.slice(0, 500);
  const data = { A: axis.map((_, i) => Math.sin(i / 5) + i / 100), B: axis.map((_, i) => (i < 350 ? NaN : Math.cos(i / 6) + i / 90)) };

  test("v4: a day with a non-finite panel index has a NaN composite and a null label, other panels unchanged", () => {
    const r = computeRegime(data, axis, ["macro", "onchain"], undefined, undefined, "v4", undefined, inds);
    const v3 = computeRegime(data, axis, ["macro", "onchain"], undefined, undefined, "v3", undefined, inds);
    const i = 300;
    expect(Number.isFinite(r.panelIndices.macro![i]!)).toBe(true);
    expect(r.panelIndices.onchain![i]!).toBeNaN();
    expect(r.composite[i]!).toBeNaN();
    expect(r.regime[i]).toBeNull();
    expect(r.panelIndices.macro![i]).toBe(v3.panelIndices.macro![i]!);
    expect(Number.isFinite(v3.composite[i]!)).toBe(true); // v3 re-bases onto macro
  });
});

describe("per-version declaration and the diff note", () => {
  test("the rules are declared per version: v3 keeps forward-filled windows and the re-based composite", () => {
    expect(REGIME_OBSERVATION_WINDOWS).toEqual({ v3: false, v4: true });
    expect(REGIME_MISSING_PANEL).toEqual({ v3: "rebase", v4: "nan" });
  });

  test("the committed diff note equals the one recomputed from the old and new rules", () => {
    expect(computeDiffNote()).toEqual(JSON.parse(readFileSync(NOTE_PATH, "utf8")));
  });
});

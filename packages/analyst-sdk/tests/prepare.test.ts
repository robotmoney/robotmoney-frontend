// prepareRegimeInputs unit tests with synthetic registries. The shipped registry
// has no zero-fill indicator, so these are the only red controls for that branch,
// for lastRaw, and for the empty-series rule (all NaN, for every transform).
// Each fill policy's own rules are pinned by tests/fill-policy.test.ts.
import { beforeAll, describe, expect, test } from "bun:test";
import { prepareRegimeInputs } from "../src/prepare.ts";
import type { FillPolicy, Indicator } from "../src/analyze/indicators.ts";

const ZERO: FillPolicy = { kind: "zero" };
const FORWARD: FillPolicy = { kind: "forward", maxAgeDays: 120 };
const mk = (id: string, transform: string, fill: FillPolicy = FORWARD): Indicator => ({
  id, name: id, panel: "macro", source: "test", sign: 1, transform, unit: "x", fill, fillReason: "test", calendar: "daily", publication: { kind: "same-day" },
});
const TRANSFORMS = ["level", "change30", "change90", "sma4", "sma7", "trend_50_200", "rolling_sum_7"];
const START = "2024-01-01";
const ASOF = "2024-01-10";

describe("prepareRegimeInputs", () => {
  test("zero_fill: gaps are 0, no age is produced; forward-fill carries the value and has an age", () => {
    const rows = [{ date: "2024-01-03", value: 5 }, { date: "2024-01-06", value: 7 }];
    const p = prepareRegimeInputs(
      { Z: rows, F: rows },
      { start: START, asof: ASOF, indicators: [mk("Z", "level", ZERO), mk("F", "level")] },
    );
    expect(p.dateAxis.length).toBe(10);
    expect(p.transformed.Z).toEqual([NaN, NaN, 5, 0, 0, 7, 0, 0, 0, 0]);
    expect(p.transformed.F).toEqual([NaN, NaN, 5, 5, 5, 7, 7, 7, 7, 7]);
    expect("Z" in p.ages).toBe(false);
    expect(p.ages.F).toEqual([NaN, NaN, 0, 1, 2, 0, 1, 2, 3, 4]);
  });

  // Issue 1733, finding P1: lastRaw is cut at the as-of day like every field.
  test("lastRaw is each series' last row known on or before asof, never one dated after it, and null when empty or absent", () => {
    const p = prepareRegimeInputs(
      { A: [{ date: "2024-01-02", value: 1 }, { date: "2024-01-20", value: 9 }], E: [] },
      { start: START, asof: ASOF, indicators: [mk("A", "level"), mk("E", "level"), mk("M", "level")] },
    );
    expect(p.lastRaw.A).toEqual({ date: "2024-01-02", value: 1 });
    for (const r of Object.values(p.lastRaw)) if (r) expect(r.date <= ASOF).toBe(true);
    expect(p.lastRaw.E).toBeNull();
    expect(p.lastRaw.M).toBeNull();
    // A row published after asof (here a next-business-day series) is not lastRaw either.
    const late = prepareRegimeInputs(
      { B: [{ date: "2024-01-05", value: 2 }, { date: "2024-01-10", value: 3 }] },
      { start: START, asof: ASOF, indicators: [{ ...mk("B", "level"), publication: { kind: "business-days", days: 1 } }] },
    );
    expect(late.lastRaw.B).toEqual({ date: "2024-01-05", value: 2 });
    // The row after asof never reaches the axis.
    expect(p.transformed.A!.length).toBe(10);
    expect(p.transformed.A![9]).toBe(1);
  });

  test("an empty or absent series is all NaN for every transform and zero_fill, with ages still NaN-filled for forward-fill", () => {
    const inds = TRANSFORMS.flatMap((t) => [mk(`E_${t}`, t), mk(`Z_${t}`, t, ZERO)]);
    const p = prepareRegimeInputs({ E_level: [] }, { start: START, asof: ASOF, indicators: inds });
    for (const ind of inds) {
      expect(p.transformed[ind.id]!.length).toBe(10);
      expect(p.transformed[ind.id]!.every(Number.isNaN)).toBe(true);
      expect(ind.id in p.ages).toBe(ind.fill.kind !== "zero");
      if (ind.fill.kind !== "zero") expect(p.ages[ind.id]!.every(Number.isNaN)).toBe(true);
    }
  });
});

// ── Ratios from their legs (analytics requirements 4.3, SDK-10, AN-4) ─────────
// The inputs (support/ratio-legs.ts): the committed fixture's eight ratios
// replaced by their two legs (sourceOnly), or by mergeRatioSeries(legs)
// (stored). runRegime(stored) and runRegime(sourceOnly) each run once, in
// beforeAll, and each one result feeds every check and report built from that
// input (issue 1667).
import * as grid from "../src/transform/grid.ts";
import * as sdk from "../src/index.ts";
import { mergeRatioSeries } from "../src/transform/grid.ts";
import { mergeRatioSeries as fetchRatio } from "../src/extract/sources.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../src/transform/ratios.ts";
const V3_RATIOS = ratioDeclarationsFor("v3");
import { buildReport, runRegime as runRegimeOutcome, requireComplete, type RunResult } from "../src/run.ts";
// Each run here scores a complete day (issue 1655): an IncompleteDay fails the test.
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));
import type { Point, RawIndicatorHistory } from "../src/types.ts";
import { fixture, legInputs, legsOf, RATIOS } from "./support/ratio-legs.ts";
import { INDICATORS } from "../src/analyze/indicators.ts";

describe("ratios from legs (SDK-10)", () => {
  const { legs, sourceOnly, stored } = legInputs();
  let storedRun: RunResult;
  let sourceOnlyRun: RunResult;
  beforeAll(() => {
    // Issue 1733: v4 reads the equity ratios from raw-close legs; these pin the
    // stored and adjusted declarations, which v3 keeps.
    storedRun = runRegime(stored, { version: "v3" });
    sourceOnlyRun = runRegime(sourceOnly, { version: "v3" });
  }, 120_000);

  // Issue 1644: the committed fixture carries the stored ratios and both
  // closes of every leg. The ratio from the adjusted legs covers every date
  // the stored ratio has. No regime runs.
  test("the ratio from the committed adjusted legs has every date of the fixture's stored ratio", () => {
    expect(RATIOS.length).toBe(8);
    for (const ratio of RATIOS) {
      const [num, den] = (INDICATORS.find((i) => i.id === ratio)!.series as string[]).map((sym) => fixture[`yahoo:${sym}.adjclose`]!);
      expect(num?.length ?? 0, ratio).toBeGreaterThan(0);
      const computed = new Set(mergeRatioSeries(num!, den!).map((p) => p.date));
      const stored = fixture[ratio]!;
      expect(stored.length, ratio).toBeGreaterThan(0);
      expect(stored.filter((p) => !computed.has(p.date)).map((p) => p.date), ratio).toEqual([]);
    }
  });

  test("under ratioInput stored, ratiosFromLegs keeps a stored IWM_SPY (same array) over legs that differ, and computes it from the adjusted legs alone", () => {
    const dates = ["2024-01-02", "2024-01-03", "2024-01-04"];
    const iwm = dates.map((date, i) => ({ date, value: 200 + i }));
    const spy = dates.map((date, i) => ({ date, value: 470 + i }));
    const storedIwmSpy = dates.map((date) => ({ date, value: 0.1 }));
    const run = (h: RawIndicatorHistory) => ratiosFromLegs(h, resolveInputHistory(h), V3_RATIOS);
    // SPY is also MTUM_SPY's and XLU_SPY's denominator, so their numerators come along.
    const adjusted: RawIndicatorHistory = { "yahoo:IWM.adjclose": iwm, "yahoo:SPY.adjclose": spy, "yahoo:MTUM.adjclose": iwm, "yahoo:XLU.adjclose": iwm };
    const older: RawIndicatorHistory = { "yahoo:IWM": iwm, "research:SPY": spy, "yahoo:MTUM": iwm, "yahoo:XLU": iwm };
    const withStored: RawIndicatorHistory = { IWM_SPY: storedIwmSpy, ...adjusted };
    expect(run(withStored).IWM_SPY).toBe(storedIwmSpy);
    expect(run(adjusted).IWM_SPY).toEqual(mergeRatioSeries(iwm, spy));
    expect(run(older).IWM_SPY).toEqual(mergeRatioSeries(iwm, spy));
    // The .adjclose key wins over an older name; the raw .close legs are not read.
    const raw = iwm.map((p) => ({ date: p.date, value: p.value * 3 }));
    expect(run({ ...older, ...adjusted, "yahoo:IWM.close": raw, "yahoo:SPY.close": raw, "yahoo:IWM": raw }).IWM_SPY).toEqual(mergeRatioSeries(iwm, spy));
  });

  test("each of the eight ratios is mergeRatioSeries(legs) byte for byte, and the report equals the stored-ratio report", () => {
    expect(RATIOS.length).toBe(8);
    const resolved = ratiosFromLegs(sourceOnly, resolveInputHistory(sourceOnly), V3_RATIOS);
    for (const ratio of RATIOS) {
      const [num, den] = legsOf(ratio);
      expect(JSON.stringify(resolved[ratio]), ratio).toBe(JSON.stringify(mergeRatioSeries(legs[num]!, legs[den]!)));
      expect(resolved[ratio]!.length, ratio).toBeGreaterThan(0);
    }
    const canon = (run: RunResult) => JSON.stringify(buildReport(run, { full: true }));
    expect(canon(sourceOnlyRun)).toBe(canon(storedRun));
  }, 120_000);

  test("a replay input with a stored ratio and both legs uses the stored ratio unchanged", () => {
    // Legs that would give a different ratio: the stored one must win.
    const other: Point[] = legs["yahoo:GC=F"]!.map((p) => ({ date: p.date, value: p.value * 2 }));
    const replay: RawIndicatorHistory = { ...stored, "yahoo:HG=F": legs["yahoo:HG=F"]!, "yahoo:GC=F": other };
    expect(ratiosFromLegs(replay, resolveInputHistory(replay), V3_RATIOS).COPPER_GOLD).toBe(stored.COPPER_GOLD!);
    const canon = (run: RunResult) => JSON.stringify(buildReport(run));
    expect(canon(runRegime(replay, { version: "v3" }))).toBe(canon(storedRun));
  }, 120_000);

  test("one ratio function: ratioByDate is gone, and the fetch uses the same mergeRatioSeries", () => {
    expect("ratioByDate" in grid).toBe(false);
    expect("ratioByDate" in sdk).toBe(false);
    expect(fetchRatio).toBe(mergeRatioSeries);
    const a = [1, 2, 3, 4].map((v, i) => ({ date: `2024-01-0${i + 1}`, value: v }));
    // A 0, a NaN and a missing denominator are each skipped.
    const b = [{ date: "2024-01-01", value: 0 }, { date: "2024-01-02", value: NaN }, { date: "2024-01-04", value: 2 }];
    expect(mergeRatioSeries(a, b)).toEqual([{ date: "2024-01-04", value: 2 }]);
  });
});

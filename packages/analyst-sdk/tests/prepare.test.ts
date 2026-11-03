// prepareRegimeInputs unit tests with synthetic registries. The shipped registry
// has no zero_fill indicator, so these are the only red controls for that branch,
// for lastRaw, and for the empty-series rule (all NaN, for every transform).
import { describe, expect, test } from "bun:test";
import { prepareRegimeInputs } from "../src/prepare.ts";
import type { Indicator } from "../src/analyze/indicators.ts";

const mk = (id: string, transform: string, align?: "zero_fill"): Indicator => ({
  id, name: id, panel: "macro", source: "test", sign: 1, transform, unit: "x", ...(align ? { align } : {}),
});
const TRANSFORMS = ["level", "change30", "change90", "sma4", "sma7", "trend_50_200", "rolling_sum_7"];
const START = "2024-01-01";
const ASOF = "2024-01-10";

describe("prepareRegimeInputs", () => {
  test("zero_fill: gaps are 0, no age is produced; forward-fill carries the value and has an age", () => {
    const rows = [{ date: "2024-01-03", value: 5 }, { date: "2024-01-06", value: 7 }];
    const p = prepareRegimeInputs(
      { Z: rows, F: rows },
      { start: START, asof: ASOF, indicators: [mk("Z", "level", "zero_fill"), mk("F", "level")] },
    );
    expect(p.dateAxis.length).toBe(10);
    expect(p.transformed.Z).toEqual([NaN, NaN, 5, 0, 0, 7, 0, 0, 0, 0]);
    expect(p.transformed.F).toEqual([NaN, NaN, 5, 5, 5, 7, 7, 7, 7, 7]);
    expect("Z" in p.ages).toBe(false);
    expect(p.ages.F).toEqual([NaN, NaN, 0, 1, 2, 0, 1, 2, 3, 4]);
  });

  test("lastRaw is each series' last row as given (even after asof) and null when empty or absent", () => {
    const p = prepareRegimeInputs(
      { A: [{ date: "2024-01-02", value: 1 }, { date: "2024-01-20", value: 9 }], E: [] },
      { start: START, asof: ASOF, indicators: [mk("A", "level"), mk("E", "level"), mk("M", "level")] },
    );
    expect(p.lastRaw.A).toEqual({ date: "2024-01-20", value: 9 });
    expect(p.lastRaw.E).toBeNull();
    expect(p.lastRaw.M).toBeNull();
    // The row after asof never reaches the axis.
    expect(p.transformed.A!.length).toBe(10);
    expect(p.transformed.A![9]).toBe(1);
  });

  test("an empty or absent series is all NaN for every transform and zero_fill, with ages still NaN-filled for forward-fill", () => {
    const inds = TRANSFORMS.flatMap((t) => [mk(`E_${t}`, t), mk(`Z_${t}`, t, "zero_fill")]);
    const p = prepareRegimeInputs({ E_level: [] }, { start: START, asof: ASOF, indicators: inds });
    for (const ind of inds) {
      expect(p.transformed[ind.id]!.length).toBe(10);
      expect(p.transformed[ind.id]!.every(Number.isNaN)).toBe(true);
      expect(ind.id in p.ages).toBe(ind.align !== "zero_fill");
      if (ind.align !== "zero_fill") expect(p.ages[ind.id]!.every(Number.isNaN)).toBe(true);
    }
  });
});

// ── Ratios from their legs (analytics requirements 4.3, SDK-10, AN-4) ─────────
// The committed fixture stores the eight ratios. The source-only input below
// drops them and carries each ratio's two legs under their source ids instead.
// Each numerator is the stored ratio times its denominator, so the legs are
// real-shaped data; the comparison input stores mergeRatioSeries(legs), the
// value a collector would have stored from the same legs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as grid from "../src/transform/grid.ts";
import * as sdk from "../src/index.ts";
import { mergeRatioSeries } from "../src/transform/grid.ts";
import { mergeRatioSeries as fetchRatio } from "../src/extract/sources.ts";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { RATIO_LEG_MAPPING, resolveInputHistory } from "../src/series-ids.ts";
import { ratiosFromLegs } from "../src/transform/ratios.ts";
import { buildReport, runRegime } from "../src/run.ts";
import type { Point, RawIndicatorHistory } from "../src/types.ts";

const fixture: RawIndicatorHistory = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures", "raw-indicator-history.csv"), "utf8")));
const RATIOS = [...new Set(RATIO_LEG_MAPPING.map((m) => m.consumer.slice("indicator:".length)))];
// Each leg by its source id, except the one leg another indicator also reads.
const ETH_LEG = "backtest:ETH-USD";
const legsOf = (ratio: string) => RATIO_LEG_MAPPING.filter((m) => m.consumer === `indicator:${ratio}`).map((m) => (m.storageKey === ETH_LEG ? ETH_LEG : m.series)) as [string, string];

// BTC_ETH's denominator leg is the fixture's ETH stream, named by its storage
// key backtest:ETH-USD (yahoo:ETH-USD alone would also name ETH_TREND's). Every other denominator is 4 on each ratio date.
function legInputs(): { legs: RawIndicatorHistory; sourceOnly: RawIndicatorHistory; stored: RawIndicatorHistory } {
  const legs: RawIndicatorHistory = {};
  const dens = new Map<string, Map<string, number>>();
  const eth = new Map(fixture.ETH!.map((p) => [p.date, p.value]));
  for (const ratio of RATIOS) {
    const [, den] = legsOf(ratio);
    const d = dens.get(den) ?? dens.set(den, new Map()).get(den)!;
    for (const p of fixture[ratio]!) if (den !== ETH_LEG) d.set(p.date, 4);
  }
  dens.set(ETH_LEG, eth);
  for (const [den, m] of dens) legs[den] = [...m].map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const ratio of RATIOS) {
    const [num, den] = legsOf(ratio);
    const d = dens.get(den)!;
    legs[num] = fixture[ratio]!.filter((p) => d.has(p.date)).map((p) => ({ date: p.date, value: p.value * d.get(p.date)! }));
  }
  const base: RawIndicatorHistory = {};
  for (const [k, v] of Object.entries(fixture)) if (!RATIOS.includes(k) && k !== "ETH") base[k] = v;
  const sourceOnly = { ...base, ...legs };
  const stored: RawIndicatorHistory = { ...base, [ETH_LEG]: legs[ETH_LEG]! };
  for (const ratio of RATIOS) stored[ratio] = mergeRatioSeries(legs[legsOf(ratio)[0]]!, legs[legsOf(ratio)[1]]!);
  return { legs, sourceOnly, stored };
}

describe("ratios from legs (SDK-10)", () => {
  const { legs, sourceOnly, stored } = legInputs();

  test("a source-only input with yahoo:HG=F and yahoo:GC=F ranks COPPER_GOLD on every date the stored ratio does", () => {
    const fromLegs = runRegime(sourceOnly).result.ranks.COPPER_GOLD!;
    const fromStored = runRegime(stored).result.ranks.COPPER_GOLD!;
    const finite = (xs: number[]) => xs.filter(Number.isFinite).length;
    expect(finite(fromStored)).toBeGreaterThan(0);
    expect(finite(fromLegs)).toBe(finite(fromStored));
    expect(fromLegs.map(Number.isFinite)).toEqual(fromStored.map(Number.isFinite));
  });

  test("each of the eight ratios is mergeRatioSeries(legs) byte for byte, and the report equals the stored-ratio report", () => {
    expect(RATIOS.length).toBe(8);
    const resolved = ratiosFromLegs(sourceOnly, resolveInputHistory(sourceOnly));
    for (const ratio of RATIOS) {
      const [num, den] = legsOf(ratio);
      expect(JSON.stringify(resolved[ratio]), ratio).toBe(JSON.stringify(mergeRatioSeries(legs[num]!, legs[den]!)));
      expect(resolved[ratio]!.length, ratio).toBeGreaterThan(0);
    }
    const canon = (h: RawIndicatorHistory) => JSON.stringify(buildReport(runRegime(h), { full: true }));
    expect(canon(sourceOnly)).toBe(canon(stored));
  }, 120_000);

  test("a replay input with a stored ratio and both legs uses the stored ratio unchanged", () => {
    // Legs that would give a different ratio: the stored one must win.
    const other: Point[] = legs["yahoo:GC=F"]!.map((p) => ({ date: p.date, value: p.value * 2 }));
    const replay: RawIndicatorHistory = { ...stored, "yahoo:HG=F": legs["yahoo:HG=F"]!, "yahoo:GC=F": other };
    expect(ratiosFromLegs(replay, resolveInputHistory(replay)).COPPER_GOLD).toBe(stored.COPPER_GOLD!);
    const canon = (h: RawIndicatorHistory) => JSON.stringify(buildReport(runRegime(h)));
    expect(canon(replay)).toBe(canon(stored));
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

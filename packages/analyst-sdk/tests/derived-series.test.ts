// Derived series (issue 1751, gap 7): deriveSeries reproduces the downstream
// FISCAL, VIX_TERM, SKEW and UPVOL_SHARE series bit for bit. Every expected
// value is computed here with plain in-order arithmetic, never with the SDK.
//
// Issue 1765 (phase 5): the custom op, a pure function with a declared
// publication lag, is called once per calendar day with its inputs cut at the
// day minus the lag. The four other ops ignore deriveSeries' options.
import { describe, expect, test } from "bun:test";
import { DerivedSeriesError, V5_DERIVED_SERIES, deriveSeries, derivedInputIds, type DerivedCustom, type DerivedSeries } from "../src/transform/derived.ts";
import { mergeRatioSeries } from "../src/transform/grid.ts";
import { PublicationRuleError } from "../src/transform/knowledge-time.ts";
import type { Point } from "../src/types.ts";

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const points = (rows: readonly (readonly [string, number])[]): Point[] => rows.map(([date, value]) => ({ date, value }));

describe("FISCAL: a sum of 12 observations over the latest public level", () => {
  // 30 monthly observations, millions of dollars, a deficit negative.
  const FLOW = points([
    ["2019-01-01", -123456.7], ["2019-02-01", 0.1], ["2019-03-01", 1e-3], ["2019-04-01", -98765.43],
    ["2019-05-01", 0.3], ["2019-06-01", -45678.9], ["2019-07-01", 12345.67], ["2019-08-01", -0.7],
    ["2019-09-01", -234567.89], ["2019-10-01", 1.1], ["2019-11-01", -3456.78], ["2019-12-01", -67890.12],
    ["2020-01-01", 0.2], ["2020-02-01", -111111.1], ["2020-03-01", 54321.9], ["2020-04-01", -0.003],
    ["2020-05-01", -87654.32], ["2020-06-01", -22222.2], ["2020-07-01", 0.7], ["2020-08-01", -135791.3],
    ["2020-09-01", -0.9], ["2020-10-01", -24680.2], ["2020-11-01", -99999.9], ["2020-12-01", 13579.1],
    ["2021-01-01", -0.11], ["2021-02-01", -76543.21], ["2021-03-01", -31415.92], ["2021-04-01", 2.7],
    ["2021-05-01", -161803.39], ["2021-06-01", -0.05],
  ]);
  // Quarterly level, billions. Public 120 calendar days after its date:
  // 2020-01-29, 2020-04-30, 2020-07-30, 2020-10-29, 2021-01-29 and 2021-05-01.
  const LEVEL = points([
    ["2019-10-01", 21694.5], ["2020-01-01", 21481.4], ["2020-04-01", 19477.4],
    ["2020-07-01", 21138.6], ["2020-10-01", 21477.6], ["2021-01-01", 22038.2],
  ]);
  // The level each observation reads, worked out by hand from the dates above.
  // Observations 11 (2019-12-01) and 12 (2020-01-01) have 12 values behind
  // them and no level public yet.
  const G_BY_OBSERVATION: Record<number, number> = {
    13: 21694.5, 14: 21694.5, 15: 21694.5,
    16: 21481.4, 17: 21481.4, 18: 21481.4,
    19: 19477.4, 20: 19477.4, 21: 19477.4,
    22: 21138.6, 23: 21138.6, 24: 21138.6,
    25: 21477.6, 26: 21477.6, 27: 21477.6,
    28: 22038.2, 29: 22038.2,
  };
  const fiscal = (summation: "plain" | "compensated"): DerivedSeries => ({
    op: "rolling-sum-over-known-level",
    id: "FISCAL",
    flow: "fred:MTSDS133FMS",
    level: "fred:GDP",
    periods: 12,
    summation,
    negate: true,
    divisor: 1000,
    multiplier: 100,
    levelPublication: { kind: "calendar-days", days: 120 },
    publication: { kind: "calendar-days", days: 43 },
  });
  const inputs = { "fred:MTSDS133FMS": FLOW, "fred:GDP": LEVEL };
  const v = FLOW.map((p) => p.value);
  const expectedAt = (i: number, g: number): number =>
    (-(v[i - 11]! + v[i - 10]! + v[i - 9]! + v[i - 8]! + v[i - 7]! + v[i - 6]! + v[i - 5]! + v[i - 4]! + v[i - 3]! + v[i - 2]! + v[i - 1]! + v[i]!) / 1000 / g) * 100;

  test("no point for the first 11 observations, nor while no level is public", () => {
    const out = deriveSeries(fiscal("plain"), inputs);
    expect(out.length).toBe(17);
    // Observation 13 is 2020-02-01, the first on or after 2020-01-29; 43 days later is 2020-03-15.
    expect(out[0]!.date).toBe("2020-03-15");
    expect(out.some((p) => p.date === addDays("2019-12-01", 43) || p.date === addDays("2020-01-01", 43))).toBe(false);
    expect(deriveSeries(fiscal("plain"), { "fred:MTSDS133FMS": FLOW.slice(0, 11), "fred:GDP": points([["2000-01-01", 10000]]) })).toEqual([]);
    expect(deriveSeries(fiscal("plain"), { "fred:MTSDS133FMS": FLOW, "fred:GDP": [] })).toEqual([]);
  });

  test("each value is (-(12 values added left to right) / 1000 / G) * 100, dated 43 days later", () => {
    const out = deriveSeries(fiscal("plain"), inputs);
    const indices = Object.keys(G_BY_OBSERVATION).map(Number);
    expect(out.length).toBe(indices.length);
    indices.forEach((i, k) => {
      expect(out[k]!.date).toBe(addDays(FLOW[i]!.date, 43));
      expect(Object.is(out[k]!.value, expectedAt(i, G_BY_OBSERVATION[i]!))).toBe(true);
    });
    // One value written out in full: observation 13, the 12 values from 2019-03-01 to 2020-02-01.
    const sum = 1e-3 + -98765.43 + 0.3 + -45678.9 + 12345.67 + -0.7 + -234567.89 + 1.1 + -3456.78 + -67890.12 + 0.2 + -111111.1;
    expect(out[0]).toEqual({ date: "2020-03-15", value: (-sum / 1000 / 21694.5) * 100 });
  });

  test("compensated summation gives a different double in some window", () => {
    const plain = deriveSeries(fiscal("plain"), inputs);
    const compensated = deriveSeries(fiscal("compensated"), inputs);
    expect(compensated.map((p) => p.date)).toEqual(plain.map((p) => p.date));
    // Observation 15 (2020-04-01, dated 2020-05-14) is one such window.
    expect(plain[2]!.date).toBe("2020-05-14");
    expect(Object.is(plain[2]!.value, expectedAt(15, 21694.5))).toBe(true);
    expect(Object.is(compensated[2]!.value, plain[2]!.value)).toBe(false);
    expect(Math.abs(compensated[2]!.value - plain[2]!.value)).toBeLessThan(1e-12);
    const differing = plain.filter((p, k) => p.value !== compensated[k]!.value).length;
    expect(differing).toBeGreaterThan(0);
    expect(differing).toBeLessThan(plain.length);
  });

  test("a level public exactly on the observation date counts; one a day later does not", () => {
    // 2021-01-01 plus 120 days is 2021-05-01, the date of observation 28.
    const exact = deriveSeries(fiscal("plain"), inputs);
    const at = addDays("2021-05-01", 43);
    expect(at).toBe("2021-06-13");
    expect(Object.is(exact.find((p) => p.date === at)!.value, expectedAt(28, 22038.2))).toBe(true);
    // Dated 2021-01-02 it is public on 2021-05-02: observation 28 still reads the level before it.
    const late = [...LEVEL.slice(0, 5), { date: "2021-01-02", value: 22038.2 }];
    const short = deriveSeries(fiscal("plain"), { "fred:MTSDS133FMS": FLOW, "fred:GDP": late });
    expect(Object.is(short.find((p) => p.date === at)!.value, expectedAt(28, 21477.6))).toBe(true);
    expect(expectedAt(28, 21477.6)).not.toBe(expectedAt(28, 22038.2));
    // Observation 29 (2021-06-01) reads it in both.
    expect(Object.is(short.at(-1)!.value, expectedAt(29, 22038.2))).toBe(true);
  });

  test("inputs in any date order give the same series, and are not changed", () => {
    const flow = [...FLOW].reverse();
    const level = [...LEVEL].reverse();
    const first = flow[0]!.date;
    expect(deriveSeries(fiscal("plain"), { "fred:MTSDS133FMS": flow, "fred:GDP": level })).toEqual(deriveSeries(fiscal("plain"), inputs));
    expect(flow[0]!.date).toBe(first);
  });
});

describe("VIX_TERM and SKEW: a ratio and a level, dated 1 calendar day later", () => {
  // ^VIX has no 2024-03-06 and a 0 on 2024-03-07: the ratio skips both dates.
  const VIX3M = points([["2024-03-01", 15.62], ["2024-03-04", 15.9], ["2024-03-05", 16.41], ["2024-03-06", 16.2], ["2024-03-07", 16.05], ["2024-03-08", 16.33]]);
  const VIX = points([["2024-03-01", 13.11], ["2024-03-04", 13.49], ["2024-03-05", 14.46], ["2024-03-07", 0], ["2024-03-08", 14.74]]);
  const SKEW = points([["2024-03-01", 147.2], ["2024-03-04", 149.85], ["2024-03-08", 151.3]]);
  const inputs = { "yahoo:^VIX3M.close": VIX3M, "yahoo:^VIX.close": VIX, "yahoo:^SKEW.close": SKEW };
  const nextDay = { kind: "calendar-days", days: 1 } as const;

  test("op ratio equals mergeRatioSeries with every date moved 1 day later", () => {
    const out = deriveSeries({ op: "ratio", id: "VIX_TERM", numerator: "yahoo:^VIX3M.close", denominator: "yahoo:^VIX.close", publication: nextDay }, inputs);
    expect(out).toEqual(mergeRatioSeries(VIX3M, VIX).map((p) => ({ date: addDays(p.date, 1), value: p.value })));
    expect(out).toEqual([
      { date: "2024-03-02", value: 15.62 / 13.11 },
      { date: "2024-03-05", value: 15.9 / 13.49 },
      { date: "2024-03-06", value: 16.41 / 14.46 },
      { date: "2024-03-09", value: 16.33 / 14.74 },
    ]);
  });

  test("op level returns the input values dated 1 day later", () => {
    const out = deriveSeries({ op: "level", id: "SKEW", input: "yahoo:^SKEW.close", publication: nextDay }, inputs);
    expect(out).toEqual([{ date: "2024-03-02", value: 147.2 }, { date: "2024-03-05", value: 149.85 }, { date: "2024-03-09", value: 151.3 }]);
  });

  test("without a publication rule the dates stay", () => {
    expect(deriveSeries({ op: "level", id: "SKEW", input: "yahoo:^SKEW.close" }, inputs)).toEqual(SKEW);
    expect(deriveSeries({ op: "ratio", id: "VIX_TERM", numerator: "yahoo:^VIX3M.close", denominator: "yahoo:^VIX.close" }, inputs)).toEqual(mergeRatioSeries(VIX3M, VIX));
  });
});

describe("UPVOL_SHARE: the share of volume on up days over 20 rows", () => {
  // [date, close, volume]. 23 rows count. Every Monday follows a weekend gap.
  // 2024-01-23 ties the close of 2024-01-22.
  const ROWS: readonly (readonly [string, number, number])[] = [
    ["2024-01-02", 4742.83, 3743050000], ["2024-01-03", 4704.81, 3950760000], ["2024-01-04", 4688.68, 3715480000],
    ["2024-01-05", 4697.24, 3844370000], ["2024-01-08", 4763.54, 3742320000], ["2024-01-09", 4756.5, 3529960000],
    ["2024-01-11", 4780.24, 3759890000], ["2024-01-12", 4783.83, 3486340000], ["2024-01-16", 4765.98, 4260550000],
    ["2024-01-18", 4780.94, 4019000000], ["2024-01-19", 4839.81, 4287200000], ["2024-01-22", 4850.43, 4297610000],
    ["2024-01-23", 4850.43, 3751400000], ["2024-01-24", 4868.55, 4330030000], ["2024-01-25", 4894.16, 4020430000],
    ["2024-01-26", 4890.97, 3353400000], ["2024-01-29", 4927.93, 3525160000], ["2024-01-30", 4924.97, 3836130000],
    ["2024-01-31", 4845.65, 4696120000], ["2024-02-01", 4906.19, 4386090000], ["2024-02-02", 4958.61, 3974350000],
    ["2024-02-05", 4942.81, 4023640000], ["2024-02-06", 4954.23, 3832410000],
  ];
  // Two excluded dates. 2024-01-10 has volume and no close. 2024-01-17 has a
  // close above both neighbours and volume 0: were it kept, 2024-01-18 would
  // not be an up day.
  const NO_CLOSE = { date: "2024-01-10", value: 3498680000 };
  const ZERO_VOLUME: readonly [string, number, number] = ["2024-01-17", 4800, 0];
  const CLOSE = points([...ROWS, ZERO_VOLUME].map(([d, c]) => [d, c] as const));
  const VOLUME = [...points([...ROWS, ZERO_VOLUME].map(([d, , vol]) => [d, vol] as const)), NO_CLOSE];
  const inputs = { "yahoo:^GSPC.close": CLOSE, "yahoo:^GSPC.volume": VOLUME };
  const decl: DerivedSeries = {
    op: "up-volume-share", id: "UPVOL_SHARE", close: "yahoo:^GSPC.close", volume: "yahoo:^GSPC.volume", window: 20,
    publication: { kind: "calendar-days", days: 1 },
  };
  type Row = readonly [string, number, number];
  const previousRow = (rows: readonly Row[], j: number) => rows[j]![1] > rows[j - 1]![1];
  // up / all over rows i-19..i, by plain addition in order.
  const share = (rows: readonly Row[], i: number, isUp: (rows: readonly Row[], j: number) => boolean = previousRow): number => {
    let all = 0;
    let up = 0;
    for (let j = i - 19; j <= i; j++) {
      all = all + rows[j]![2];
      if (isUp(rows, j)) up = up + rows[j]![2];
    }
    return up / all;
  };
  const out = deriveSeries(decl, inputs);

  test("no value before the 21st row; each value is up / all, dated 1 day after its row", () => {
    expect(out.length).toBe(3);
    expect(out.map((p) => p.date)).toEqual(["2024-02-03", "2024-02-06", "2024-02-07"]);
    [20, 21, 22].forEach((i, k) => {
      expect(out[k]!.date).toBe(addDays(ROWS[i]![0], 1));
      expect(Object.is(out[k]!.value, share(ROWS, i))).toBe(true);
    });
    // 20 rows that count give nothing; the 21st gives the first value.
    const first = (n: number) => ROWS.slice(0, n).map((r) => r[0]);
    const cut = (n: number) => ({
      "yahoo:^GSPC.close": CLOSE.filter((p) => first(n).includes(p.date)),
      "yahoo:^GSPC.volume": VOLUME.filter((p) => first(n).includes(p.date)),
    });
    expect(deriveSeries(decl, cut(20))).toEqual([]);
    expect(deriveSeries(decl, cut(21)).length).toBe(1);
  });

  test("a tie in the close is not an up day", () => {
    const tieIsUp = (rows: readonly Row[], j: number) => rows[j]![1] >= rows[j - 1]![1];
    for (const [k, i] of [20, 21, 22].entries()) {
      expect(share(ROWS, i, tieIsUp)).not.toBe(share(ROWS, i));
      expect(out[k]!.value).toBe(share(ROWS, i));
    }
  });

  test("a row is compared with the previous row, not the previous calendar day", () => {
    // 2024-01-08, 01-22 and 01-29 are Mondays that close above the Friday before.
    const previousDay = (rows: readonly Row[], j: number) => rows[j - 1]![0] === addDays(rows[j]![0], -1) && rows[j]![1] > rows[j - 1]![1];
    for (const [k, i] of [20, 21, 22].entries()) {
      expect(share(ROWS, i, previousDay)).toBeLessThan(share(ROWS, i));
      expect(out[k]!.value).toBe(share(ROWS, i));
    }
  });

  test("a date with no close and a row with volume 0 are skipped", () => {
    // With the volume 0 row kept there are 24 rows, so a value one row earlier,
    // and 2024-01-18 is compared with it and is not an up day.
    const kept = [...ROWS, ZERO_VOLUME].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(kept.length).toBe(24);
    expect(out.length).toBe(ROWS.length - 20);
    expect(out.some((p) => p.date === addDays(kept[20]![0], 1))).toBe(false);
    for (const [k, i] of [20, 21, 22].entries()) {
      expect(kept[i + 1]![0]).toBe(ROWS[i]![0]);
      expect(share(kept, i + 1)).not.toBe(share(ROWS, i));
      expect(out[k]!.value).toBe(share(ROWS, i));
    }
    // The same series without the two excluded dates in the inputs.
    const clean = {
      "yahoo:^GSPC.close": points(ROWS.map(([d, c]) => [d, c] as const)),
      "yahoo:^GSPC.volume": points(ROWS.map(([d, , vol]) => [d, vol] as const)),
    };
    expect(deriveSeries(decl, clean)).toEqual(out);
    // A close on the no-close date changes the series, so its absence is what excludes it.
    const withClose = { ...inputs, "yahoo:^GSPC.close": [...CLOSE, { date: NO_CLOSE.date, value: 4783.45 }] };
    expect(deriveSeries(decl, withClose).length).toBe(4);
  });
});

describe("a malformed declaration or a missing input is refused", () => {
  const some = points([["2024-01-02", 1], ["2024-01-03", 2]]);

  test("a missing input throws DerivedSeriesError naming it and the derived series", () => {
    const cases: [DerivedSeries, string][] = [
      [{ op: "level", id: "SKEW", input: "yahoo:^SKEW.close" }, "yahoo:^SKEW.close"],
      [{ op: "ratio", id: "VIX_TERM", numerator: "a", denominator: "yahoo:^VIX.close" }, "yahoo:^VIX.close"],
      [{ op: "up-volume-share", id: "UPVOL_SHARE", close: "a", volume: "yahoo:^GSPC.volume", window: 20 }, "yahoo:^GSPC.volume"],
      [
        { op: "rolling-sum-over-known-level", id: "FISCAL", flow: "a", level: "fred:GDP", periods: 12, summation: "plain", negate: true, divisor: 1000, multiplier: 100, levelPublication: { kind: "calendar-days", days: 120 } },
        "fred:GDP",
      ],
    ];
    for (const [decl, missing] of cases) {
      let caught: unknown;
      try { deriveSeries(decl, { a: some }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(DerivedSeriesError);
      const err = caught as DerivedSeriesError;
      expect(err.name).toBe("DerivedSeriesError");
      expect(err.inputId).toBe(missing);
      expect(err.seriesId).toBe(decl.id);
      expect(err.message).toContain(missing);
      expect(err.message).toContain(decl.id);
    }
  });

  test("an unknown op, a bad count or a bad summation throws RangeError naming the field", () => {
    const fiscal = { op: "rolling-sum-over-known-level", id: "FISCAL", flow: "a", level: "a", periods: 12, summation: "plain", negate: true, divisor: 1000, multiplier: 100, levelPublication: { kind: "same-day" } } as const;
    expect(() => deriveSeries({ op: "median", id: "X" } as unknown as DerivedSeries, { a: some })).toThrow(RangeError);
    expect(() => deriveSeries({ op: "median", id: "X" } as unknown as DerivedSeries, { a: some })).toThrow(/unknown op "median"/);
    expect(() => deriveSeries({ ...fiscal, periods: 0 }, { a: some })).toThrow(/periods/);
    expect(() => deriveSeries({ ...fiscal, periods: 1.5 }, { a: some })).toThrow(RangeError);
    expect(() => deriveSeries({ ...fiscal, summation: "kahan" } as unknown as DerivedSeries, { a: some })).toThrow(/summation/);
    expect(() => deriveSeries({ op: "up-volume-share", id: "U", close: "a", volume: "a", window: 0 }, { a: some })).toThrow(/window/);
    expect(() => deriveSeries({ op: "up-volume-share", id: "U", close: "a", volume: "a", window: 2.5 }, { a: some })).toThrow(RangeError);
  });

  test("a malformed publication rule throws PublicationRuleError naming the derived series", () => {
    expect(() => deriveSeries({ op: "level", id: "SKEW", input: "a", publication: { kind: "calendar-days", days: 0 } }, { a: some })).toThrow(PublicationRuleError);
    expect(() => deriveSeries({ op: "level", id: "SKEW", input: "a", publication: { kind: "calendar-days", days: 0 } }, { a: some })).toThrow(/series SKEW/);
  });
});

describe("the custom op: a pure function with a declared publication lag (issue 1765)", () => {
  // Gaps on purpose: 01-04, 01-06 to 01-09 have no point.
  const A = points([["2024-01-02", 1], ["2024-01-03", 2], ["2024-01-05", 3], ["2024-01-10", 4]]);
  const B = points([["2024-01-03", 10], ["2024-01-08", 20]]);
  type Call = { day: string; a: string[]; b: string[] };
  const op = (lagDays: number, calls: Call[] = [], fn?: DerivedCustom["fn"]): DerivedCustom => ({
    op: "custom",
    id: "A_PLUS_B",
    version: "1",
    inputs: ["a", "b"],
    lagDays,
    fn: fn ?? ((inputs, day) => {
      calls.push({ day, a: inputs.a!.map((p) => p.date), b: inputs.b!.map((p) => p.date) });
      const a = inputs.a!.at(-1);
      const b = inputs.b!.at(-1);
      return a && b ? a.value + b.value : null;
    }),
  });

  test("fn runs on every calendar day from the first known day to the newest input date plus the lag, seeing only points dated on or before the day minus the lag", () => {
    const calls: Call[] = [];
    const out = deriveSeries(op(2, calls), { a: A, b: B });
    // The first point (01-02) is known on 01-04; the newest (01-10) on 01-12.
    expect(calls.map((c) => c.day)).toEqual(["04", "05", "06", "07", "08", "09", "10", "11", "12"].map((d) => `2024-01-${d}`));
    for (const c of calls) {
      const cutoff = addDays(c.day, -2);
      expect(c.a).toEqual(A.filter((p) => p.date <= cutoff).map((p) => p.date));
      expect(c.b).toEqual(B.filter((p) => p.date <= cutoff).map((p) => p.date));
    }
    // Each value is dated on its own day; a null (no B known on 01-04) gives no point.
    expect(out).toEqual([
      { date: "2024-01-05", value: 12 }, { date: "2024-01-06", value: 12 }, { date: "2024-01-07", value: 13 }, { date: "2024-01-08", value: 13 },
      { date: "2024-01-09", value: 13 }, { date: "2024-01-10", value: 23 }, { date: "2024-01-11", value: 23 }, { date: "2024-01-12", value: 24 },
    ]);
  });

  test("negative control: with lag 0 fn sees the day's own point", () => {
    const calls: Call[] = [];
    deriveSeries(op(0, calls), { a: A, b: B });
    expect(calls[0]!.day).toBe("2024-01-02");
    for (const p of A) expect(calls.find((c) => c.day === p.date)!.a.at(-1)).toBe(p.date);
  });

  test("through sets the last day; the inputs may come in any date order and are not changed", () => {
    const calls: Call[] = [];
    const shuffled = [A[3]!, A[0]!, A[2]!, A[1]!];
    const before = JSON.stringify(shuffled);
    const out = deriveSeries(op(2, calls), { a: shuffled, b: B }, { through: "2024-01-20" });
    expect(calls.at(-1)!.day).toBe("2024-01-20");
    expect(out.at(-1)).toEqual({ date: "2024-01-20", value: 24 });
    expect(out.slice(0, 8)).toEqual(deriveSeries(op(2), { a: A, b: B }));
    expect(JSON.stringify(shuffled)).toBe(before);
    expect(deriveSeries(op(2), { a: A, b: B }, { through: "2024-01-03" })).toEqual([]);
    expect(deriveSeries(op(2), { a: [], b: [] })).toEqual([]);
  });

  test("fn cannot change what it is given: the arrays and the points are frozen", () => {
    const push = op(0, [], (inputs) => (inputs.a!.push({ date: "2099-01-01", value: 1 }), 1));
    expect(() => deriveSeries(push, { a: A, b: B })).toThrow(TypeError);
    const write = op(0, [], (inputs) => (inputs.a!.length > 0 ? ((inputs.a![0]!.value = 99), 1) : null));
    expect(() => deriveSeries(write, { a: A, b: B })).toThrow(TypeError);
    expect(A[0]!.value).toBe(1);
  });

  test("fn cannot see a point past the known day by any route: index, keys, `in`, descriptors, spread, slice or JSON; a view kept from an earlier day never grows", () => {
    // A is known through 01-05 on 01-05 (lag 0): three points, 01-10 is the fourth.
    const seen: Record<string, unknown> = {};
    let kept: readonly Point[] | null = null;
    deriveSeries(op(0, [], (inputs, day) => {
      const a = inputs.a!;
      if (day === "2024-01-05") {
        kept = a;
        Object.assign(seen, {
          length: a.length,
          past: [a[3], a[a.length], a.at(3), (a as unknown as Record<string, unknown>)["3"]],
          has: [3 in a, "3" in a, Object.hasOwn(a, 3), Object.getOwnPropertyDescriptor(a, 3)],
          keys: Object.keys(a),
          spread: [...a].map((p) => p.date),
          slice: a.slice(0, 10).map((p) => p.date),
          json: JSON.parse(JSON.stringify(a)).map((p: Point) => p.date),
          isArray: Array.isArray(a),
          entries: Object.entries(a).length,
        });
      }
      return a.length;
    }), { a: A, b: B }, { through: "2024-01-20" });
    expect(seen).toEqual({
      length: 3,
      past: [undefined, undefined, undefined, undefined],
      has: [false, false, false, undefined],
      keys: ["0", "1", "2"],
      spread: ["2024-01-02", "2024-01-03", "2024-01-05"],
      slice: ["2024-01-02", "2024-01-03", "2024-01-05"],
      json: ["2024-01-02", "2024-01-03", "2024-01-05"],
      isArray: true,
      entries: 3,
    });
    // The view fn kept on 01-05 still holds three points after the last day (01-20) ran.
    expect(kept!.length).toBe(3);
    expect(kept![3]).toBeUndefined();
    // Every write is a TypeError: an index, the length, a new property, a delete, a sort.
    const writes: ((a: Point[]) => unknown)[] = [
      (a) => { a[0] = { date: "2099-01-01", value: 1 }; },
      (a) => { a[a.length] = { date: "2099-01-01", value: 1 }; },
      (a) => { a.length = 0; },
      (a) => Object.defineProperty(a, "x", { value: 1 }),
      (a) => delete a[0],
      (a) => a.sort((x, y) => (x.date < y.date ? 1 : -1)),
      (a) => a.pop(),
      (a) => Object.setPrototypeOf(a, null),
    ];
    for (const write of writes) {
      expect(() => deriveSeries(op(0, [], (inputs) => (write(inputs.a!), 1)), { a: A, b: B })).toThrow(TypeError);
    }
    expect(A.map((p) => p.date)).toEqual(["2024-01-02", "2024-01-03", "2024-01-05", "2024-01-10"]);
  });

  test("the inputs are not copied per day: a 10,000-point daily input runs in well under 2 s", () => {
    const start = Date.parse("1990-01-01T00:00:00Z");
    const daily = Array.from({ length: 10_000 }, (_, i) => ({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), value: i }));
    const last: DerivedCustom = {
      op: "custom",
      id: "LAST",
      version: "1",
      inputs: ["a"],
      lagDays: 1,
      fn: (inputs) => (inputs.a!.length > 0 ? inputs.a![inputs.a!.length - 1]!.value + inputs.a!.length : null),
    };
    const t0 = performance.now();
    const out = deriveSeries(last, { a: daily });
    const ms = performance.now() - t0;
    // One point a day from the first known day (the first date plus the lag), each the newest known value plus the count.
    expect(out.length).toBe(10_000);
    expect(out[0]).toEqual({ date: "1990-01-02", value: 1 });
    expect(out.at(-1)).toEqual({ date: addDays(daily.at(-1)!.date, 1), value: 9_999 + 10_000 });
    expect(ms).toBeLessThan(2_000);
  }, 60_000);

  test("a null or a non-finite value gives no point; any other non-number is a RangeError", () => {
    expect(deriveSeries(op(0, [], () => null), { a: A, b: B })).toEqual([]);
    expect(deriveSeries(op(0, [], () => NaN), { a: A, b: B })).toEqual([]);
    expect(deriveSeries(op(0, [], (_i, day) => (day === "2024-01-03" ? Infinity : 1)), { a: A, b: B }).map((p) => p.date)).not.toContain("2024-01-03");
    expect(() => deriveSeries(op(0, [], () => "1" as unknown as number), { a: A, b: B })).toThrow(/fn must return a number or null/);
  });

  test("derivedInputIds lists its inputs; a missing input is a DerivedSeriesError; a malformed declaration is a RangeError naming the field", () => {
    expect(derivedInputIds(op(1))).toEqual(["a", "b"]);
    let caught: unknown;
    try { deriveSeries(op(1), { a: A }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DerivedSeriesError);
    expect((caught as DerivedSeriesError).inputId).toBe("b");
    expect((caught as DerivedSeriesError).seriesId).toBe("A_PLUS_B");
    const bad = (patch: Record<string, unknown>) => ({ ...op(1), ...patch }) as unknown as DerivedSeries;
    expect(() => deriveSeries(bad({ version: "" }), { a: A, b: B })).toThrow(/version/);
    expect(() => deriveSeries(bad({ version: 1 }), { a: A, b: B })).toThrow(/version/);
    expect(() => deriveSeries(bad({ lagDays: -1 }), { a: A, b: B })).toThrow(/lagDays/);
    expect(() => deriveSeries(bad({ lagDays: 1.5 }), { a: A, b: B })).toThrow(/lagDays/);
    expect(() => deriveSeries(bad({ inputs: [] }), { a: A, b: B })).toThrow(/inputs/);
    expect(() => deriveSeries(bad({ inputs: ["a", "a"] }), { a: A, b: B })).toThrow(/twice/);
    expect(() => deriveSeries(bad({ fn: 1 }), { a: A, b: B })).toThrow(/fn must be a function/);
    expect(() => derivedInputIds(bad({ inputs: "a" }))).toThrow(/inputs/);
    expect(() => deriveSeries(op(1), { a: A, b: B }, { through: "Jan 20" })).toThrow(/through/);
  });

  test("the four other ops ignore deriveSeries' options: the v5 series keep their exact output", () => {
    const inputs: Record<string, Point[]> = {};
    for (const d of V5_DERIVED_SERIES) for (const id of derivedInputIds(d)) inputs[id] = points([["2024-01-02", 2], ["2024-02-01", 3], ["2024-03-01", 5]]);
    for (const d of V5_DERIVED_SERIES) expect(deriveSeries(d, inputs, { through: "2000-01-01" })).toEqual(deriveSeries(d, inputs));
  });
});

// Issue 1653: the collected-series registry. BAA10Y is fetched, stored and
// served, never scored; collectionRegistry() is INDICATORS then
// COLLECTED_SERIES, and an id in both throws.
import { describe, expect, test } from "bun:test";
import {
  INDICATORS, PANELS, SERIES_MAPPING, V5_DERIVED_SERIES, V5_INPUT_IDS, V5_SERIES_MAPPING, V5_STORED_UNDER, V5_ONLY_STORAGE_KEYS, consumerStorageKeys, derivedInputIds,
  inputHistoryFromStorage, parseRawHistory, requireComplete, resolveInputHistory, runRegime, seriesMappingFor, storedUnderFor, toHistory, buildReport, STORED_UNDER,
} from "../src/index.ts";
import { COLLECTED_SERIES, collectedSourceId, collectionRegistry } from "../src/extract/collected-series.ts";
import { sourceCalendar } from "../src/extract/floor-seed-calendar.ts";
import { createFetchMemo, fetchOne } from "../src/extract/sources.ts";
import { join } from "node:path";

describe("COLLECTED_SERIES and collectionRegistry() (issue 1653)", () => {
  test("COLLECTED_SERIES holds the BAA10Y entry: fred, series BAA10Y, unit percent, a FRED source_url", () => {
    expect(COLLECTED_SERIES[0]!.id).toBe("BAA10Y");
    const baa = COLLECTED_SERIES[0]!;
    expect(baa).toMatchObject({
      id: "BAA10Y",
      name: "Baa corporate credit spread",
      source: "fred",
      series: "BAA10Y",
      unit: "percent",
      source_url: "https://fred.stlouisfed.org/series/BAA10Y",
    });
    expect(baa.description).toMatch(/Moody's seasoned Baa/);
    expect(baa.description).toMatch(/10-year Treasury/);
    expect(baa.description).toMatch(/daily by FRED/);
  });

  test("an entry carries no scoring field", () => {
    for (const s of COLLECTED_SERIES) {
      for (const field of ["panel", "sign", "transform", "fill", "fillReason", "weight"]) expect(field in s).toBe(false);
    }
  });

  test("collectionRegistry() returns INDICATORS then COLLECTED_SERIES, in order", () => {
    expect(collectionRegistry().map((s) => s.id)).toEqual([...INDICATORS.map((i) => i.id), ...COLLECTED_SERIES.map((s) => s.id)]);
    expect(collectionRegistry().slice(0, INDICATORS.length)).toEqual(INDICATORS);
  });

  test("an id declared in both lists, or twice, throws", () => {
    const dup = { id: "T10Y2Y", name: "dup", source: "fred", series: "T10Y2Y", unit: "percent" };
    expect(() => collectionRegistry(INDICATORS, [dup])).toThrow(/T10Y2Y is declared twice/);
    expect(() => collectionRegistry([], [dup, dup])).toThrow(/declared twice/);
    expect(() => collectionRegistry(INDICATORS, COLLECTED_SERIES)).not.toThrow();
  });

  test("the scoring registry is unchanged: no BAA10Y in INDICATORS, PANELS stays macro, onchain and factor", () => {
    expect(INDICATORS.some((i) => i.id === "BAA10Y")).toBe(false);
    expect(PANELS).toEqual(["macro", "onchain", "factor"]);
  });

  test("the scoring registry is unchanged by any collected series: 26 indicators, none of them collected", () => {
    expect(INDICATORS.length).toBe(26);
    const collected = new Set(COLLECTED_SERIES.map((s) => s.id));
    expect(INDICATORS.filter((i) => collected.has(i.id))).toEqual([]);
  });

  test("sourceCalendar reads the combined list: BAA10Y is business_day", () => {
    expect(sourceCalendar("BAA10Y")).toBe("business_day");
    expect(sourceCalendar("ICSA")).toBe("weekly_saturday");
    expect(sourceCalendar("NOT_COLLECTED")).toBe("any");
  });
});

// Issue 1753: the five raw series of methodology v5's derived indicators are
// collected series. Every regime run fetches and stores them; nothing on the
// main line scores or reads them.
describe("the five collected series of methodology v5 (issue 1753)", () => {
  const FIVE = ["FED_SURPLUS_MONTHLY", "US_GDP", "CBOE_VIX3M", "CBOE_SKEW", "SPX_VOLUME"];
  const byId = Object.fromEntries(COLLECTED_SERIES.map((s) => [s.id, s]));

  test("they are declared after BAA10Y, with their source ids", () => {
    expect(COLLECTED_SERIES.map((s) => s.id)).toEqual(["BAA10Y", ...FIVE]);
    expect(FIVE.map((id) => collectedSourceId(byId[id]!))).toEqual(["fred:MTSDS133FMS", "fred:GDP", "yahoo:^VIX3M", "yahoo:^SKEW", "yahoo:^GSPC.volume"]);
    expect(collectedSourceId(byId["BAA10Y"]!)).toBe("fred:BAA10Y");
    for (const id of FIVE) {
      const s = byId[id]!;
      expect(s.source_url).toMatch(/^https:\/\//);
      expect(s.description.length).toBeGreaterThan(20);
      for (const field of ["panel", "sign", "transform", "fill", "fillReason", "weight"]) expect(field in s).toBe(false);
    }
  });

  test("SPX_VOLUME reads the volume field; no other collected series declares a field", () => {
    expect(byId["SPX_VOLUME"]).toMatchObject({ source: "yahoo", series: "^GSPC", field: "volume" });
    for (const s of COLLECTED_SERIES) if (s.id !== "SPX_VOLUME") expect("field" in s).toBe(false);
  });

  test("SPX_VOLUME is parsed from the one ^GSPC chart response the run already requests", async () => {
    const chart = { chart: { result: [{ timestamp: [1704205800, 1704292200, 1704378600], indicators: { quote: [{ close: [4742.83, 4704.81, 4688.68], volume: [3743050000, null, 3715480000] }], adjclose: [{ adjclose: [4742.83, 4704.81, 4688.68] }] } }] } };
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(chart), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const memo = createFetchMemo({ "^GSPC": 0 });
      const close = await memo.yahoo("^GSPC", 0);
      const volume = await fetchOne(byId["SPX_VOLUME"]!, console, {}, memo);
      expect(urls.length).toBe(1);
      expect(close.map((p) => p.value)).toEqual([4742.83, 4704.81, 4688.68]);
      // A day with no volume is dropped; the others are the quote's volume, never a close.
      expect(volume).toEqual([{ date: "2024-01-02", value: 3743050000 }, { date: "2024-01-04", value: 3715480000 }]);
      // A FRED series is requested once per memo, however many runs of a tick read it.
      urls.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response("observation_date,GDP\n2024-01-01,28000.5\n2024-04-01,28500.25\n", { headers: { "content-type": "text/csv" } });
      }) as typeof fetch;
      const a = await fetchOne(byId["US_GDP"]!, console, {}, memo);
      const b = await fetchOne(byId["US_GDP"]!, console, {}, memo);
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain("id=GDP");
      expect(a).toEqual([{ date: "2024-01-01", value: 28000.5 }, { date: "2024-04-01", value: 28500.25 }]);
      expect(b).toEqual(a);
      expect(b).not.toBe(a);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("their ids are the raw inputs the v5 derived series read", () => {
    const read = new Set(V5_DERIVED_SERIES.flatMap(derivedInputIds));
    for (const id of FIVE) expect(read.has(id), id).toBe(true);
    expect([...read].filter((id) => !FIVE.includes(id)).sort()).toEqual(["SPX", "VIX_TERM_DENOMINATOR"]);
    expect<string[]>([V5_INPUT_IDS.deficit, V5_INPUT_IDS.gdp, V5_INPUT_IDS.vix3m, V5_INPUT_IDS.skew, V5_INPUT_IDS.volume]).toEqual(FIVE);
  });

  test("no main-line scoring reader includes them: INDICATORS, the main-line mapping and its storage keys", () => {
    for (const id of FIVE) {
      expect(INDICATORS.some((i) => i.id === id)).toBe(false);
      expect(SERIES_MAPPING.some((m) => m.inputId === id || m.storageKey === `raw_indicator_history:${id}`)).toBe(false);
    }
    expect(seriesMappingFor("v3")).toBe(SERIES_MAPPING);
    expect(seriesMappingFor("v4")).toBe(SERIES_MAPPING);
    expect(storedUnderFor("v4")).toBe(STORED_UNDER);
    const mainKeys = new Set(Object.values(consumerStorageKeys()).flat());
    for (const id of FIVE) expect(mainKeys.has(`raw_indicator_history:${id}`)).toBe(false);
  });

  test("the v5 mapping is the main-line mapping plus the five keys, the VIX stream under the denominator's id, and the backtest's ^GSPC closes", () => {
    expect(seriesMappingFor("v5")).toBe(V5_SERIES_MAPPING);
    expect(V5_SERIES_MAPPING.slice(0, SERIES_MAPPING.length)).toEqual([...SERIES_MAPPING]);
    const added = V5_SERIES_MAPPING.slice(SERIES_MAPPING.length);
    expect(added.map((m) => [m.consumer, m.storageKey, m.series, m.inputId])).toEqual([
      ["indicator:FISCAL", "raw_indicator_history:FED_SURPLUS_MONTHLY", "fred:MTSDS133FMS", "FED_SURPLUS_MONTHLY"],
      ["indicator:FISCAL", "raw_indicator_history:US_GDP", "fred:GDP", "US_GDP"],
      ["indicator:VIX_TERM", "raw_indicator_history:CBOE_VIX3M", "yahoo:^VIX3M", "CBOE_VIX3M"],
      ["indicator:VIX_TERM", "raw_indicator_history:VIX", "yahoo:^VIX", "VIX_TERM_DENOMINATOR"],
      ["indicator:SKEW", "raw_indicator_history:CBOE_SKEW", "yahoo:^SKEW", "CBOE_SKEW"],
      ["indicator:UPVOL_SHARE", "raw_indicator_history:SPX_VOLUME", "yahoo:^GSPC.volume", "SPX_VOLUME"],
      ["indicator:UPVOL_SHARE", "backtest:^GSPC", "yahoo:^GSPC", "SPX"],
    ]);
    expect([...V5_ONLY_STORAGE_KEYS].sort()).toEqual(FIVE.map((id) => `raw_indicator_history:${id}`).sort());
    // Each added source id is the collected entry's.
    for (const id of FIVE) expect(added.find((m) => m.inputId === id)!.series).toBe(collectedSourceId(byId[id]!));
    // One stored yahoo:^VIX stream (D74) feeds the VIX indicator and the denominator.
    const fromStorage = inputHistoryFromStorage([{ sourceKey: "raw_indicator_history:VIX", marketDate: "2026-01-02", value: 15.5 }], V5_SERIES_MAPPING);
    expect(fromStorage).toEqual({ VIX: [{ date: "2026-01-02", value: 15.5 }], VIX_TERM_DENOMINATOR: [{ date: "2026-01-02", value: 15.5 }] });
    expect(inputHistoryFromStorage([{ sourceKey: "raw_indicator_history:VIX", marketDate: "2026-01-02", value: 15.5 }])).toEqual({ VIX: [{ date: "2026-01-02", value: 15.5 }] });
    // An input names a v5 raw series by its id, its storage key or its source id.
    const pts = [{ date: "2026-01-02", value: 1 }];
    for (const name of ["CBOE_SKEW", "raw_indicator_history:CBOE_SKEW", "yahoo:^SKEW"]) {
      expect(resolveInputHistory({ [name]: pts }, V5_SERIES_MAPPING, storedUnderFor("v5"))["CBOE_SKEW"]).toBe(pts);
    }
    // The main-line resolution leaves the same names alone.
    expect(resolveInputHistory({ "yahoo:^SKEW": pts })).toEqual({ "yahoo:^SKEW": pts });
  });

  // Issue 1765: the storage a version reads is a fact of its preset (model/preset-series.ts), read from a table.
  test("the v5 preset resolves its input with V5_STORED_UNDER; a label that names no preset reads the main-line storage", () => {
    expect(storedUnderFor("v5")).toBe(V5_STORED_UNDER);
    expect(storedUnderFor("v3")).toBe(STORED_UNDER);
    // The archive's synthetic fixtures label their runs regime-v3; an own-property lookup never reads the prototype.
    for (const label of ["regime-v3", "v6", "V5", "", "toString", "__proto__", "constructor"]) {
      expect(seriesMappingFor(label), label).toBe(SERIES_MAPPING);
      expect(storedUnderFor(label), label).toBe(STORED_UNDER);
    }
  });

  test("a v4 run gives identical output with and without the five series in its input", async () => {
    const raw = toHistory(parseRawHistory(await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.json")).text()));
    const dates = raw["T10Y2Y"]!.map((p) => p.date);
    const extra = Object.fromEntries(FIVE.map((id, k) => [id, dates.map((date, i) => ({ date, value: 100 + k + (i % 7) }))]));
    const plain = buildReport(requireComplete(runRegime(raw)));
    expect(JSON.stringify(buildReport(requireComplete(runRegime({ ...raw, ...extra }))))).toBe(JSON.stringify(plain));
  });

  test("sourceCalendar: the monthly and quarterly FRED series are dated by period start (any weekday); the Yahoo ones are business days", () => {
    expect(sourceCalendar("FED_SURPLUS_MONTHLY")).toBe("any");
    expect(sourceCalendar("US_GDP")).toBe("any");
    expect(sourceCalendar("CBOE_VIX3M")).toBe("business_day");
    expect(sourceCalendar("CBOE_SKEW")).toBe("business_day");
    expect(sourceCalendar("SPX_VOLUME")).toBe("business_day");
  });
});

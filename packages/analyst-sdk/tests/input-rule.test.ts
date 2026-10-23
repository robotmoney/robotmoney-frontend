// Two-layer input rule: loader STRICT (throws on non-finite), mergeSeries
// TOLERANT (drops). For inputs both accept, the aligned series are identical.
import { test, expect } from "bun:test";
import { parseRawJson, parseRawCsv, parseRawHistory, toHistory, InputRowError } from "../src/input/load.ts";
import { mergeSeries, alignDailyForwardFill, forwardFillAge, buildDateAxis } from "../src/transform/math.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, runRegime } from "../src/run.ts";
import {
  AmbiguousInputSeriesError,
  AmbiguousSeriesMappingError,
  SERIES_MAPPING,
  consumerStorageKeys,
  resolveInputHistory,
  validateSeriesMapping,
  type SeriesMapping,
} from "../src/series-ids.ts";
import type { RawIndicatorHistory } from "../src/types.ts";

const rows = [
  { date: "2024-01-05", indicator: "A", value: 5, source: "s" },
  { date: "2024-01-02", indicator: "A", value: 2, source: "s" },
  { date: "2024-01-05", indicator: "A", value: 55, source: "s" }, // dup, last wins
  { date: "2024-01-03", indicator: "A", value: 3, source: "s" },
  { date: "2024-01-02", indicator: "A", value: 22, source: "s" }, // dup, last wins
];
const expected = [
  { date: "2024-01-02", value: 22 },
  { date: "2024-01-03", value: 3 },
  { date: "2024-01-05", value: 55 },
];

test("loader and mergeSeries agree: duplicates, out of order, last wins, ascending", () => {
  const pts = rows.map(({ date, value }) => ({ date, value }));
  expect(toHistory(rows).A).toEqual(expected);
  expect(mergeSeries([], pts)).toEqual(expected);
  expect(mergeSeries(pts, [])).toEqual(expected);
  // prior then fetched == one concatenated stream, last wins
  expect(mergeSeries(pts.slice(0, 2), pts.slice(2))).toEqual(expected);
});

test("non-finite row: loader throws, mergeSeries drops, survivors equal", () => {
  const bad = JSON.stringify([...rows, { date: "2024-01-04", indicator: "A", value: "NaN", source: "s" }]);
  expect(() => parseRawJson(bad)).toThrow(InputRowError);
  const csv = "date,indicator,value,source\n2024-01-04,A,Infinity,s\n";
  expect(() => parseRawCsv(csv)).toThrow(InputRowError);
  const pts = [...rows.map(({ date, value }) => ({ date, value })), { date: "2024-01-04", value: NaN }, { date: "2024-01-06", value: Infinity }];
  expect(mergeSeries([], pts)).toEqual(toHistory(rows).A!);
  // a dropped fetched hole leaves the persisted value for that date
  expect(mergeSeries([{ date: "2024-01-03", value: 3 }], [{ date: "2024-01-03", value: NaN }])).toEqual([{ date: "2024-01-03", value: 3 }]);
});

test("alignment and age are order-independent on deduped input", () => {
  const axis = buildDateAxis("2024-01-01", "2024-01-08");
  const sorted = toHistory(rows).A!;
  const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];
  const a = alignDailyForwardFill(sorted, axis), b = alignDailyForwardFill(shuffled, axis);
  expect(b).toEqual(a);
  expect(forwardFillAge(shuffled, axis)).toEqual(forwardFillAge(sorted, axis));
});

test("alignDailyForwardFill is order-dependent only on duplicate dates (why dedupe precedes it)", () => {
  const axis = buildDateAxis("2024-01-01", "2024-01-03");
  const x = alignDailyForwardFill([{ date: "2024-01-02", value: 1 }, { date: "2024-01-02", value: 2 }], axis);
  const y = alignDailyForwardFill([{ date: "2024-01-02", value: 2 }, { date: "2024-01-02", value: 1 }], axis);
  expect(x).not.toEqual(y);
});

// ── Source ids and the per-consumer storage mapping (D74, issue 1423) ─────────
// The committed fixture and golden are the pre-change bytes. Every accepted
// spelling of a stream (its input id, its storage key, or its source id where
// one stream holds that id) resolves to the same observations and the same
// report bytes. The preload makes globalThis.fetch a thrower; asserted below.
const FIX = join(import.meta.dir, "fixtures");
const fixtureCsv = readFileSync(join(FIX, "raw-indicator-history.csv"), "utf8");
const fixtureHistory: RawIndicatorHistory = toHistory(parseRawHistory(fixtureCsv));
const goldenText = readFileSync(join(import.meta.dir, "golden", "regime-report.json"), "utf8");
const report = (h: RawIndicatorHistory) => JSON.stringify(buildReport(runRegime(h)), null, 2) + "\n";

function renamed(h: RawIndicatorHistory, from: string, to: string): RawIndicatorHistory {
  const out: RawIndicatorHistory = {};
  for (const k of Object.keys(h)) out[k === from ? to : k] = h[k]!;
  return out;
}

// Every accepted equivalent name pair for the fixture: (input id, storage key)
// for each stream, and (input id, source id) where only one stream maps to that
// source id. A source id that two streams share (yahoo:^GSPC is SPX_TREND's and
// the backtest's) names neither alone: that is the ambiguity test further down.
function equivalentPairs(): Array<[from: string, to: string]> {
  const pairs = new Map<string, string>();
  const streamsOf = new Map<string, Set<string>>();
  for (const m of SERIES_MAPPING) (streamsOf.get(m.series) ?? streamsOf.set(m.series, new Set()).get(m.series)!).add(m.storageKey);
  for (const m of SERIES_MAPPING) {
    pairs.set(`${m.inputId}\u0001${m.storageKey}`, m.inputId);
    if (m.kind === "source" && streamsOf.get(m.series)!.size === 1) pairs.set(`${m.inputId}\u0001${m.series}`, m.inputId);
  }
  return [...pairs.keys()].map((k) => k.split("\u0001") as [string, string]);
}

test("globalThis.fetch throws for every equivalence check below", () => {
  expect(() => fetch("https://query1.finance.yahoo.com/")).toThrow(/must not use the network/);
});

test("every accepted equivalent name pair resolves to the same observations and the pinned golden report bytes", () => {
  const legacy = resolveInputHistory(fixtureHistory);
  expect(report(fixtureHistory)).toBe(goldenText);
  const pairs = equivalentPairs();
  // Non-vacuity: 29 streams by storage key, plus the single-stream source ids.
  expect(pairs.length).toBeGreaterThanOrEqual(29 + 13);
  for (const [from, to] of pairs) {
    expect(fixtureHistory[from], `fixture carries ${from}`).toBeDefined();
    const resolved = resolveInputHistory(renamed(fixtureHistory, from, to));
    expect(resolved, `${from} -> ${to}`).toEqual(legacy);
    expect(resolved[from]).toBe(fixtureHistory[from]!);
    expect(report(renamed(fixtureHistory, from, to)), `${from} -> ${to}`).toBe(goldenText);
  }
}, 600_000);

test("an input naming every stream by its storage key loads through the CSV loader to the golden bytes", () => {
  const keyOf = new Map(SERIES_MAPPING.map((m) => [m.inputId, m.storageKey]));
  const csv = (raw: string) =>
    raw.split("\n").map((line, i) => {
      if (i === 0 || line === "") return line;
      const [date, id, ...rest] = line.split(",");
      return [date, keyOf.get(id!) ?? id, ...rest].join(",");
    }).join("\n");
  const text = csv(fixtureCsv);
  expect(text).toContain(",backtest:^GSPC,");
  expect(text).toContain(",raw_indicator_history:SPX_TREND,");
  expect(report(toHistory(parseRawHistory(text)))).toBe(goldenText);
});

test("one consumer reading two storage keys for one source id is rejected with an error naming both keys", () => {
  const m = (consumer: string, storageKey: string, inputId: string): SeriesMapping => ({ consumer, storageKey, series: "yahoo:^GSPC", kind: "source", inputId });
  const bad = [m("backtest", "backtest:^GSPC", "SPX"), m("backtest", "raw_indicator_history:SPX_TREND", "SPX_TREND")];
  expect(() => validateSeriesMapping(bad)).toThrow(AmbiguousSeriesMappingError);
  expect(() => validateSeriesMapping(bad)).toThrow(/backtest:\^GSPC.*raw_indicator_history:SPX_TREND/);
  // The same source id read by two different consumers through two keys is accepted.
  const ok = [m("backtest", "backtest:^GSPC", "SPX"), m("indicator:SPX_TREND", "raw_indicator_history:SPX_TREND", "SPX_TREND")];
  expect(validateSeriesMapping(ok)).toBe(ok);
  // ...and the shared mapping holds exactly that case.
  expect(SERIES_MAPPING.filter((x) => x.series === "yahoo:^GSPC").map((x) => [x.consumer, x.storageKey])).toEqual([
    ["indicator:SPX_TREND", "raw_indicator_history:SPX_TREND"],
    ["correlations", "backtest:^GSPC"],
    ["backtest", "backtest:^GSPC"],
  ]);
});

test("an input naming one consumer's stream twice is rejected with both names; nothing is picked silently", () => {
  const twice = { ...fixtureHistory, "backtest:^GSPC": fixtureHistory.SPX! };
  expect(() => resolveInputHistory(twice)).toThrow(AmbiguousInputSeriesError);
  expect(() => resolveInputHistory(twice)).toThrow(/SPX.*backtest:\^GSPC/);
  // The shared source id alongside SPX_TREND would feed SPX_TREND twice.
  expect(() => resolveInputHistory(renamed(fixtureHistory, "SPX", "yahoo:^GSPC"))).toThrow(/indicator:SPX_TREND.*SPX_TREND.*yahoo:\^GSPC/);
});

// Pinned BEFORE the change: the storage keys each consumer read on main before
// issue 1423 (data-source.ts writes, LEDGER_EXTRA_KEYS, raw_indicator_history).
const REGISTRY_IDS = [
  "T10Y2Y", "DFII10", "T5YIE", "HY_OAS", "DXY", "ICSA", "VIX", "COPPER_GOLD", "SPX_TREND", "IWM_SPY", "DEFI_TVL", "STABLES", "BTC_ACTIVE",
  "ETH_ACTIVE", "BTC_MVRV", "BTC_ETH", "ETH_TREND", "NEW_TOKENS", "DEFI_GROWTH", "STABLES_GROWTH", "SPHB_SPLV", "MTUM_SPY", "IWF_IWD",
  "XLU_SPY", "XLP_XLY", "SHILLER_CAPE",
];
const PINNED_CONSUMER_KEYS: Record<string, string[]> = {
  ...Object.fromEntries(REGISTRY_IDS.map((id) => [`indicator:${id}`, [`raw_indicator_history:${id}`]])),
  correlations: ["backtest:ETH-USD", "backtest:^GSPC"],
  backtest: ["backtest:DTB3", "backtest:ETH-USD", "backtest:^GSPC"],
};

test("every consumer's resolved storage keys equal the pinned pre-change list", () => {
  expect(consumerStorageKeys()).toEqual(PINNED_CONSUMER_KEYS);
});

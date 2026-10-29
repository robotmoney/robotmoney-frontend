// Two-layer input rule: loader STRICT (throws on non-finite), mergeSeries
// TOLERANT (drops). For inputs both accept, the aligned series are identical.
import { test, expect } from "bun:test";
import { parseRawJson, parseRawCsv, parseRawHistory, toHistory, InputRowError } from "../src/input/load.ts";
import { mergeSeries, alignDailyForwardFill, forwardFillAge, buildDateAxis } from "../src/transform/math.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AmbiguousInputSeriesError,
  AmbiguousSeriesMappingError,
  MissingRatioLegError,
  SERIES_MAPPING,
  STORED_UNDER,
  consumerStorageKeys,
  resolveInputHistory,
  validateSeriesMapping,
  type SeriesMapping,
} from "../src/series-ids.ts";
import type { RawIndicatorHistory } from "../src/types.ts";
import { ratiosFromLegs } from "../src/transform/ratios.ts";

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
    // DEFI_GROWTH and STABLES_GROWTH are named only by their own id; their
    // storage key and source id name DEFI_TVL's and STABLES's stream (D74
    // amendment, issue 1514).
    if (m.inputId in STORED_UNDER) continue;
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
  // Non-vacuity: 27 streams by storage key, plus the single-stream source ids.
  expect(pairs.length).toBeGreaterThanOrEqual(27 + 11);
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
// The D74 amendment of 2026-10-28 (issue 1514) moves exactly two consumers.
const AMENDED: Record<string, string> = { DEFI_GROWTH: "DEFI_TVL", STABLES_GROWTH: "STABLES" };
const PINNED_CONSUMER_KEYS: Record<string, string[]> = {
  ...Object.fromEntries(REGISTRY_IDS.map((id) => [`indicator:${id}`, [`raw_indicator_history:${AMENDED[id] ?? id}`]])),
  correlations: ["backtest:ETH-USD", "backtest:^GSPC"],
  backtest: ["backtest:DTB3", "backtest:ETH-USD", "backtest:^GSPC"],
};

test("every consumer's resolved storage keys equal the pinned pre-change list", () => {
  expect(consumerStorageKeys()).toEqual(PINNED_CONSUMER_KEYS);
});

// ── Source and replay contracts (issue 1404; analytics requirements 4.2, 4.3) ──
import { describe } from "bun:test";
import {
  CALCULATED_SERIES,
  CalculatedRowError,
  CsvHeaderError,
  ReplayContractError,
  parseInput,
  parseReplayCsv,
  parseReplayJson,
  parseSourceCsv,
  parseSourceJson,
} from "../src/input/load.ts";
import { buildReport, runRegime } from "../src/run.ts";

describe("strict rows, every contract", () => {
  const SRC = "date,series,value\n";
  const LEG = "date,indicator,value,source\n";
  test("impossible calendar dates reject the file", () => {
    for (const d of ["2026-02-30", "2026-13-01", "2025-02-29", "2026-00-10", "2026-1-01", "20260101", " 2026-01-01"]) {
      expect(() => parseSourceCsv(`${SRC}${d},yahoo:^VIX,1`)).toThrow(InputRowError);
      expect(() => parseRawCsv(`${LEG}${d},VIX,1,s`)).toThrow(InputRowError);
      expect(() => parseSourceJson(JSON.stringify([{ date: d, series: "yahoo:^VIX", value: 1 }]))).toThrow(InputRowError);
    }
    expect(parseSourceCsv(`${SRC}2024-02-29,yahoo:^VIX,1`)[0]!.date).toBe("2024-02-29");
  });

  test("malformed, nonfinite, hex and padded values reject the file", () => {
    for (const v of ["0x10", " 1e1 ", " 1", "1 ", "abc", "", "NaN", "Infinity", "-Infinity", "1e", "1.2.3", "+", "1_000", "0b1", "1e400"]) {
      expect(() => parseSourceCsv(`${SRC}2024-01-01,yahoo:^VIX,${v}`)).toThrow(InputRowError);
      expect(() => parseRawCsv(`${LEG}2024-01-01,VIX,${v},s`)).toThrow(InputRowError);
      expect(() => parseSourceJson(JSON.stringify([{ date: "2024-01-01", series: "yahoo:^VIX", value: v }]))).toThrow(InputRowError);
    }
    const ok = ["1", "-1", "+1", "1.", ".5", "1.5e-3", "-2E+4", "0", "13.2"];
    expect(parseSourceCsv(SRC + ok.map((v, i) => `2024-01-0${i + 1},yahoo:^VIX,${v}`).join("\n")).map((r) => r.value)).toEqual(ok.map(Number));
  });

  test("CSV and JSON of the same rows load the same observations", () => {
    const rows = [{ date: "2024-01-02", series: "yahoo:^VIX", value: 13.2 }, { date: "2024-01-01", series: "yahoo:^GSPC", value: 4700.5 }];
    const csv = SRC + rows.map((r) => `${r.date},${r.series},${r.value}`).join("\n") + "\n";
    expect(parseSourceJson(JSON.stringify(rows))).toEqual(parseSourceCsv(csv));
    expect(parseInput(csv).history).toEqual(parseInput(JSON.stringify(rows)).history);
  });

  test("source rows with extra or missing fields or keys reject", () => {
    expect(() => parseSourceCsv(`${SRC}2024-01-01,yahoo:^VIX,1,extra`)).toThrow(InputRowError);
    expect(() => parseSourceCsv(`${SRC}2024-01-01,yahoo:^VIX`)).toThrow(InputRowError);
    expect(() => parseSourceJson('[{"date":"2024-01-01","series":"yahoo:^VIX","value":1,"source":"x"}]')).toThrow(InputRowError);
    expect(() => parseSourceJson('[{"date":"2024-01-01","value":1}]')).toThrow(InputRowError);
    expect(() => parseSourceCsv("date,series,value,source\n")).toThrow(CsvHeaderError);
    expect(() => parseInput("Date,series,value\n")).toThrow(CsvHeaderError);
  });
});

describe("calculated ratios", () => {
  test("the eight Yahoo ratio indicators are the calculated series", () => {
    expect([...CALCULATED_SERIES].sort()).toEqual(["BTC_ETH", "COPPER_GOLD", "IWF_IWD", "IWM_SPY", "MTUM_SPY", "SPHB_SPLV", "XLP_XLY", "XLU_SPY"]);
  });

  test("source-only parsing rejects a calculated ratio row", () => {
    for (const id of CALCULATED_SERIES) {
      expect(() => parseSourceCsv(`date,series,value\n2024-01-01,${id},1.5`)).toThrow(CalculatedRowError);
      expect(() => parseSourceJson(JSON.stringify([{ date: "2024-01-01", series: id, value: 1.5 }]))).toThrow(CalculatedRowError);
    }
  });

  test("the replay contract accepts stored ratios as kind calculated only, unchanged, with no legs invented", () => {
    const text = "date,series,value,kind\n2024-01-01,COPPER_GOLD,0.00191,calculated\n2024-01-01,VIX,13.2,source\n";
    const rows = parseReplayCsv(text);
    expect(rows).toEqual([
      { date: "2024-01-01", series: "COPPER_GOLD", value: 0.00191, kind: "calculated" },
      { date: "2024-01-01", series: "VIX", value: 13.2, kind: "source" },
    ]);
    expect(parseReplayJson(JSON.stringify(rows))).toEqual(rows);
    const h = parseInput(text, { replay: true }).history;
    expect(Object.keys(h).sort()).toEqual(["COPPER_GOLD", "VIX"]);
    expect(() => parseReplayCsv("date,series,value,kind\n2024-01-01,COPPER_GOLD,1,source")).toThrow(InputRowError);
    expect(() => parseReplayCsv("date,series,value,kind\n2024-01-01,VIX,1,calculated")).toThrow(InputRowError);
    expect(() => parseReplayCsv("date,series,value,kind\n2024-01-01,VIX,1,derived")).toThrow(InputRowError);
  });

  test("a replay file is refused unless the replay contract is asked for", () => {
    const text = "date,series,value,kind\n2024-01-01,VIX,13.2,source\n";
    expect(() => parseInput(text)).toThrow(ReplayContractError);
    expect(() => parseInput(JSON.stringify([{ date: "2024-01-01", series: "VIX", value: 1, kind: "source" }]))).toThrow(ReplayContractError);
    expect(parseInput(text, { replay: true }).format).toBe("replay");
  });

  test("the legacy raw-history adapter still reads its stored ratios", () => {
    const p = parseInput("date,indicator,value,source\n2024-01-01,COPPER_GOLD,0.002,fred\n");
    expect(p.format).toBe("legacy");
    expect(p.history.COPPER_GOLD).toEqual([{ date: "2024-01-01", value: 0.002 }]);
  });
});

describe("date axis, usable series and optional sections", () => {
  const axisRows = (n: number, id: string, start = 0) =>
    Array.from({ length: n }, (_, i) => `${new Date(Date.UTC(2024, 0, 1 + start + i)).toISOString().slice(0, 10)},${id},${10 + (i % 7)}`);
  const csv = (lines: string[]) => "date,series,value\n" + lines.join("\n") + "\n";

  test("an unread future series does not extend the date axis or change the report", () => {
    const base = axisRows(60, "yahoo:^VIX").concat(axisRows(60, "fred:T10Y2Y"));
    const a = buildReport(runRegime(parseInput(csv(base)).history, { start: "2024-01-01" }));
    const b = buildReport(runRegime(parseInput(csv([...base, "2027-06-01,test:FOO,1"])).history, { start: "2024-01-01" }));
    expect(b.asof).toBe(a.asof);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("no usable series, or a start after every usable row, is rejected", () => {
    expect(() => runRegime(parseInput(csv(["2024-01-01,test:FOO,1"])).history)).toThrow(/no series the run reads/);
    expect(() => runRegime(parseInput(csv(axisRows(10, "yahoo:^VIX"))).history, { start: "2025-01-01" })).toThrow(/after every input row/);
    expect(() => runRegime({}, {})).toThrow(RangeError);
  });

  test("without the price series the correlations and backtest sections are null", () => {
    const r = buildReport(runRegime(parseInput(csv(axisRows(40, "yahoo:^VIX"))).history, { start: "2024-01-01" }));
    expect(r.correlations).toBeNull();
    expect(r.backtest).toBeNull();
    // SPX and ETH without TBILL3M: correlations only. yahoo:ETH-USD is also a
    // BTC_ETH leg, so the input carries the other leg too (analytics 4.3: one
    // leg alone is a missing input, MissingRatioLegError).
    const r2 = buildReport(runRegime(parseInput(csv([...axisRows(40, "yahoo:^VIX"), ...axisRows(40, "yahoo:^GSPC"), ...axisRows(40, "yahoo:ETH-USD"), ...axisRows(40, "yahoo:BTC-USD")])).history, { start: "2024-01-01" }));
    expect(r2.correlations).not.toBeNull();
    expect(r2.backtest).toBeNull();
  });
});

// Issue 1514 (D74 amendment): an input without DEFI_GROWTH and STABLES_GROWTH
// feeds them from DEFI_TVL and STABLES, the series they are stored under, to
// the same golden bytes; an input that names them keeps its own rows.
test("an input without the *_GROWTH ids reads them from DEFI_TVL and STABLES, to the golden bytes", () => {
  const without: RawIndicatorHistory = {};
  for (const [k, v] of Object.entries(fixtureHistory)) if (!(k in STORED_UNDER)) without[k] = v;
  const resolved = resolveInputHistory(without);
  expect(resolved.DEFI_GROWTH).toBe(without.DEFI_TVL!);
  expect(resolved.STABLES_GROWTH).toBe(without.STABLES!);
  expect(report(without)).toBe(goldenText);
  const own = [{ date: "2024-01-01", value: 1 }];
  expect(resolveInputHistory({ ...without, DEFI_GROWTH: own }).DEFI_GROWTH).toBe(own);
});

// Analytics requirements 4.3 (SDK-10): one leg of a ratio without the other
// and without a stored ratio is a missing input, named; never a silent drop.
// No leg and no stored ratio keeps the 4.2 rule (the indicator is missing).
test("one ratio leg without the other or a stored ratio throws MissingRatioLegError; ratio rows stay rejected", () => {
  const leg = [{ date: "2024-01-01", value: 4 }];
  const resolve = (h: RawIndicatorHistory) => ratiosFromLegs(h, resolveInputHistory(h));
  let err: unknown;
  try {
    resolve({ "yahoo:HG=F": leg });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MissingRatioLegError);
  expect((err as MissingRatioLegError).ratio).toBe("COPPER_GOLD");
  expect((err as MissingRatioLegError).missingLeg).toBe("yahoo:GC=F");
  expect((err as Error).message).toMatch(/COPPER_GOLD.*yahoo:GC=F/);
  // The denominator alone, named by its storage key, names the numerator.
  expect(() => resolve({ "research:SPY": leg, "yahoo:IWM": leg, "yahoo:MTUM": leg, "yahoo:XLU": leg, "yahoo:BTC-USD": leg })).toThrow(/BTC_ETH.*yahoo:ETH-USD/);
  // A stored ratio with one leg is used as stored; no leg at all leaves it missing.
  expect(resolve({ "yahoo:HG=F": leg, COPPER_GOLD: leg }).COPPER_GOLD).toBe(leg);
  expect("COPPER_GOLD" in resolve({ VIX: leg })).toBe(false);
  // A source input still may not carry a ratio row.
  expect(() => parseSourceCsv("date,series,value\n2024-01-01,COPPER_GOLD,1.5")).toThrow(CalculatedRowError);
});

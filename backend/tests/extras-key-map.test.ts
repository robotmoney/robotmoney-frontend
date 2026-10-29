// One map names the backtest extras: ledger key, SDK input id, provider symbol.
// Production rows exist under the ledger keys, so they must never drift.
// The D74 storage mapping (issue 1423) builds on it: see the second describe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  EXTRA_WRITE_KEYS,
  LEDGER_EXTRA_KEYS,
  SERIES_MAPPING,
  consumerStorageKeys,
  inputHistoryFromStorage,
  selectConsumerObservations,
  sourceIdForStorageKey,
  storageKeyForSourceId,
  type LedgerExtra,
} from "../src/analytics/extras.ts";
import { SOURCE_TOLERANCES, rawIndicatorSourceKey } from "../src/analytics/source-tolerance.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { sql } from "../src/db/client.ts";
import { captureSourceAcquisition } from "../src/analytics/source-ledger.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { loadCurrentSourceValues } from "../src/analytics/store/run-ledger-store.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import { EXTRA_IDS } from "../../packages/analyst-sdk/src/run.ts";

function missingTolerances(map: Record<string, LedgerExtra>, tol: Record<string, unknown>): string[] {
  return Object.values(map).filter((x) => !(x.ledgerKey in tol)).map((x) => x.ledgerKey);
}

useCleanDatabase(import.meta.file);

describe("LEDGER_EXTRA_KEYS", () => {
  test("pins the production ledger keys (never rename)", () => {
    expect(Object.fromEntries(Object.entries(LEDGER_EXTRA_KEYS).map(([k, v]) => [k, v.ledgerKey]))).toEqual({
      spx: "backtest:^GSPC", eth: "backtest:ETH-USD", tbill3m: "backtest:DTB3",
    });
  });

  test("every ledger key has a SOURCE_TOLERANCES entry", () => {
    expect(missingTolerances(LEDGER_EXTRA_KEYS, SOURCE_TOLERANCES)).toEqual([]);
  });

  test("planted violation: a map entry without a tolerance is caught", () => {
    const planted = { ...LEDGER_EXTRA_KEYS, fake: { ledgerKey: "backtest:FAKE", inputId: "FAKE", provider: "yahoo", symbol: "FAKE" } as LedgerExtra };
    expect(missingTolerances(planted, SOURCE_TOLERANCES)).toEqual(["backtest:FAKE"]);
  });

  test("SDK EXTRA_IDS equal the map's input ids", () => {
    expect(EXTRA_IDS).toEqual({
      spx: LEDGER_EXTRA_KEYS.spx.inputId, eth: LEDGER_EXTRA_KEYS.eth.inputId, tbill3m: LEDGER_EXTRA_KEYS.tbill3m.inputId,
    });
  });

  test("fetchBacktestExtras writes exactly the map's keys, providers and identities", async () => {
    const realFetch = globalThis.fetch;
    // Network is never reached: capture sink records the acquisition, fetch fails.
    globalThis.fetch = (async () => { throw new Error("no network in test"); }) as any;
    const seen: any[] = [];
    const sink: any = { ...{}, };
    try {
      // The sink shape is owned by captureSourceAcquisition; record whatever it passes.
      const rec = new Proxy(sink, { get: (_t, p) => (...a: any[]) => { seen.push({ p, a }); return Promise.resolve(undefined); } });
      await liveDataSource.fetchBacktestExtras({ warn() {}, error() {}, log() {} } as any, rec, undefined as any).catch(() => {});
    } finally { globalThis.fetch = realFetch; }
    // The sink records provider + cacheIdentity (the source key itself is
    // carried by captureSourceAcquisition, so it is pinned by source text below).
    const got = seen.map((e) => ({ provider: e.a[0].provider, cacheIdentity: e.a[0].cacheIdentity })).sort((x, y) => x.cacheIdentity.localeCompare(y.cacheIdentity));
    expect(got).toEqual([
      { provider: "yahoo", cacheIdentity: "^GSPC:2010-01-01" },
      { provider: "yahoo", cacheIdentity: "ETH-USD:2010-01-01" },
      { provider: "fred", cacheIdentity: "DTB3" },
    ].sort((x, y) => x.cacheIdentity.localeCompare(y.cacheIdentity)));
    for (const x of Object.values(LEDGER_EXTRA_KEYS)) expect(got.some((g) => g.provider === x.provider && g.cacheIdentity.startsWith(x.symbol))).toBe(true);
  });

  test("the acquire() call sites in data-source.ts write through the reverse mapping, to exactly the map's provider/ledger keys", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "analytics", "access", "data-source.ts"), "utf8");
    const written = [...src.matchAll(/\bacquire\(\s*"([^"]+)",\s*W\.(spx|eth|tbill3m)\b/g)]
      .map((m) => `${m[1]}|${EXTRA_WRITE_KEYS[m[2] as keyof typeof EXTRA_WRITE_KEYS]}`).sort();
    expect(written).toEqual(Object.values(LEDGER_EXTRA_KEYS).map((x) => `${x.provider}|${x.ledgerKey}`).sort());
    expect(src).not.toMatch(/\bacquire\(\s*"[^"]+",\s*"backtest:/);
    for (const k of ["spx", "eth", "tbill3m"]) expect(src).toContain(`X.${k}.symbol`);
  });
});

// D74 (issue 1423): one shared mapping from storage key to source id, per consumer.
describe("the D74 storage mapping", () => {
  // Pinned BEFORE the change: the storage keys each consumer read on main.
  const REGISTRY_IDS = INDICATORS.map((i) => i.id);
  // The D74 amendment of 2026-10-28 (issue 1514) moves exactly two consumers:
  // DEFI_GROWTH and STABLES_GROWTH read the DEFI_TVL and STABLES keys.
  const AMENDED: Record<string, string> = { DEFI_GROWTH: "DEFI_TVL", STABLES_GROWTH: "STABLES" };
  const PINNED: Record<string, string[]> = {
    ...Object.fromEntries(REGISTRY_IDS.map((id) => [`indicator:${id}`, [`raw_indicator_history:${AMENDED[id] ?? id}`]])),
    correlations: ["backtest:ETH-USD", "backtest:^GSPC"],
    backtest: ["backtest:DTB3", "backtest:ETH-USD", "backtest:^GSPC"],
  };

  test("every consumer's resolved storage keys equal the pinned pre-change list", () => {
    expect(REGISTRY_IDS.length).toBe(26);
    expect(consumerStorageKeys()).toEqual(PINNED);
  });

  test("writes use the reverse mapping: it returns the keys the extractors write and the readers read", () => {
    for (const ind of INDICATORS) {
      const m = SERIES_MAPPING.find((x) => x.consumer === `indicator:${ind.id}`)!;
      expect(storageKeyForSourceId(m.consumer, m.series)).toBe(rawIndicatorSourceKey(AMENDED[ind.id] ?? ind.id));
      expect(sourceIdForStorageKey(m.consumer, rawIndicatorSourceKey(AMENDED[ind.id] ?? ind.id))).toBe(m.series);
    }
    expect(EXTRA_WRITE_KEYS).toEqual({ spx: "backtest:^GSPC", eth: "backtest:ETH-USD", tbill3m: "backtest:DTB3" });
    expect(sourceIdForStorageKey("backtest", "backtest:DTB3")).toBe("fred:DTB3");
    expect(sourceIdForStorageKey("indicator:SPX_TREND", "backtest:^GSPC")).toBeNull();
    expect(() => storageKeyForSourceId("backtest", "yahoo:QQQ")).toThrow(/no storage key maps to yahoo:QQQ for consumer backtest/);
  });

  test("every mapped storage key has its D56 tolerance", () => {
    const keys = [...new Set(SERIES_MAPPING.map((m) => m.storageKey))];
    expect(keys.filter((k) => !(k in SOURCE_TOLERANCES))).toEqual([]);
  });

  test("two stored streams for yahoo:^GSPC: each consumer reads only its own, by exact value and version id", async () => {
    const sink = { saveSourceAcquisition };
    const capture = (sourceKey: string, points: { date: string; value: number }[]) =>
      captureSourceAcquisition({ provider: "yahoo", sourceKey, parserVersion: "yahoo:1", cacheIdentity: `^GSPC:${sourceKey}` }, sink, async () => points);
    // Same provider:symbol, same dates, different values.
    await capture("raw_indicator_history:SPX_TREND", [{ date: "2026-10-01", value: 5700.25 }, { date: "2026-10-02", value: 5711.5 }]);
    await capture("backtest:^GSPC", [{ date: "2026-10-01", value: 5699.875 }, { date: "2026-10-02", value: 5712.125 }]);
    const stored = await sql<{ id: string; source_key: string; market_date: string; value: number }[]>`
      SELECT id::text, source_key, market_date::text AS market_date, value FROM source_value_versions
      WHERE source_key IN ('raw_indicator_history:SPX_TREND', 'backtest:^GSPC') ORDER BY source_key, market_date`;
    // Four rows: nothing merged or overwritten.
    expect(stored.length).toBe(4);
    const members = await loadCurrentSourceValues();
    const want = (key: string) => stored.filter((r) => r.source_key === key).map((r) => ({ series: "yahoo:^GSPC", storageKey: key, date: r.market_date, value: Number(r.value), versionId: r.id }));
    const got = (c: string) => selectConsumerObservations(members, c).filter((o) => o.series === "yahoo:^GSPC");
    expect(got("indicator:SPX_TREND")).toEqual(want("raw_indicator_history:SPX_TREND"));
    expect(got("backtest")).toEqual(want("backtest:^GSPC"));
    expect(got("correlations")).toEqual(want("backtest:^GSPC"));
    expect(want("backtest:^GSPC").map((o) => o.value)).toEqual([5699.875, 5712.125]);
    const h = inputHistoryFromStorage(members);
    expect(h.SPX_TREND).toEqual([{ date: "2026-10-01", value: 5700.25 }, { date: "2026-10-02", value: 5711.5 }]);
    expect(h.SPX).toEqual([{ date: "2026-10-01", value: 5699.875 }, { date: "2026-10-02", value: 5712.125 }]);
  });
});

// Issue 1514: the Yahoo ratio legs are stored as source series (analytics requirements 4.3).
describe("the ratio leg mapping", () => {
  test("validateSeriesMapping accepts it, alone and with the consumer mapping, and no consumer reads one leg from two keys", async () => {
    const { RATIO_LEG_MAPPING, validateSeriesMapping, ratioLegStorageKey } = await import("../../packages/analyst-sdk/src/series-ids.ts");
    expect(validateSeriesMapping(RATIO_LEG_MAPPING)).toBe(RATIO_LEG_MAPPING);
    expect(() => validateSeriesMapping([...SERIES_MAPPING, ...RATIO_LEG_MAPPING])).not.toThrow();
    expect(RATIO_LEG_MAPPING).toHaveLength(16);
    const keyOf = new Map<string, string>();
    for (const m of RATIO_LEG_MAPPING) {
      const prior = keyOf.get(m.series);
      if (prior !== undefined) expect({ leg: m.series, key: m.storageKey }).toEqual({ leg: m.series, key: prior });
      keyOf.set(m.series, m.storageKey);
      expect(m.storageKey).toBe(ratioLegStorageKey(m.series));
    }
    expect(keyOf.get("yahoo:SPY")).toBe("research:SPY");
    expect(keyOf.get("yahoo:ETH-USD")).toBe(LEDGER_EXTRA_KEYS.eth.ledgerKey);
    expect(keyOf.get("yahoo:IWM")).toBe("yahoo:IWM");
    // A consumer reading one leg from two keys is refused.
    const bad = [...RATIO_LEG_MAPPING, { ...RATIO_LEG_MAPPING.find((m) => m.series === "yahoo:SPY")!, storageKey: "yahoo:SPY" }];
    expect(() => validateSeriesMapping(bad)).toThrow(/would read yahoo:SPY from two storage keys/);
  });
});

// Issue 1514: the D74 amendment of 2026-10-28. One key per DefiLlama source.
describe("the D74 amendment: DEFI_GROWTH and STABLES_GROWTH read the DEFI_TVL and STABLES keys", () => {
  test("the mapping maps indicator:DEFI_GROWTH to raw_indicator_history:DEFI_TVL and indicator:STABLES_GROWTH to raw_indicator_history:STABLES", () => {
    expect(consumerStorageKeys()["indicator:DEFI_GROWTH"]).toEqual(["raw_indicator_history:DEFI_TVL"]);
    expect(consumerStorageKeys()["indicator:STABLES_GROWTH"]).toEqual(["raw_indicator_history:STABLES"]);
    expect(storageKeyForSourceId("indicator:DEFI_GROWTH", "defillama_tvl:total")).toBe("raw_indicator_history:DEFI_TVL");
    expect(storageKeyForSourceId("indicator:STABLES_GROWTH", "defillama_stables:total")).toBe("raw_indicator_history:STABLES");
    // No consumer reads the *_GROWTH keys any more.
    expect(SERIES_MAPPING.some((m) => m.storageKey.endsWith("_GROWTH"))).toBe(false);
  });

  test("stored rows under DEFI_TVL and STABLES feed both indicators; rows under the old *_GROWTH keys reach no consumer", () => {
    const rows = [
      { sourceKey: "raw_indicator_history:DEFI_TVL", marketDate: "2024-01-02", value: 90e9 },
      { sourceKey: "raw_indicator_history:STABLES", marketDate: "2024-01-02", value: 150e9 },
      { sourceKey: "raw_indicator_history:DEFI_GROWTH", marketDate: "2024-01-01", value: 1 },
    ];
    const h = inputHistoryFromStorage(rows);
    expect(h.DEFI_GROWTH).toEqual([{ date: "2024-01-02", value: 90e9 }]);
    expect(h.DEFI_TVL).toEqual(h.DEFI_GROWTH!);
    expect(h.STABLES_GROWTH).toEqual([{ date: "2024-01-02", value: 150e9 }]);
  });

  test("docs/decisions.md D74 carries the 2026-10-28 amendment naming both consumers and keys", () => {
    const decisions = readFileSync(join(import.meta.dir, "..", "..", "docs", "decisions.md"), "utf8");
    const start = decisions.indexOf("## D74 ");
    expect(start).toBeGreaterThan(-1);
    const d74 = decisions.slice(start, decisions.indexOf("\n## D", start + 1));
    const amendment = d74.slice(d74.indexOf("### Amendment (issue 1514, owner 2026-10-28)"));
    expect(amendment.length).toBeGreaterThan(100);
    expect(amendment).toContain("**Status:** proposed");
    for (const s of ["`indicator:DEFI_GROWTH`", "`raw_indicator_history:DEFI_TVL`", "`indicator:STABLES_GROWTH`", "`raw_indicator_history:STABLES`"]) expect(amendment).toContain(s);
  });
});

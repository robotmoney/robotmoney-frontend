// One map names the backtest extras: ledger key, SDK input id, provider symbol.
// Production rows exist under the ledger keys, so they must never drift.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { LEDGER_EXTRA_KEYS, type LedgerExtra } from "../src/analytics/extras.ts";
import { SOURCE_TOLERANCES } from "../src/analytics/source-tolerance.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import { EXTRA_IDS } from "../../packages/analyst-sdk/src/run.ts";

function missingTolerances(map: Record<string, LedgerExtra>, tol: Record<string, unknown>): string[] {
  return Object.values(map).filter((x) => !(x.ledgerKey in tol)).map((x) => x.ledgerKey);
}

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

  test("the acquire() call sites in data-source.ts write exactly the map's provider/ledger keys", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "analytics", "access", "data-source.ts"), "utf8");
    const written = [...src.matchAll(/\bacquire\(\s*"([^"]+)",\s*"(backtest:[^"]+)"/g)].map((m) => `${m[1]}|${m[2]}`).sort();
    expect(written).toEqual(Object.values(LEDGER_EXTRA_KEYS).map((x) => `${x.provider}|${x.ledgerKey}`).sort());
    for (const k of ["spx", "eth", "tbill3m"]) expect(src).toContain(`X.${k}.symbol`);
  });
});

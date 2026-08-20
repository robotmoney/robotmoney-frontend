// Historical daily prices for the wallet backfill (issue #709, §6.5.2).
// Offline: `globalThis.fetch` is stubbed; the real fetcher, pool selector and
// candle parser execute.
//
// The two properties worth a test are the two that were established
// empirically and are easy to get wrong later:
//
//   1. POOL SELECTION SORTS BY 24h VOLUME, NOT RESERVE. A reserve sort picks a
//      decoy for WETH — an observed `Bnb / WETH` pool reports ~$7.68B reserve
//      against volume.h1 = 0.0 and wins outright. That decoy would price the
//      whole backfilled WETH column wrong, quietly.
//   2. CANDLES ARE UTC-MIDNIGHT ALIGNED, which is the same day key the sampler
//      writes. If that ever stops being true, prices silently shift by a day.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  fetchDailyCloses,
  loadHistoricalPrices,
  resolvePoolForToken,
  _resetHistoricalPriceCachesForTests,
} from "../src/chain/historical-prices.ts";
import { resolveTrackedAssets } from "../src/config.ts";

const realFetch = globalThis.fetch;

beforeEach(() => {
  // No inter-request spacing in tests: the serializer is exercised by its own
  // production default, not by making the suite sleep.
  process.env.GECKO_OHLCV_MIN_INTERVAL_MS = "0";
  _resetHistoricalPriceCachesForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GECKO_OHLCV_MIN_INTERVAL_MS;
  _resetHistoricalPriceCachesForTests();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const midnight = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

test("pool selection uses 24h VOLUME, not reserve — the WETH decoy loses", async () => {
  globalThis.fetch = (async () =>
    json({
      data: [
        // The decoy: enormous reserve, no trading.
        { id: "base_0xdecoy", attributes: { address: "0xdecoy", reserve_in_usd: "7680000000", volume_usd: { h24: "0" } } },
        // The real one: modest reserve, actual volume.
        { id: "base_0xreal", attributes: { address: "0xreal", reserve_in_usd: "253000", volume_usd: { h24: "412000" } } },
      ],
    })) as unknown as typeof fetch;

  expect(await resolvePoolForToken("0xTOKEN")).toBe("0xreal");
});

test("a pool with no usable volume figure is not selected", async () => {
  globalThis.fetch = (async () =>
    json({
      data: [
        { id: "base_0xnovol", attributes: { address: "0xnovol", reserve_in_usd: "999999999" } },
        { id: "base_0xok", attributes: { address: "0xok", volume_usd: { h24: "1" } } },
      ],
    })) as unknown as typeof fetch;
  expect(await resolvePoolForToken("0xTOKEN2")).toBe("0xok");
});

test("no pool at all throws rather than returning a default", async () => {
  globalThis.fetch = (async () => json({ data: [] })) as unknown as typeof fetch;
  await expect(resolvePoolForToken("0xNOPOOL")).rejects.toThrow(/no pool/);
});

test("the pool is resolved ONCE and cached — re-discovering per run burns the keyless quota", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "5" } } }] });
  }) as unknown as typeof fetch;
  await resolvePoolForToken("0xCACHED");
  await resolvePoolForToken("0xCACHED");
  await resolvePoolForToken("0xCACHED");
  expect(calls).toBe(1);
});

test("daily candles map to their own UTC day, and the CLOSE is the value taken", async () => {
  globalThis.fetch = (async () =>
    json({
      data: {
        attributes: {
          // [ts, open, high, low, close, volume] — newest first, as served.
          ohlcv_list: [
            [midnight("2026-07-03"), 1, 9, 0.5, 3.3, 100],
            [midnight("2026-07-02"), 1, 9, 0.5, 2.2, 100],
            [midnight("2026-07-01"), 1, 9, 0.5, 1.1, 100],
          ],
        },
      },
    })) as unknown as typeof fetch;

  const closes = await fetchDailyCloses("0xpool", "2026-07-01", "2026-07-03");
  expect(closes.get("2026-07-01")).toBe(1.1);
  expect(closes.get("2026-07-02")).toBe(2.2);
  expect(closes.get("2026-07-03")).toBe(3.3); // close, not open/high/low
});

test("candles outside the requested window are dropped, and a non-numeric close is ABSENT not zero", async () => {
  globalThis.fetch = (async () =>
    json({
      data: {
        attributes: {
          ohlcv_list: [
            [midnight("2026-07-05"), 1, 1, 1, 5.5, 1], // outside
            [midnight("2026-07-02"), 1, 1, 1, null, 1], // unusable close
            [midnight("2026-07-01"), 1, 1, 1, 1.1, 1],
          ],
        },
      },
    })) as unknown as typeof fetch;

  const closes = await fetchDailyCloses("0xpool", "2026-07-01", "2026-07-02");
  expect(closes.has("2026-07-05")).toBe(false);
  // A missing price must stay missing: the driver fails the day rather than
  // valuing a real holding at zero.
  expect(closes.has("2026-07-02")).toBe(false);
  expect(closes.get("2026-07-01")).toBe(1.1);
});

test("USDC-priced assets are pinned $1 and cost no request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return json({ data: [] });
  }) as unknown as typeof fetch;

  const usdc = resolveTrackedAssets().filter((a) => a.priceKind === "usdc");
  expect(usdc.length).toBeGreaterThan(0); // USDC plus both strategy sleeves
  const table = await loadHistoricalPrices(usdc, "2026-07-01", "2026-07-02");
  for (const a of usdc) {
    expect(table.get(a.symbol)!.get("2026-07-01")).toBe(1);
    expect(table.get(a.symbol)!.get("2026-07-02")).toBe(1);
  }
  expect(calls).toBe(0);
});

test("a yahoo-priced asset is REFUSED rather than approximated (PD7 / #648)", async () => {
  const sp500 = resolveTrackedAssets().filter((a) => a.priceKind === "yahoo");
  expect(sp500.length).toBe(1);
  await expect(loadHistoricalPrices(sp500, "2026-07-01", "2026-07-01")).rejects.toThrow(/deliberately does not resolve/);
});

test("WETH and native ETH share one pool and one OHLCV request", async () => {
  let poolCalls = 0;
  let ohlcvCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/ohlcv/")) {
      ohlcvCalls += 1;
      return json({ data: { attributes: { ohlcv_list: [[midnight("2026-07-01"), 1, 1, 1, 3000, 1]] } } });
    }
    poolCalls += 1;
    return json({ data: [{ id: "base_0xweth", attributes: { address: "0xweth", volume_usd: { h24: "9" } } }] });
  }) as unknown as typeof fetch;

  const assets = resolveTrackedAssets().filter((a) => a.symbol === "WETH" || a.symbol === "ETH");
  expect(assets).toHaveLength(2);
  const table = await loadHistoricalPrices(assets, "2026-07-01", "2026-07-01");
  expect(table.get("WETH")!.get("2026-07-01")).toBe(3000);
  expect(table.get("ETH")!.get("2026-07-01")).toBe(3000);
  // Native ETH is priced off WETH's address — one pool, one candle request.
  expect(poolCalls).toBe(1);
  expect(ohlcvCalls).toBe(1);
});

test("a day-at-a-time driver pays for ONE window, not one request per day", async () => {
  let ohlcvCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/ohlcv/")) {
      ohlcvCalls += 1;
      const list: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        list.push([midnight("2026-07-01") + i * 86_400, 1, 1, 1, 100 + i, 1]);
      }
      return json({ data: { attributes: { ohlcv_list: list } } });
    }
    return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "9" } } }] });
  }) as unknown as typeof fetch;

  const bnkr = resolveTrackedAssets().filter((a) => a.symbol === "BNKR");
  for (let i = 0; i < 5; i++) {
    const day = new Date(Date.parse("2026-07-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
    const table = await loadHistoricalPrices(bnkr, day, day);
    expect(table.get("BNKR")!.get(day)).toBe(100 + i);
  }
  // The whole point of §6.5.2's "O(1) per pool per window": five separate day
  // jobs must not cost five requests.
  expect(ohlcvCalls).toBe(1);
});

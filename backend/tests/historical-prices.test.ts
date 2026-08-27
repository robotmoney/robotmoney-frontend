// Historical daily prices for the wallet backfill (issue #709, markets §3.2).
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
//   3. WHAT A RESPONSE COVERS IS NOT WHAT THE REQUEST ASKED FOR. Paging stops at
//      its own bounds, and today's candle may not exist yet, so a blank day is
//      either "no price here" or "never fetched" — and caching the second as the
//      first turns one truncated page into a permanent gap for the rest of the
//      process. In particular a page's ROW COUNT says nothing: the vendor caps
//      each request by a ~6-month window, so an illiquid pool fills a whole
//      window with few rows, and only an EMPTY page means there is nothing
//      older.
//   4. A PRICE OF ZERO IS NOT A PRICE. It is written as a real value and reads
//      downstream as an asset going to zero for a day, on a row no repair pass
//      will revisit — strictly worse than the disclosed gap a refusal leaves.
//
// Which token a pool's candles actually price is the subject of its own file,
// tests/ohlcv-orientation.test.ts; the fixtures here carry the vendor's `meta`
// block because every real response does, not because these tests read it.
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
  process.env.GECKO_MIN_INTERVAL_MS = "0";
  process.env.GECKO_OHLCV_MIN_INTERVAL_MS = "0";
  _resetHistoricalPriceCachesForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GECKO_MIN_INTERVAL_MS;
  delete process.env.GECKO_OHLCV_MIN_INTERVAL_MS;
  _resetHistoricalPriceCachesForTests();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const midnight = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

// A fixture's `meta.base` is the vendor's statement of which token it priced, so
// it has to name the token the caller asked for — the real address, not an echo
// of the request.
const dayAgo = (n: number): string =>
  new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const WETH_ADDRESS = resolveTrackedAssets().find((a) => a.symbol === "WETH")!.address!;
const BNKR_ADDRESS = resolveTrackedAssets().find((a) => a.symbol === "BNKR")!.address!;

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
      // Every OHLCV response names the side it priced; the request named the
      // token, so this is the token asked for. Mixed case on purpose — the
      // comparison is case-insensitive.
      meta: { base: { symbol: "TKN", address: "0xToKeN" }, quote: { symbol: "USDC", address: "0xusdc" } },
    })) as unknown as typeof fetch;

  const { closes } = await fetchDailyCloses("0xpool", "0xtoken", "2026-07-01", "2026-07-03");
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
            [midnight("2026-07-03"), 1, 1, 1, 0, 1], // a close of ZERO
            [midnight("2026-07-02"), 1, 1, 1, null, 1], // unusable close
            [midnight("2026-07-01"), 1, 1, 1, 1.1, 1],
          ],
        },
      },
      // Every OHLCV response names the side it priced; the request named the
      // token, so this is the token asked for. Mixed case on purpose — the
      // comparison is case-insensitive.
      meta: { base: { symbol: "TKN", address: "0xToKeN" }, quote: { symbol: "USDC", address: "0xusdc" } },
    })) as unknown as typeof fetch;

  const { closes } = await fetchDailyCloses("0xpool", "0xtoken", "2026-07-01", "2026-07-03");
  expect(closes.has("2026-07-05")).toBe(false);
  // A missing price must stay missing: the driver fails the day rather than
  // valuing a real holding at zero.
  expect(closes.has("2026-07-02")).toBe(false);
  // And a close the vendor states AS zero is refused for the same reason, not
  // for a different one. No token this table prices is worth nothing, so a zero
  // is a defect in the candle; believing it writes value_usd = 0 for every
  // holding of the asset, on a day recorded as settled and never revisited.
  expect(closes.has("2026-07-03")).toBe(false);
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
      // A one-candle pool, served as a POOL: the page is whatever part of its
      // history lies below `before_timestamp`, and below the history that is an
      // empty list. A stub that re-serves the same page forever is a pool the
      // reader can never finish reading, so the request counts it produces mean
      // nothing.
      const before = Number(new URL(String(url)).searchParams.get("before_timestamp"));
      return json({
        data: {
          attributes: { ohlcv_list: midnight("2026-07-01") < before ? [[midnight("2026-07-01"), 1, 1, 1, 3000, 1]] : [] },
        },
        meta: {
          base: { symbol: "WETH", address: WETH_ADDRESS },
          quote: { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
        },
      });
    }
    poolCalls += 1;
    return json({ data: [{ id: "base_0xweth", attributes: { address: "0xweth", volume_usd: { h24: "9" } } }] });
  }) as unknown as typeof fetch;

  const assets = resolveTrackedAssets().filter((a) => a.symbol === "WETH" || a.symbol === "ETH");
  expect(assets).toHaveLength(2);
  const table = await loadHistoricalPrices(assets, "2026-07-01", "2026-07-01");
  expect(table.get("WETH")!.get("2026-07-01")).toBe(3000);
  expect(table.get("ETH")!.get("2026-07-01")).toBe(3000);
  // Native ETH is priced off WETH's address, so it shares the cache key and
  // reads the series WETH already paid for: the second symbol costs NOTHING.
  // Measured against WETH alone rather than against a fixed number — what must
  // hold is that ETH is free, not how many pages this pool takes to read.
  const bothCost = ohlcvCalls;
  _resetHistoricalPriceCachesForTests();
  ohlcvCalls = 0;
  await loadHistoricalPrices(
    assets.filter((a) => a.symbol === "WETH"),
    "2026-07-01",
    "2026-07-01",
  );
  expect(bothCost).toBe(ohlcvCalls);
  // And that pool comes from config, so the volume ranking is not consulted at
  // all: for WETH it is a coin flip between two near-tied pools, one of which
  // prices the other side of the pair.
  expect(poolCalls).toBe(0);
});

test("a day-at-a-time driver pays for ONE window, not one request per day", async () => {
  let ohlcvCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/ohlcv/")) {
      ohlcvCalls += 1;
      const before = Number(new URL(String(url)).searchParams.get("before_timestamp"));
      const list: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        const ts = midnight("2026-07-01") + i * 86_400;
        if (ts < before) list.push([ts, 1, 1, 1, 100 + i, 1]);
      }
      return json({
        data: { attributes: { ohlcv_list: list } },
        meta: { base: { symbol: "BNKR", address: BNKR_ADDRESS }, quote: { symbol: "WETH", address: WETH_ADDRESS } },
      });
    }
    return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "9" } } }] });
  }) as unknown as typeof fetch;

  const bnkr = resolveTrackedAssets().filter((a) => a.symbol === "BNKR");
  let afterFirstDay = 0;
  for (let i = 0; i < 5; i++) {
    const day = new Date(Date.parse("2026-07-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
    const table = await loadHistoricalPrices(bnkr, day, day);
    expect(table.get("BNKR")!.get(day)).toBe(100 + i);
    if (i === 0) afterFirstDay = ohlcvCalls;
  }
  // The whole point of markets §3.2's "O(1) per pool per window": the first day reads
  // the window and the other four ride on it. Asserted as "the last four are
  // free" rather than as a total, because the total also counts the pages the
  // first read takes to reach the bottom of this pool — a property of the
  // fixture's history, not of the caching rule under test.
  expect(ohlcvCalls).toBe(afterFirstDay);
});

// ── What a response COVERS, and how the reader learns it reached the bottom ──
//
// Three stops, three different facts. Only one of them is "there is nothing
// older", and the other two must leave the days below re-fetchable — otherwise
// one truncated read is cached as "these days have no price" for the rest of the
// process, and the backfill writes nothing for them and never asks again.

test("a read that stopped at its own PAGE BOUND leaves the days below it FETCHABLE, not cached as 'no price'", async () => {
  // A pool with more history than the reader will page through: every page is
  // full, so the read never runs out of candles — it runs out of REQUESTS. That
  // says nothing about the days below the last one it saw except that they were
  // never asked for.
  let ohlcvCalls = 0;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (!u.includes("/ohlcv/")) {
      return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "9" } } }] });
    }
    ohlcvCalls += 1;
    const before = Number(new URL(u).searchParams.get("before_timestamp"));
    const list: unknown[] = [];
    for (let ts = before - 86_400; list.length < 100; ts -= 86_400) {
      list.push([ts, 1, 1, 1, 100 + Math.round((midnight(dayAgo(0)) - ts) / 86_400), 1]);
    }
    return json({
      data: { attributes: { ohlcv_list: list } },
      meta: { base: { symbol: "BNKR", address: BNKR_ADDRESS }, quote: { symbol: "WETH", address: WETH_ADDRESS } },
    });
  }) as unknown as typeof fetch;

  const bnkr = resolveTrackedAssets().filter((a) => a.symbol === "BNKR");
  // Far enough back that the paging bound, not the pool, ends the read.
  const deep = dayAgo(1300);

  const first = await loadHistoricalPrices(bnkr, deep, deep);
  expect(first.get("BNKR")!.has(deep)).toBe(false);
  const afterFirst = ohlcvCalls;

  // Blank because it was never REACHED, so asking again must go back to the
  // vendor rather than being answered from a cached silence.
  const second = await loadHistoricalPrices(bnkr, deep, deep);
  expect(second.get("BNKR")!.has(deep)).toBe(false);
  expect(ohlcvCalls).toBeGreaterThan(afterFirst);

  // The other half of the same rule: a day INSIDE what the read DID reach is
  // answered from the cache, so a day-at-a-time driver still pays once.
  const settled = ohlcvCalls;
  const near = await loadHistoricalPrices(bnkr, dayAgo(20), dayAgo(20));
  expect(near.get("BNKR")!.get(dayAgo(20))).toBe(120);
  expect(ohlcvCalls).toBe(settled);
});

test("a SHORT page is not the end of a pool's history — an illiquid pool keeps paging", async () => {
  // The regression this guards: each request is capped by a ~6-month WINDOW, not
  // by a candle count, so a pool that trades one day in three fills a whole
  // window with ~60 rows. Stopping on the row count reads that as "the history
  // ended here" — abandoning real candles below AND recording the days beneath
  // as priceless. This module exists for exactly these tokens.
  let ohlcvCalls = 0;
  const WINDOW_DAYS = 181;
  const historyFloor = midnight(dayAgo(900));
  const trades = (ts: number): boolean => Math.floor(ts / 86_400) % 3 === 0;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (!u.includes("/ohlcv/")) {
      return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "9" } } }] });
    }
    ohlcvCalls += 1;
    const before = Number(new URL(u).searchParams.get("before_timestamp"));
    const list: unknown[] = [];
    for (let ts = before - 86_400; ts > before - WINDOW_DAYS * 86_400 && ts >= historyFloor; ts -= 86_400) {
      if (trades(ts)) list.push([ts, 1, 1, 1, 250, 1]);
    }
    return json({
      data: { attributes: { ohlcv_list: list } },
      meta: { base: { symbol: "BNKR", address: BNKR_ADDRESS }, quote: { symbol: "WETH", address: WETH_ADDRESS } },
    });
  }) as unknown as typeof fetch;

  // A day the pool actually traded on, well past the first window's bottom.
  let n = 250;
  while (!trades(midnight(dayAgo(n)))) n -= 1;
  const deep = dayAgo(n);

  const bnkr = resolveTrackedAssets().filter((a) => a.symbol === "BNKR");
  const table = await loadHistoricalPrices(bnkr, deep, deep);
  expect(table.get("BNKR")!.get(deep)).toBe(250);
  expect(ohlcvCalls).toBeGreaterThan(1); // it paged past the first short page
});

test("a window that reaches TODAY tops up its ceiling — it does not re-read the whole window each ask", async () => {
  // Today's candle is still forming, so `coveredRange` will not record today as
  // covered and an ask ending today can never be answered from the cache. That
  // is correct — caching a still-forming day as blank is the false-blank failure
  // this file exists to prevent — but it must not mean re-paging the entire
  // window on every call against a quota that 429s on the sixth request in ~15
  // seconds. Only the uncovered tail is re-asked.
  let ohlcvCalls = 0;
  const todaySec = midnight(dayAgo(0));
  const historyFloor = midnight(dayAgo(400));
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (!u.includes("/ohlcv/")) {
      return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "9" } } }] });
    }
    ohlcvCalls += 1;
    const before = Number(new URL(u).searchParams.get("before_timestamp"));
    const list: unknown[] = [];
    // The pool trades every day EXCEPT today, whose candle has not been
    // published yet — the shape that makes the ceiling unreachable.
    for (let ts = Math.min(before - 86_400, todaySec - 86_400); ts >= historyFloor && list.length < 100; ts -= 86_400) {
      list.push([ts, 1, 1, 1, 100 + Math.round((todaySec - ts) / 86_400), 1]);
    }
    return json({
      data: { attributes: { ohlcv_list: list } },
      meta: { base: { symbol: "BNKR", address: BNKR_ADDRESS }, quote: { symbol: "WETH", address: WETH_ADDRESS } },
    });
  }) as unknown as typeof fetch;

  const bnkr = resolveTrackedAssets().filter((a) => a.symbol === "BNKR");
  const first = await loadHistoricalPrices(bnkr, dayAgo(250), dayAgo(0));
  expect(first.get("BNKR")!.get(dayAgo(250))).toBe(350);
  expect(first.get("BNKR")!.has(dayAgo(0))).toBe(false); // not published, and not invented
  const windowCost = ohlcvCalls;
  expect(windowCost).toBeGreaterThan(1); // it really did page

  for (let i = 0; i < 3; i++) {
    const again = await loadHistoricalPrices(bnkr, dayAgo(250), dayAgo(0));
    // Still answers the settled days, still refuses to answer today.
    expect(again.get("BNKR")!.get(dayAgo(250))).toBe(350);
    expect(again.get("BNKR")!.has(dayAgo(0))).toBe(false);
  }
  // Three more asks, one request each: the tail, never the window.
  expect(ohlcvCalls).toBe(windowCost + 3);
});

test("an EMPTY page IS the end of the history — the days below it are settled, not re-asked", async () => {
  // The one statement of exhaustion this endpoint makes, and the reason it is
  // worth one extra request per pool per process: without it, every day below a
  // young pool's first candle would be re-read on every ask, forever.
  let ohlcvCalls = 0;
  const historyFloor = midnight(dayAgo(99));
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (!u.includes("/ohlcv/")) {
      return json({ data: [{ id: "base_0xp", attributes: { address: "0xp", volume_usd: { h24: "9" } } }] });
    }
    ohlcvCalls += 1;
    const before = Number(new URL(u).searchParams.get("before_timestamp"));
    const list: unknown[] = [];
    for (let ts = before - 86_400; ts >= historyFloor && list.length < 100; ts -= 86_400) {
      list.push([ts, 1, 1, 1, 100 + Math.round((midnight(dayAgo(0)) - ts) / 86_400), 1]);
    }
    return json({
      data: { attributes: { ohlcv_list: list } },
      meta: { base: { symbol: "BNKR", address: BNKR_ADDRESS }, quote: { symbol: "WETH", address: WETH_ADDRESS } },
    });
  }) as unknown as typeof fetch;

  const bnkr = resolveTrackedAssets().filter((a) => a.symbol === "BNKR");
  const first = await loadHistoricalPrices(bnkr, dayAgo(10), dayAgo(10));
  expect(first.get("BNKR")!.get(dayAgo(10))).toBe(110);

  const settled = ohlcvCalls;
  const below = await loadHistoricalPrices(bnkr, dayAgo(150), dayAgo(150));
  expect(below.get("BNKR")!.has(dayAgo(150))).toBe(false); // the pool did not exist yet
  expect(ohlcvCalls).toBe(settled); // and that is a settled fact, not a re-ask
});

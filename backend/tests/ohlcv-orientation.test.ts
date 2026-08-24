// The two OHLCV reads in this repo, and the question they have to ask out loud.
//
// A pool holds TWO tokens and its candles denominate exactly one of them.
// GeckoTerminal answers an unasked question with the pool's BASE side, so a
// request that does not name a token gets whichever side that pool happens to
// list first — a real number, correctly formatted, and possibly the wrong asset.
//
// This is not hypothetical. The two deepest Base pools holding WETH are a near
// tie on 24h volume: "WETH / USDC 0.3%", where WETH is the base side, and
// "cbBTC / WETH 0.05%", where it is the quote side. A ranking that re-runs every
// backfill picks either one depending on the hour, and the second one answers
// with cbBTC — measured live at 77,621.21 against WETH's 2,460.91 on the same
// day. That is ~25x too large, arrives as a plausible float, and is
// indistinguishable downstream from a price.
//
// Two independent properties close it, and they are worth separate tests
// because they fail at different times:
//
//   1. THE REQUEST NAMES THE TOKEN. Every OHLCV url carries `token=` — the
//      address of the asset being priced — and `currency=usd`. Pure string
//      assertion, no arithmetic: this is the test that would have caught the
//      original defect at review time rather than in a month of ledger rows.
//   2. THE ANSWER IS CHECKED, NOT ASSUMED. `meta.base` follows `token=`, so a
//      response that priced the other half of the pair says so in-band. Both
//      call sites read it back and REFUSE the body: the symbol is left out of
//      the price table, the swap is valued NULL, and no number derived from the
//      other token is stored anywhere.
//
// Offline: only `globalThis.fetch` is stubbed. The real url builders, paging,
// candle parser, orientation guards and degradation paths execute.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  loadHistoricalPrices,
  _resetHistoricalPriceCachesForTests,
} from "../src/chain/historical-prices.ts";
import { fetchGeckoDailyCloseUsd, _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";
import { resolveTrackedAssets, WETH_USDC_POOL } from "../src/config.ts";

const realFetch = globalThis.fetch;

// Base mainnet addresses, and the closes measured against the live endpoint for
// one and the same UTC day. Keeping the real magnitudes is the point: a
// regression has to reproduce the production symptom, not a toy one.
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH_CLOSE = 2460.91;
const CBBTC_CLOSE = 77621.21;
// "cbBTC / WETH 0.05%" — the decoy that wins the volume ranking about half the
// time. It is named here and nowhere in src/ on purpose.
const CBBTC_WETH_POOL = "0x42d4a22cad0f5a49681a5715ce994af73a43b76b";
const BNKR = resolveTrackedAssets().find((a) => a.symbol === "BNKR")!.address!;
const BNKR_POOL = "0xbnkrpool";

beforeEach(() => {
  process.env.GECKO_OHLCV_MIN_INTERVAL_MS = "0";
  _resetHistoricalPriceCachesForTests();
  _resetTokenPriceCacheForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GECKO_OHLCV_MIN_INTERVAL_MS;
  _resetHistoricalPriceCachesForTests();
  _resetTokenPriceCacheForTests();
});

const midnight = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

interface Side {
  base: { name: string; symbol: string; address: string };
  quote: { name: string; symbol: string; address: string };
}

const WETH_USDC: Side = {
  base: { name: "Wrapped Ether", symbol: "WETH", address: WETH },
  quote: { name: "USD Coin", symbol: "USDC", address: USDC },
};
const CBBTC_WETH: Side = {
  base: { name: "Coinbase Wrapped BTC", symbol: "cbBTC", address: CBBTC },
  quote: { name: "Wrapped Ether", symbol: "WETH", address: WETH },
};
const BNKR_WETH: Side = {
  base: { name: "Bankr", symbol: "BNKR", address: BNKR },
  quote: { name: "Wrapped Ether", symbol: "WETH", address: WETH },
};

/** A response in the vendor's own shape: candles PLUS the `meta` block naming
 *  which side of the pair they price. Every real OHLCV response carries it, so
 *  a fixture without one models a reply GeckoTerminal never sends — and would
 *  quietly excuse the caller from checking. */
function ohlcv(side: Side, rows: unknown[][]): Response {
  return new Response(
    JSON.stringify({ data: { attributes: { ohlcv_list: rows } }, meta: { base: side.base, quote: side.quote } }),
    { status: 200 },
  );
}

/** The same response, but as a POOL rather than as a canned reply: `rows` is the
 *  pool's entire history and the page returned is the part of it older than the
 *  request's `before_timestamp`. Below the history that is an EMPTY list, which
 *  is the vendor's way of saying there is nothing older — and the only thing the
 *  reader accepts as proof it has reached the bottom, so a stub that ignores
 *  `before_timestamp` and re-serves the same page forever is not a pool the
 *  reader can ever finish reading. */
function ohlcvPage(side: Side, rows: unknown[][], url: string): Response {
  const before = Number(new URL(url).searchParams.get("before_timestamp"));
  return ohlcv(
    side,
    rows.filter((r) => Number(r[0]) < before),
  );
}

// ── 1. The request names the token ───────────────────────────────────────────

test("every historical OHLCV url names the TOKEN it prices, and currency=usd", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url));
    if (!u.pathname.includes("/ohlcv/")) {
      // BNKR has no pinned pool, so its pool is still ranked by 24h volume.
      return new Response(JSON.stringify({ data: [{ id: `base_${BNKR_POOL}`, attributes: { address: BNKR_POOL, volume_usd: { h24: "9" } } }] }), { status: 200 });
    }
    const pool = u.pathname.split("/pools/")[1]!.split("/")[0]!;
    seen.push(`${pool} token=${u.searchParams.get("token")} currency=${u.searchParams.get("currency")}`);
    return pool === WETH_USDC_POOL
      ? ohlcvPage(WETH_USDC, [[midnight("2026-07-01"), 2400, 2500, 2380, WETH_CLOSE, 1]], String(url))
      : ohlcvPage(BNKR_WETH, [[midnight("2026-07-01"), 1, 1, 1, 0.0005, 1]], String(url));
  }) as unknown as typeof fetch;

  const assets = resolveTrackedAssets().filter((a) => a.symbol === "WETH" || a.symbol === "BNKR");
  expect(assets).toHaveLength(2);
  await loadHistoricalPrices(assets, "2026-07-01", "2026-07-01");
  // The DISTINCT url shapes, one per pool: a read pages until the pool says
  // there is nothing older, so each shape is sent more than once and the count
  // is a property of these one-candle pools rather than of the parameters.
  // Every line is asserted whole, so a dropped parameter shows the url that was
  // actually sent, pinned pool and ranked pool alike.
  expect([...new Set(seen)]).toEqual([
    `${WETH_USDC_POOL} token=${WETH} currency=usd`,
    `${BNKR_POOL} token=${BNKR} currency=usd`,
  ]);
});

test("the buyback candle url names the token too — a pinned pool is not a statement of orientation", async () => {
  let seen = "";
  globalThis.fetch = (async (url: string) => {
    seen = String(url);
    return ohlcv(WETH_USDC, [[midnight("2026-03-23"), 2052.63, 2188.0, 2026.51, WETH_CLOSE, 1234]]);
  }) as unknown as typeof fetch;

  const close = await fetchGeckoDailyCloseUsd(WETH_USDC_POOL, WETH, midnight("2026-03-23") + 37_000);
  const u = new URL(seen);
  expect(`token=${u.searchParams.get("token")} currency=${u.searchParams.get("currency")}`).toBe(
    `token=${WETH} currency=usd`,
  );
  // The url is also both cache keys, so the token being IN it is what stops two
  // tokens read from one pool from sharing an entry.
  expect(close).toBe(WETH_CLOSE);
});

// ── 2. The answer is checked ─────────────────────────────────────────────────

test("a WETH/USDC candle prices WETH — the recorded response reads back as ~2,460 for WETH and native ETH", async () => {
  let ohlcvCalls = 0;
  globalThis.fetch = (async (url: string) => {
    ohlcvCalls += 1;
    expect(new URL(String(url)).pathname).toContain(WETH_USDC_POOL); // pinned, never ranked
    // open/high/low deliberately unlike the close: reading the wrong column is
    // an arithmetic change this test must fail on.
    return ohlcvPage(WETH_USDC, [[midnight("2026-07-01"), 2400.11, 2502.77, 2377.04, WETH_CLOSE, 1234]], String(url));
  }) as unknown as typeof fetch;

  const assets = resolveTrackedAssets().filter((a) => a.symbol === "WETH" || a.symbol === "ETH");
  const table = await loadHistoricalPrices(assets, "2026-07-01", "2026-07-01");
  expect(table.get("WETH")!.get("2026-07-01")).toBe(WETH_CLOSE);
  expect(table.get("ETH")!.get("2026-07-01")).toBe(WETH_CLOSE); // native ETH is priced off WETH's address

  // Native ETH costs NOTHING: config gives it WETH's pricing address, so it
  // shares the cache key and reads the series WETH already paid for. Asserted
  // against WETH alone rather than against a fixed number, because what must
  // hold is that the second symbol is free — not how many pages this particular
  // one-candle pool takes to read.
  const bothCost = ohlcvCalls;
  _resetHistoricalPriceCachesForTests();
  ohlcvCalls = 0;
  await loadHistoricalPrices(
    assets.filter((a) => a.symbol === "WETH"),
    "2026-07-01",
    "2026-07-01",
  );
  expect(bothCost).toBe(ohlcvCalls);
});

test("a cbBTC candle answered for WETH is REFUSED — no ~77,621 price reaches the table", async () => {
  globalThis.fetch = (async () =>
    // The incident's own response: the pool priced its base side, cbBTC, while
    // the request named WETH.
    ohlcv(CBBTC_WETH, [[midnight("2026-07-01"), 76_000, 78_000, 75_500, CBBTC_CLOSE, 1234]])) as unknown as typeof fetch;

  const assets = resolveTrackedAssets().filter(
    (a) => a.symbol === "WETH" || a.symbol === "ETH" || a.symbol === "USDC",
  );
  const table = await loadHistoricalPrices(assets, "2026-07-01", "2026-07-01");
  // Absent, not defaulted and not approximated: the backfill fails the day it
  // cannot price rather than writing a number nobody stands behind.
  expect(table.has("WETH")).toBe(false);
  expect(table.has("ETH")).toBe(false);
  // …and the refusal costs only the symbol it concerns.
  expect(table.get("USDC")!.get("2026-07-01")).toBe(1);
  const everyPrice = [...table.values()].flatMap((days) => [...days.values()]);
  expect(everyPrice).toEqual([1]);
});

test("a response that will not say which side it priced is refused as well", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: { attributes: { ohlcv_list: [[midnight("2026-07-01"), 1, 1, 1, WETH_CLOSE, 1]] } } }),
      { status: 200 },
    )) as unknown as typeof fetch;

  // The close here is WETH's real one. It is still refused: an unattributed
  // candle cannot be SHOWN to be this token's, and being shown is the whole
  // point of naming the token in the request.
  const weth = resolveTrackedAssets().filter((a) => a.symbol === "WETH");
  const table = await loadHistoricalPrices(weth, "2026-07-01", "2026-07-01");
  expect(table.has("WETH")).toBe(false);
});

test("the buyback candle path refuses the other side of the pair rather than pricing a swap with it", async () => {
  globalThis.fetch = (async () =>
    ohlcv(CBBTC_WETH, [
      [midnight("2026-03-23"), 76_000, 78_000, 75_500, CBBTC_CLOSE, 1234],
    ])) as unknown as typeof fetch;

  // The thrown text is the only thing that reaches an operator — the caller
  // turns every failure here into the same NULL — so it has to distinguish a
  // mis-oriented pool from a pool with a thin day, naming both tokens.
  await expect(fetchGeckoDailyCloseUsd(CBBTC_WETH_POOL, WETH, midnight("2026-03-23") + 37_000)).rejects.toThrow(
    new RegExp(`asked for token ${WETH}.*priced cbBTC ${CBBTC}`),
  );
});

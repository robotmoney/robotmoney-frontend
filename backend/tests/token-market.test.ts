// The token page's GeckoTerminal reads moved from the api's request path to the
// worker (v0.6.0 release finding, 2026-10-08; migration 0115).
//
// What each test pins, and the regression it is the red control for:
//   1. The api path makes NO outbound GeckoTerminal/CoinGecko call. A fetch mock
//      fails the test on any Gecko URL; before the fix, getTokenMetrics() read
//      token_price, the pool and its candles from here and this test fails.
//   2. The worker sends the price read to the Pro host WITH the paid key header
//      when COINGECKO_API_KEY is set (chain/gecko-endpoint.ts PRO_CALLS), and
//      persists what it read.
//   3. With no key, the worker reads the keyless host and a 429 degrades as
//      before: nothing is persisted for the failed leg, and the api serves null
//      + stale:true. A failed leg keeps the last good reading.
//   4. A reading older than its bound is not served.
// Runs against the real ephemeral Postgres from tests/preload.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { getTokenMetrics, _resetTokenMetricsCacheForTests, PRICE_MAX_AGE_MS } from "../src/chain/token-metrics.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";
import { _resetGeckoEndpointForTests } from "../src/chain/gecko-endpoint.ts";
import { _resetTokenMarketForTests, sampleTokenMarket, type TokenMarketDeps } from "../src/worker/handlers/token-market.ts";
import { resolveTrackedAssets } from "../src/config.ts";

useCleanDatabase(import.meta.file);

const realFetch = globalThis.fetch;
const ENV_KEYS = ["BASE_RPC_SOURCE", "PRICE_SOURCE", "COINGECKO_API_KEY", "GECKO_PRICE_MAX_RETRIES", "GECKO_PRICE_RETRY_BASE_MS"] as const;
const saved: Record<string, string | undefined> = {};

const RM = resolveTrackedAssets().find((a) => a.symbol === "ROBOTMONEY")!.address!.toLowerCase();
const WETH = resolveTrackedAssets().find((a) => a.symbol === "WETH")!.address!.toLowerCase();

const isGecko = (u: string) => u.includes("geckoterminal.com") || u.includes("coingecko.com");

interface Seen {
  url: string;
  key: string | null;
}

// A Gecko mock: token_price answers every address (ROBOTMONEY $0.00002, WETH
// $2,500); the pool and its 30 candles answer fixed numbers. `status` forces
// every Gecko call to that HTTP status instead.
function mockGecko(opts: { status?: number } = {}): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!isGecko(url)) throw new Error(`mockGecko: unexpected non-Gecko fetch ${url}`);
    const headers = new Headers(init?.headers);
    seen.push({ url, key: headers.get("x-cg-pro-api-key") });
    if (opts.status) return new Response("{}", { status: opts.status, statusText: "Too Many Requests" });
    if (url.includes("/ohlcv/day")) {
      const candles = Array.from({ length: 30 }, (_, i) => [1_700_000_000 + i * 86_400, 1, 1, 1, 1, 2_000]);
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: candles } } }), { status: 200 });
    }
    if (url.includes("/networks/base/pools/")) {
      return new Response(JSON.stringify({ data: { attributes: { reserve_in_usd: "170000", volume_usd: { h24: "3100" } } } }), { status: 200 });
    }
    const addrs = (url.split("/token_price/")[1] ?? "").toLowerCase().split(",");
    const price = (a: string) => (a === WETH ? "2500" : a === RM ? "0.00002" : "1");
    return new Response(JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, price(a)])) } } }), { status: 200 });
  }) as typeof fetch;
  return seen;
}

async function reset() {
  _resetTokenMetricsCacheForTests();
  _resetTokenPriceCacheForTests();
  _resetGeckoEndpointForTests();
  _resetTokenMarketForTests();
  await fixtureDb`DELETE FROM token_market_samples`;
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Chain legs from the hermetic fixtures, so the only network a live price
  // source could reach is Gecko.
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "live";
  delete process.env.COINGECKO_API_KEY;
  process.env.GECKO_PRICE_MAX_RETRIES = "0";
  await reset();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await reset();
});

async function seedRow(ageMs = 0) {
  await fixtureDb`
    INSERT INTO token_market_samples
      (token, price_usd, price_at, weth_usd, weth_at, liquidity_usd, volume_24h_usd, volume_30d_usd, pool_at, sampled_at)
    VALUES ('ROBOTMONEY', 0.00003, now() - ${ageMs}::bigint * interval '1 millisecond',
            2400, now() - ${ageMs}::bigint * interval '1 millisecond',
            160000, 3000, 90000, now() - ${ageMs}::bigint * interval '1 millisecond', now())
  `;
}

test("the api path makes no GeckoTerminal call: it serves the worker's persisted reading", async () => {
  await seedRow();
  const seen = mockGecko();
  const r = await getTokenMetrics();
  expect(seen).toEqual([]);
  expect(r.robotmoney.priceUsd).toBeCloseTo(0.00003, 12);
  expect(r.robotmoney.marketCapUsd).toBeCloseTo(55_000_000_000 * 0.00003, 2);
  expect(r.market).toEqual({ liquidityUsd: 160000, volume24hUsd: 3000 });
  // Stub fee income: 30 WETH × $2,400 + 8B × $0.00003; $90,000 × 1.2% × 57%.
  expect(r.feeIncome.lifetimeUsd).toBeCloseTo(30 * 2400 + 8_000_000_000 * 0.00003, 2);
  expect(r.feeIncome.last30DaysUsd).toBeCloseTo(90_000 * 0.012 * 0.57, 2);
  expect(r.stale).toBe(false);
});

test("the api path makes no GeckoTerminal call even with nothing persisted: null + stale, as a failed read was", async () => {
  const seen = mockGecko();
  const r = await getTokenMetrics();
  expect(seen).toEqual([]);
  expect(r.robotmoney.priceUsd).toBeNull();
  expect(r.robotmoney.marketCapUsd).toBeNull();
  expect(r.market).toEqual({ liquidityUsd: null, volume24hUsd: null });
  expect(r.feeIncome.lifetimeWeth).toBe(30);
  expect(r.feeIncome.lifetimeUsd).toBeNull();
  expect(r.feeIncome.last30DaysUsd).toBeNull();
  expect(r.stale).toBe(true);
});

test("a reading older than its bound is not served", async () => {
  await seedRow(PRICE_MAX_AGE_MS + 60_000);
  mockGecko();
  const r = await getTokenMetrics();
  expect(r.robotmoney.priceUsd).toBeNull();
  expect(r.feeIncome.lifetimeUsd).toBeNull();
  // The pool's bound is longer than the prices', so it still stands.
  expect(r.market).toEqual({ liquidityUsd: 160000, volume24hUsd: 3000 });
  expect(r.stale).toBe(true);
});

test("the worker sends the price read to the Pro host with the paid key, and the api serves what it persisted", async () => {
  process.env.COINGECKO_API_KEY = "test-paid-key";
  const seen = mockGecko();
  expect(await sampleTokenMarket()).toEqual({ price: "ok", weth: "ok", pool: "ok" });

  const priceCalls = seen.filter((s) => s.url.includes("/token_price/"));
  expect(priceCalls.length).toBeGreaterThan(0);
  for (const c of priceCalls) {
    expect(c.url.startsWith("https://pro-api.coingecko.com/api/v3/onchain/")).toBe(true);
    expect(c.key).toBe("test-paid-key");
  }
  // The pool endpoints are in our plan too (gecko-endpoint.ts PRO_CALLS): the
  // Pro host, with the key.
  const poolCalls = seen.filter((s) => s.url.includes("/pools/"));
  expect(poolCalls.length).toBe(2);
  for (const c of poolCalls) {
    expect(c.url.startsWith("https://pro-api.coingecko.com/api/v3/onchain/")).toBe(true);
    expect(c.key).toBe("test-paid-key");
  }

  const [row] = await fixtureDb<{ price_usd: string; weth_usd: string; liquidity_usd: string; volume_30d_usd: string }[]>`
    SELECT price_usd, weth_usd, liquidity_usd, volume_30d_usd FROM token_market_samples WHERE token = 'ROBOTMONEY'
  `;
  expect(Number(row!.price_usd)).toBeCloseTo(0.00002, 12);
  expect(Number(row!.weth_usd)).toBe(2500);
  expect(Number(row!.liquidity_usd)).toBe(170000);
  expect(Number(row!.volume_30d_usd)).toBe(60000);

  const after = seen.length;
  const r = await getTokenMetrics();
  expect(seen.length).toBe(after);
  expect(r.robotmoney.priceUsd).toBeCloseTo(0.00002, 12);
  expect(r.market).toEqual({ liquidityUsd: 170000, volume24hUsd: 3100 });
  expect(r.stale).toBe(false);
});

test("with no key the worker reads the keyless host, and a 429 persists nothing for the failed legs", async () => {
  const seen = mockGecko({ status: 429 });
  expect(await sampleTokenMarket()).toEqual({ price: "failed", weth: "failed", pool: "failed" });
  expect(seen.length).toBeGreaterThan(0);
  for (const c of seen) {
    expect(c.url.startsWith("https://api.geckoterminal.com/api/v2/")).toBe(true);
    expect(c.key).toBeNull();
  }
  const [row] = await fixtureDb<{ price_usd: string | null; weth_usd: string | null; pool_at: Date | null }[]>`
    SELECT price_usd, weth_usd, pool_at FROM token_market_samples WHERE token = 'ROBOTMONEY'
  `;
  expect(row).toEqual({ price_usd: null, weth_usd: null, pool_at: null });
  const r = await getTokenMetrics();
  expect(r.robotmoney.priceUsd).toBeNull();
  expect(r.market).toEqual({ liquidityUsd: null, volume24hUsd: null });
  expect(r.stale).toBe(true);
});

test("a failed leg keeps the last good reading; the pool is read at most once per interval", async () => {
  let poolReads = 0;
  let failPrices = false;
  const deps: TokenMarketDeps = {
    async priceUsd(symbol) {
      if (failPrices) throw new Error("429");
      return symbol === "WETH" ? 2500 : 0.00002;
    },
    async poolStats() {
      poolReads += 1;
      return { liquidityUsd: 170000, volume24hUsd: 3100, volume30dUsd: 60000 };
    },
  };
  let clock = Date.now();
  const now = () => clock;
  expect(await sampleTokenMarket(deps, undefined, now)).toEqual({ price: "ok", weth: "ok", pool: "ok" });
  failPrices = true;
  clock += 60_000;
  expect(await sampleTokenMarket(deps, undefined, now)).toEqual({ price: "failed", weth: "failed", pool: "not-due" });
  expect(poolReads).toBe(1);
  const [row] = await fixtureDb<{ price_usd: string; weth_usd: string; liquidity_usd: string }[]>`
    SELECT price_usd, weth_usd, liquidity_usd FROM token_market_samples WHERE token = 'ROBOTMONEY'
  `;
  expect(Number(row!.price_usd)).toBeCloseTo(0.00002, 12);
  expect(Number(row!.weth_usd)).toBe(2500);
  expect(Number(row!.liquidity_usd)).toBe(170000);
  clock += 10 * 60_000;
  await sampleTokenMarket(deps, undefined, now);
  expect(poolReads).toBe(2);
});

test("under a stub price source the worker samples nothing and the api serves fixtures without a call", async () => {
  process.env.PRICE_SOURCE = "stub";
  const seen = mockGecko();
  expect(await sampleTokenMarket()).toEqual({ skipped: "stub" });
  const r = await getTokenMetrics();
  expect(seen).toEqual([]);
  expect(r.robotmoney.priceUsd).toBeCloseTo(0.00001, 12);
  expect(r.market).toEqual({ liquidityUsd: 150_000, volume24hUsd: 4_000 });
  expect(r.stale).toBe(false);
});

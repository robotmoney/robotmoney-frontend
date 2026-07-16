import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetTokenPriceCacheForTests, fetchGeckoTokenPriceUsd } from "../src/chain/token-prices.ts";

const realFetch = globalThis.fetch;
const ADDRESS = "0x4200000000000000000000000000000000000006";

function price(value: number): Response {
  return new Response(
    JSON.stringify({ data: { attributes: { token_prices: { [ADDRESS]: String(value) } } } }),
    { status: 200 },
  );
}

beforeEach(() => {
  process.env.GECKO_PRICE_RETRY_BASE_MS = "1";
  _resetTokenPriceCacheForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GECKO_PRICE_MAX_RETRIES;
  delete process.env.GECKO_PRICE_RETRY_BASE_MS;
  _resetTokenPriceCacheForTests();
});

test("a transient GeckoTerminal 429 is retried and recovers", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? new Response("limited", { status: 429, headers: { "Retry-After": "0" } }) : price(1900);
  }) as typeof fetch;

  expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1900);
  expect(calls).toBe(2);
});

test("persistent GeckoTerminal 429 exhausts bounded retries and throws", async () => {
  process.env.GECKO_PRICE_MAX_RETRIES = "2";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("limited", { status: 429 });
  }) as typeof fetch;

  await expect(fetchGeckoTokenPriceUsd(ADDRESS)).rejects.toThrow(/429/);
  expect(calls).toBe(3);
});

test("same-address concurrent and cached reads make one upstream request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return price(1900);
  }) as typeof fetch;

  expect(await Promise.all([fetchGeckoTokenPriceUsd(ADDRESS), fetchGeckoTokenPriceUsd(ADDRESS)])).toEqual([1900, 1900]);
  expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1900);
  expect(calls).toBe(1);
});

test("a hard GeckoTerminal 400 is not retried", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;

  await expect(fetchGeckoTokenPriceUsd(ADDRESS)).rejects.toThrow(/400/);
  expect(calls).toBe(1);
});

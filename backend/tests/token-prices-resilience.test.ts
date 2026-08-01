import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetTokenPriceCacheForTests, fetchGeckoTokenPriceUsd } from "../src/chain/token-prices.ts";

const realFetch = globalThis.fetch;
const ADDRESS = "0x4200000000000000000000000000000000000006"; // WETH
// Real tracked-asset addresses (config defaults) so the batch tests mirror the
// exact 3-leg fan-out the wallet sampler produces (WETH/ROBOTMONEY/BNKR).
const ROBOTMONEY = "0x65021a79aeef22b17cdc1b768f5e79a8618beba3";
const BNKR = "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b";

function price(value: number): Response {
  return new Response(
    JSON.stringify({ data: { attributes: { token_prices: { [ADDRESS]: String(value) } } } }),
    { status: 200 },
  );
}

// A batched token_price response: every entry keyed by lowercase address.
function batchPrice(prices: Record<string, number>): Response {
  const token_prices = Object.fromEntries(Object.entries(prices).map(([a, v]) => [a, String(v)]));
  return new Response(JSON.stringify({ data: { attributes: { token_prices } } }), { status: 200 });
}

beforeEach(() => {
  process.env.GECKO_PRICE_RETRY_BASE_MS = "1";
  _resetTokenPriceCacheForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GECKO_PRICE_MAX_RETRIES;
  delete process.env.GECKO_PRICE_RETRY_BASE_MS;
  delete process.env.DEMO_MODE;
  _resetTokenPriceCacheForTests();
});

test("a transient GeckoTerminal 429 is retried and recovers", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? new Response("limited", { status: 429, headers: { "Retry-After": "0" } }) : price(1900);
  }) as unknown as typeof fetch;

  expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1900);
  expect(calls).toBe(2);
});

test("persistent GeckoTerminal 429 exhausts bounded retries and throws", async () => {
  process.env.GECKO_PRICE_MAX_RETRIES = "2";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("limited", { status: 429 });
  }) as unknown as typeof fetch;

  await expect(fetchGeckoTokenPriceUsd(ADDRESS)).rejects.toThrow(/429/);
  expect(calls).toBe(3);
});

test("same-address concurrent and cached reads make one upstream request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return price(1900);
  }) as unknown as typeof fetch;

  expect(await Promise.all([fetchGeckoTokenPriceUsd(ADDRESS), fetchGeckoTokenPriceUsd(ADDRESS)])).toEqual([1900, 1900]);
  expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1900);
  expect(calls).toBe(1);
});

test("a hard GeckoTerminal 400 is not retried", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  }) as unknown as typeof fetch;

  await expect(fetchGeckoTokenPriceUsd(ADDRESS)).rejects.toThrow(/400/);
  expect(calls).toBe(1);
});

// ── micro-batching (the demo/CI per-IP quota fix — one request per burst) ────

test("concurrent distinct-address reads coalesce into ONE batched request with a sorted lowercase URL and correct per-address prices", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    await new Promise((resolve) => setTimeout(resolve, 2));
    return batchPrice({ [ADDRESS]: 1900, [ROBOTMONEY]: 0.00001, [BNKR]: 0.0005 });
  }) as unknown as typeof fetch;

  // The sampler's exact shape: a same-tick Promise.all fan-out over the legs.
  // ROBOTMONEY is passed checksummed to pin the lowercase URL normalization.
  const [weth, robot, bnkr] = await Promise.all([
    fetchGeckoTokenPriceUsd(ADDRESS),
    fetchGeckoTokenPriceUsd("0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3"),
    fetchGeckoTokenPriceUsd(BNKR),
  ]);
  expect(weth).toBe(1900);
  expect(robot).toBe(0.00001);
  expect(bnkr).toBe(0.0005);
  expect(urls).toEqual([
    // Sorted + lowercase + comma-joined: the URL (= the withFetchCache key) is
    // stable for a fixed asset set regardless of caller arrival order.
    `https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${[ADDRESS, ROBOTMONEY, BNKR].sort().join(",")}`,
  ]);
});

test("callers arriving while a request holds the serializer slot coalesce into ONE follow-up batch", async () => {
  const urls: string[] = [];
  const book: Record<string, number> = { [ADDRESS]: 1900, [ROBOTMONEY]: 0.00001, [BNKR]: 0.0005 };
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const requested = String(url).split("/token_price/")[1]!.split(",");
    return batchPrice(Object.fromEntries(requested.map((a) => [a, book[a]!])));
  }) as unknown as typeof fetch;

  const first = fetchGeckoTokenPriceUsd(ADDRESS);
  await new Promise((resolve) => setTimeout(resolve, 1)); // WETH's request now holds the slot
  const rest = Promise.all([fetchGeckoTokenPriceUsd(ROBOTMONEY), fetchGeckoTokenPriceUsd(BNKR)]);
  expect(await first).toBe(1900);
  expect(await rest).toEqual([0.00001, 0.0005]);
  expect(urls.length).toBe(2); // NOT 3: the two queued addresses shared one batch
  expect(urls[1]).toContain([ROBOTMONEY, BNKR].sort().join(","));
});

test("an address absent from a successful batch response rejects ONLY that address; the other legs resolve", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return batchPrice({ [ADDRESS]: 1900, [BNKR]: 0.0005 }); // ROBOTMONEY missing
  }) as unknown as typeof fetch;

  const [weth, robot, bnkr] = await Promise.allSettled([
    fetchGeckoTokenPriceUsd(ADDRESS),
    fetchGeckoTokenPriceUsd(ROBOTMONEY),
    fetchGeckoTokenPriceUsd(BNKR),
  ]);
  expect(calls).toBe(1);
  expect(weth).toEqual({ status: "fulfilled", value: 1900 });
  expect(bnkr).toEqual({ status: "fulfilled", value: 0.0005 });
  expect(robot.status).toBe("rejected");
  expect(String((robot as PromiseRejectedResult).reason)).toContain(`no USD price for ${ROBOTMONEY}`);
});

test("a failed batch request rejects EVERY address in it (equivalent to the old per-address failures)", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return new Response("bad request", { status: 400 });
  }) as unknown as typeof fetch;

  const results = await Promise.allSettled([
    fetchGeckoTokenPriceUsd(ADDRESS),
    fetchGeckoTokenPriceUsd(ROBOTMONEY),
    fetchGeckoTokenPriceUsd(BNKR),
  ]);
  expect(calls).toBe(1);
  for (const r of results) {
    expect(r.status).toBe("rejected");
    expect(String((r as PromiseRejectedResult).reason)).toMatch(/400/);
  }
});

// ── cache window selection (source constants, chosen by DEMO_MODE at call time) ──

test("DEMO_MODE selects the 1h demo cache window at call time: a 60s-old price is still served in demo mode but refetched in production mode", async () => {
  const realNow = Date.now;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return price(1900 + calls); // distinct price per upstream call → provenance of each serve is observable
  }) as unknown as typeof fetch;
  try {
    expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1901); // cache written at t0
    Date.now = () => realNow() + 60_000; // 60s later: PAST the 30s default window, INSIDE the 1h demo window
    process.env.DEMO_MODE = "1"; // set AFTER module load — proves call-time resolution
    expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1901); // demo window → cached, no upstream call
    expect(calls).toBe(1);
    delete process.env.DEMO_MODE;
    expect(await fetchGeckoTokenPriceUsd(ADDRESS)).toBe(1902); // production 30s window expired → refetch
    expect(calls).toBe(2);
  } finally {
    Date.now = realNow;
  }
});

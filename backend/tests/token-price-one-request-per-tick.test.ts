// Issue 1664: one wallet.sample_balances tick, which also runs the token-market
// sample (worker/handlers/index.ts), sends exactly ONE token_price request for
// every tracked Gecko-priced asset. The wallet sampler's legs coalesce into one
// batched request (chain/token-prices.ts), and the token-market sample's two
// price reads are answered by the 30-second price cache that request filled.
// Every CoinGecko credit counts against one monthly pool, so a second request
// per tick would double the spend for no new data.
//
// The REAL job runs through the real queue machinery (worker/loop.ts
// processOneJob) against a counting fetch mock; the chain reads answer
// healthily. Postgres is provisioned by tests/preload.ts, which fails loudly
// when it is absent.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { decodeAggregate3Calls, encodeAggregate3Result, type Aggregate3Result } from "../src/chain/base-rpc-client.ts";
import { _resetWalletBalancesCacheForTests } from "../src/chain/wallet-balances.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";
import { _resetGeckoEndpointForTests } from "../src/chain/gecko-endpoint.ts";
import { _resetHistoricalPriceCachesForTests } from "../src/chain/historical-prices.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { LANES } from "../src/worker/lanes.ts";
import { _resetTokenMarketForTests } from "../src/worker/handlers/token-market.ts";
import { resolveTrackedAssets } from "../src/config.ts";

useCleanDatabase(import.meta.file);

const realFetch = globalThis.fetch;
const ENV_KEYS = ["BASE_RPC_SOURCE", "PRICE_SOURCE", "COINGECKO_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

const GET_ETH_BALANCE = "0x4d2301cc";
const BALANCE_OF = "0x70a08231";
const CONVERT_TO_ASSETS = "0x07a2d13a";
const AGGREGATE3 = "0x82ad56cb";

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  delete process.env.COINGECKO_API_KEY;
  _resetTokenMarketForTests();
  _resetTokenPriceCacheForTests();
  _resetWalletBalancesCacheForTests();
  _resetGeckoEndpointForTests();
  _resetHistoricalPriceCachesForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetTokenPriceCacheForTests();
  _resetWalletBalancesCacheForTests();
});

function countingTransport(): { tokenPrice: string[]; gecko: string[] } {
  const seen = { tokenPrice: [] as string[], gecko: [] as string[] };
  const subResult = (callData: string): Aggregate3Result => {
    const sel = callData.slice(0, 10);
    if (sel === GET_ETH_BALANCE) return { success: true, returnData: word(50_000_000_000_000_000n) };
    if (sel === BALANCE_OF || sel === CONVERT_TO_ASSETS) return { success: true, returnData: word(1_000_000n) };
    throw new Error(`mock transport: unexpected sub-call selector ${sel}`);
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.includes("geckoterminal.com") || u.includes("coingecko.com")) {
      seen.gecko.push(u);
      if (u.includes("/token_price/")) {
        seen.tokenPrice.push(u);
        const addrs = (u.split("/token_price/")[1] ?? "").split("?")[0]!.split(",");
        const token_prices = Object.fromEntries(addrs.map((a) => [a, "2"]));
        return new Response(JSON.stringify({ data: { attributes: { token_prices } } }), { status: 200 });
      }
      if (u.includes("/ohlcv/day")) {
        const candles = Array.from({ length: 30 }, (_, i) => [1_700_000_000 + i * 86_400, 1, 1, 1, 1, 2_000]);
        return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: candles } } }), { status: 200 });
      }
      if (u.includes("/tokens/") && u.endsWith("/pools")) {
        return new Response(
          JSON.stringify({ data: [{ id: "base_0xpool", attributes: { address: "0xpool", reserve_in_usd: "1000", volume_usd: { h24: "100" } } }] }),
          { status: 200 },
        );
      }
      if (u.includes("/networks/base/pools/")) {
        return new Response(JSON.stringify({ data: { attributes: { reserve_in_usd: "170000", volume_usd: { h24: "3100" } } } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }
    if (u.includes("finance.yahoo.com")) return new Response("limited", { status: 429, statusText: "Too Many Requests" });
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === "eth_call") {
      const data = (body.params[0] as { data: string }).data;
      if (data.slice(0, 10) === AGGREGATE3) {
        const results = decodeAggregate3Calls(data).map((c) => subResult(c.callData));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), { status: 200 });
      }
    }
    throw new Error(`mock transport: unexpected RPC method ${body.method}`);
  }) as unknown as typeof fetch;
  return seen;
}

test("one wallet.sample_balances tick plus the token-market sample sends exactly one token_price request for every tracked Gecko-priced asset", async () => {
  await fixtureDb`DELETE FROM job_runs`;
  await fixtureDb`DELETE FROM jobs`;
  const [job] = await fixtureDb<{ id: number }[]>`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_balances', '{}', 'wallet.sample_balances:one-request-per-tick')
    RETURNING id
  `;
  const seen = countingTransport();

  expect(await processOneJob({ lane: LANES.analytics, workerId: "test-one-request-per-tick" })).toBe(true);

  const [row] = await fixtureDb<{ status: string; output: { tokenMarket?: Record<string, string> } }[]>`
    SELECT status, output FROM job_runs WHERE job_id = ${job!.id}
  `;
  expect(row!.status).toBe("succeeded");
  // The token-market sample read both its prices (from the cache) in the same tick.
  expect(row!.output.tokenMarket).toMatchObject({ price: "ok", weth: "ok" });

  expect(seen.tokenPrice.length).toBe(1);
  const priced = new Set((seen.tokenPrice[0]!.split("/token_price/")[1] ?? "").split(","));
  const geckoAssets = resolveTrackedAssets().filter((a) => a.priceKind === "gecko" && a.address);
  expect(geckoAssets.length).toBeGreaterThan(0);
  for (const a of geckoAssets) expect(priced.has(a.address!.toLowerCase())).toBe(true);
});

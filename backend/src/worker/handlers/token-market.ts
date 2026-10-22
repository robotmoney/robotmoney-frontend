// The token page's market reading, sampled on the worker's schedule (v0.6.0
// release finding, 2026-10-08; migration 0115).
//
// GET /api/dashboards/token-metrics used to read three things from GeckoTerminal
// on the api's request path: ROBOTMONEY's price, WETH's price (to value the WETH
// side of the fee income), and the token pool's liquidity and volume. The api
// holds no CoinGecko key (runbook R8.w: the key is in no api environment), so
// every one of those reads went to the keyless host and, on the stage target,
// ran out of retries on HTTP 429.
//
// This module moves the three reads to the worker, which holds the key
// (docker-compose `x-worker-env`, runbook R6.2a). It runs on the
// wallet.sample_balances tick (worker/handlers/index.ts), right after the wallet
// sampler, so the two price reads are usually answered by the 30-second price
// cache that sampler just filled (chain/token-prices.ts): no extra upstream
// call. With the key set, token_price and the pool reading (`pool` and `ohlcv`)
// go to the Pro host (chain/gecko-endpoint.ts PRO_CALLS); a 401/403 there falls
// back to the keyless host. The pool reading is read at most once every POOL_INTERVAL_MS,
// whatever the outcome, so a run of 429s costs a handful of calls an hour, never
// one per tick.
//
// Each leg is independent. A leg that fails writes nothing of its own, so the
// row keeps its last good reading with that reading's true age; the api bounds
// the age it will serve (chain/token-metrics.ts). Under PRICE_SOURCE=stub the
// api serves fixtures and never reads this table, so nothing is sampled.
// The row goes to the api (pipeline/stores/token-market.ts, issue 1034): this
// worker holds no database credential.
import { pipelineIngest } from "../pipeline-client.ts";
import type { TokenMarketReading } from "../../pipeline/stores/token-market.ts";
import { ROBOTMONEY_DOPPLER, resolvePriceSource, resolveTrackedAssets } from "../../config.ts";
import {
  fetchAssetPriceUsd,
  fetchGeckoPoolStatsUsd,
  lastGeckoPriceFailureAtMs,
  type GeckoPoolStats,
} from "../../chain/token-prices.ts";

export const TOKEN_MARKET_TOKEN = "ROBOTMONEY";

// The pool moves slowly and its endpoints share the keyless host's small
// per-IP quota, so ten minutes between attempts.
export const POOL_INTERVAL_MS = 10 * 60_000;

export interface TokenMarketDeps {
  priceUsd(symbol: "ROBOTMONEY" | "WETH"): Promise<number>;
  poolStats(): Promise<GeckoPoolStats>;
}

// A token_price request that failed this recently is not repeated here. The
// wallet sample that runs just before this one asks for the same two prices;
// when the host has just refused it, asking again a moment later only spends
// more of the quota (the #202 rule, tests/token-price-429-exhaustion-e2e.test.ts).
export const PRICE_FAILURE_HOLDOFF_MS = 60_000;

const defaultDeps: TokenMarketDeps = {
  async priceUsd(symbol) {
    const asset = resolveTrackedAssets().find((a) => a.symbol === symbol);
    if (!asset) throw new Error(`token-market: ${symbol} tracked asset not resolved`);
    const failedAt = lastGeckoPriceFailureAtMs();
    if (failedAt > 0 && Date.now() - failedAt < PRICE_FAILURE_HOLDOFF_MS) {
      throw new Error(`token-market: a token_price request failed ${Date.now() - failedAt} ms ago; not asking again this tick`);
    }
    return fetchAssetPriceUsd(asset, resolvePriceSource());
  },
  poolStats: () => fetchGeckoPoolStatsUsd(ROBOTMONEY_DOPPLER.poolId, 10_000),
};

let nextPoolReadAt = 0;

export function _resetTokenMarketForTests(): void {
  nextPoolReadAt = 0;
}

type LegOutcome = "ok" | "failed" | "not-due";

export interface TokenMarketSampleResult {
  skipped?: "stub";
  price?: LegOutcome;
  weth?: LegOutcome;
  pool?: LegOutcome;
}

async function readPrice(deps: TokenMarketDeps, symbol: "ROBOTMONEY" | "WETH"): Promise<number | null> {
  try {
    const p = await deps.priceUsd(symbol);
    if (!Number.isFinite(p) || p <= 0) throw new Error(`token-market: ${symbol} price ${p} is not a positive number`);
    return p;
  } catch (err) {
    console.error(`token-market: ${symbol} price read failed, keeping the last good reading:`, err);
    return null;
  }
}

export async function sampleTokenMarket(
  deps: TokenMarketDeps = defaultDeps,
  write: (reading: TokenMarketReading) => Promise<unknown> = (reading) => pipelineIngest("token_market.sample", reading),
  now: () => number = Date.now,
): Promise<TokenMarketSampleResult> {
  if (resolvePriceSource() === "stub") return { skipped: "stub" };

  // Together, so a cache miss costs one batched token_price request, not two.
  const [price, weth] = await Promise.all([readPrice(deps, "ROBOTMONEY"), readPrice(deps, "WETH")]);
  const priceAt = price == null ? null : new Date(now());
  const wethAt = weth == null ? null : new Date(now());

  let pool: GeckoPoolStats | null = null;
  let poolAt: Date | null = null;
  let poolOutcome: LegOutcome = "not-due";
  if (now() >= nextPoolReadAt) {
    nextPoolReadAt = now() + POOL_INTERVAL_MS;
    try {
      pool = await deps.poolStats();
      poolAt = new Date(now());
      poolOutcome = "ok";
    } catch (err) {
      console.error("token-market: pool read failed, keeping the last good reading:", err);
      poolOutcome = "failed";
    }
  }

  await write({
    token: TOKEN_MARKET_TOKEN,
    priceUsd: price,
    priceAt,
    wethUsd: weth,
    wethAt,
    liquidityUsd: pool?.liquidityUsd ?? null,
    volume24hUsd: pool?.volume24hUsd ?? null,
    volume30dUsd: pool?.volume30dUsd ?? null,
    poolAt,
  });

  return {
    price: price == null ? "failed" : "ok",
    weth: weth == null ? "failed" : "ok",
    pool: poolOutcome,
  };
}

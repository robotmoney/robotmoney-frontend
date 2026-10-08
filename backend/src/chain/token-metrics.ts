// ROBOTMONEY token-metrics feed for GET /api/dashboards/token-metrics (live-data
// contract §2). Replaces the baked price/supply/marketCap + fee-split numbers in
// the frontend allocation view.
//
// - priceUsd: the worker's last GeckoTerminal reading, from Postgres
//   (token_market_samples, migration 0115). See "No GeckoTerminal call" below.
// - totalSupply: ERC-20 totalSupply() via base-rpc-client callTotalSupply (18dp),
//   EXCEPT under a hermetic 'stub' source where — mirroring token-prices.ts's
//   STUB_PRICES — a deterministic fixture supply is served instead of routing to
//   the shared vault-shaped RPC stub (which answers the same totalSupply word for
//   every address). This keeps the hermetic smoke's marketCap sensible without a
//   live network and without a fabricated live-looking number.
// - marketCapUsd = priceUsd * totalSupply (null if either leg is null).
// - protocolHoldings, feeIncome (RM-156): the ROBOTMONEY the prop wallets hold
//   and the protocol's share of the pool's swap fees, read from Base in ONE
//   eth_call (token-fee-income.ts). Lifetime fees are exact, in the two tokens
//   fees are paid in, valued at today's prices; the last 30 days are an
//   estimate, the pool's 30-day volume × its swap fee × the protocol's share.
// - market (RM-156): the pool's liquidity and 24h volume, as GeckoTerminal
//   reads it, from the same Postgres row.
// - feeSplit: the FIXED beneficiary shares of the token's Doppler pool (Protocol
//   57 / Bankr 36.1 / Doppler 5 / Ecosystem 1.9) — static/managed, not a chain
//   read; kept in the DTO so the frontend stops baking it.
//
// No GeckoTerminal call on the request path (v0.6.0 release finding,
// 2026-10-08). The api holds no CoinGecko key (runbook R8.w), so a read from
// here went to the keyless, rate-limited host and failed on HTTP 429. The
// worker, which holds the key, reads ROBOTMONEY's price, WETH's price and the
// pool on the wallet.sample_balances tick and upserts them into
// token_market_samples (worker/handlers/token-market.ts). This module reads
// that one row. A leg the worker has never read, or last read longer ago than
// its MAX_AGE, is null + stale:true here, as a failed live read was before.
// Supply and fee income are Base RPC reads and stay on the request path.
//
// Honesty (#50): a failed supply or price leg degrades that field to null +
// stale:true — never a fabricated price. 'stub' payloads are never labelled live.
import {
  config,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolveTrackedAssets,
  type BaseRpcSource,
} from "../config.ts";
import { callTotalSupply, type RpcCallOptions } from "./base-rpc-client.ts";
import { readTokenFeeIncome, type TokenFeeIncomeRead } from "./token-fee-income.ts";
import { fetchAssetPriceUsd, type GeckoPoolStats } from "./token-prices.ts";
import { ttlCached } from "./ttl-cache.ts";
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";

const WEI_18 = 1e18;

// Hermetic fixture supply (18dp normalized token count). Recognizable magnitude
// (55B ROBOTMONEY) so the smoke's marketCap is reproducible without a live read.
const STUB_TOTAL_SUPPLY = 55_000_000_000;

// Hermetic fixtures for the RM-156 legs, on the same terms: recognizable,
// stable, and never served under a live source.
const STUB_FEE_INCOME: TokenFeeIncomeRead = {
  lifetimeWeth: 30,
  lifetimeRobotmoney: 8_000_000_000,
  protocolShare: 0.57,
  swapFee: 0.012,
  protocolHeld: 7_000_000_000,
};
const STUB_POOL: GeckoPoolStats = { liquidityUsd: 150_000, volume24hUsd: 4_000, volume30dUsd: 120_000 };

// How old a worker reading may be and still be served. The prices are read
// every minute and the pool every ten (worker/handlers/token-market.ts), so
// these allow several missed reads before a leg goes null.
export const PRICE_MAX_AGE_MS = 15 * 60_000;
export const POOL_MAX_AGE_MS = 45 * 60_000;

const MARKET_TOKEN = "ROBOTMONEY";

const readMarketRow = registerQuery({
  role: "rm_app",
  object: "token_market_samples",
  privileges: ["SELECT"],
  site: "src/chain/token-metrics:readTokenMarket",
  purpose: "Read the worker's last market reading for the token page (prices and pool), with each leg's age.",
  callers: ["src/api/routes/dashboards", "src/projects/entities-projections"],
  probe: {
    statement: `SELECT price_usd, weth_usd, liquidity_usd, volume_24h_usd, volume_30d_usd,
        (price_at > now() - $2::bigint * interval '1 millisecond') AS price_fresh,
        (weth_at > now() - $2::bigint * interval '1 millisecond') AS weth_fresh,
        (pool_at > now() - $3::bigint * interval '1 millisecond') AS pool_fresh
      FROM token_market_samples WHERE token = $1`,
    params: [MARKET_TOKEN, PRICE_MAX_AGE_MS, POOL_MAX_AGE_MS],
  },
});

export interface TokenMarketReading {
  priceUsd: number | null;
  wethUsd: number | null;
  pool: GeckoPoolStats | null;
}

const numOrNull = (v: string | null): number | null => (v == null ? null : Number(v));

// The worker's last reading, each leg null when absent or older than its bound.
// The age is judged by Postgres's clock, the clock that stamped it. Throws only
// when Postgres does; the caller degrades.
export async function readTokenMarket(): Promise<TokenMarketReading> {
  const [row] = await on(sql, readMarketRow)<{
    price_usd: string | null;
    weth_usd: string | null;
    liquidity_usd: string | null;
    volume_24h_usd: string | null;
    volume_30d_usd: string | null;
    price_fresh: boolean | null;
    weth_fresh: boolean | null;
    pool_fresh: boolean | null;
  }>`
    SELECT price_usd, weth_usd, liquidity_usd, volume_24h_usd, volume_30d_usd,
        (price_at > now() - ${PRICE_MAX_AGE_MS}::bigint * interval '1 millisecond') AS price_fresh,
        (weth_at > now() - ${PRICE_MAX_AGE_MS}::bigint * interval '1 millisecond') AS weth_fresh,
        (pool_at > now() - ${POOL_MAX_AGE_MS}::bigint * interval '1 millisecond') AS pool_fresh
      FROM token_market_samples WHERE token = ${MARKET_TOKEN}
  `;
  if (!row) return { priceUsd: null, wethUsd: null, pool: null };
  return {
    priceUsd: row.price_fresh ? numOrNull(row.price_usd) : null,
    wethUsd: row.weth_fresh ? numOrNull(row.weth_usd) : null,
    pool: row.pool_fresh
      ? { liquidityUsd: numOrNull(row.liquidity_usd), volume24hUsd: numOrNull(row.volume_24h_usd), volume30dUsd: numOrNull(row.volume_30d_usd) }
      : null,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// Fixed fee split. Static config, NOT a chain read. $ROBOTMONEY launched through
// Bankr on Doppler, not Clanker: the pool's swap fees are shared by the
// beneficiaries stored at launch in Doppler's locker (DecayMulticurveInitializer
// 0xd59ce43e53d69f190e15d9822fb4540dccc91178, getShares(poolId, beneficiary)).
// Protocol is the primary prop wallet, Bankr is the launch's integrator, Doppler
// is its protocol owner, and Ecosystem is the leg Bankr reserved at launch.
// `bun scripts/token-fees.ts` reads the live shares.
const FEE_SPLIT: { label: string; pct: number }[] = [
  { label: "Protocol", pct: 57 },
  { label: "Bankr", pct: 36.1 },
  { label: "Doppler", pct: 5 },
  { label: "Ecosystem", pct: 1.9 },
];

export interface TokenMetrics {
  robotmoney: {
    priceUsd: number | null;
    totalSupply: number | null;
    marketCapUsd: number | null;
  };
  feeSplit: { label: string; pct: number }[];
  // RM-156. The ROBOTMONEY the protocol's own wallets hold.
  protocolHoldings: { robotmoney: number | null; pctOfSupply: number | null };
  // The token's pool, as GeckoTerminal reads it.
  market: { liquidityUsd: number | null; volume24hUsd: number | null };
  // The protocol's share of the pool's swap fees: exact since launch, in WETH
  // and ROBOTMONEY with their value at today's prices, and an estimate for the
  // last 30 days.
  feeIncome: { lifetimeWeth: number | null; lifetimeRobotmoney: number | null; lifetimeUsd: number | null; last30DaysUsd: number | null };
  asOf: string;
  source: BaseRpcSource;
  stale: boolean;
}

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

const CACHE_TTL_MS = 30_000;

// The three GeckoTerminal-derived values. Under a stub price source they are
// the hermetic fixtures (no network, no database); otherwise the worker's row.
async function marketReading(stub: boolean): Promise<TokenMarketReading> {
  if (!stub) return readTokenMarket();
  const rm = resolveTrackedAssets().find((a) => a.symbol === "ROBOTMONEY");
  const weth = resolveTrackedAssets().find((a) => a.symbol === "WETH");
  if (!rm || !weth) throw new Error("token-metrics: ROBOTMONEY or WETH tracked asset not resolved");
  return { priceUsd: await fetchAssetPriceUsd(rm, "stub"), wethUsd: await fetchAssetPriceUsd(weth, "stub"), pool: STUB_POOL };
}

async function computeTokenMetrics(): Promise<TokenMetrics> {
  const now = Date.now();

  // Resolved per call (not module load) so provenance tracks the current env.
  // Fail-closed resolvers stay OUTSIDE the leg try/catches below: an invalid
  // marker must refuse loudly, never degrade into a payload claiming 'live'.
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();

  let stale = false;

  // Supply leg. Stub source serves the fixture (see file header); live source
  // reads on-chain and degrades to null + stale on failure.
  let totalSupply: number | null;
  if (source === "stub") {
    totalSupply = STUB_TOTAL_SUPPLY;
  } else {
    try {
      totalSupply = Number(await callTotalSupply(config.robotmoney, rpcOpts())) / WEI_18;
    } catch (err) {
      console.error("token-metrics: totalSupply read failed, degrading to null:", err);
      totalSupply = null;
      stale = true;
    }
  }

  // Price, WETH price and pool legs: one Postgres read (see file header).
  let market: TokenMarketReading;
  try {
    market = await marketReading(priceSource === "stub");
  } catch (err) {
    console.error("token-metrics: market reading failed, degrading prices and pool to null:", err);
    market = { priceUsd: null, wethUsd: null, pool: null };
  }
  const { priceUsd, pool } = market;
  if (priceUsd == null || pool == null) stale = true;

  const marketCapUsd =
    priceUsd != null && totalSupply != null ? Math.round(priceUsd * totalSupply * 100) / 100 : null;

  // Fee income + holdings leg: one eth_call on the chain source.
  let income: TokenFeeIncomeRead | null;
  if (source === "stub") {
    income = STUB_FEE_INCOME;
  } else {
    try {
      income = await readTokenFeeIncome(config.robotmoney, rpcOpts());
    } catch (err) {
      console.error("token-metrics: fee income read failed, degrading to null:", err);
      income = null;
      stale = true;
    }
  }

  // WETH's price values the WETH side of the fees; it only matters when there is one.
  const wethUsd = income ? market.wethUsd : null;
  if (income && wethUsd == null) stale = true;

  const lifetimeUsd =
    income && wethUsd != null && priceUsd != null
      ? round2(income.lifetimeWeth * wethUsd + income.lifetimeRobotmoney * priceUsd)
      : null;
  const last30DaysUsd =
    income && pool?.volume30dUsd != null ? round2(pool.volume30dUsd * income.swapFee * income.protocolShare) : null;

  return {
    robotmoney: { priceUsd, totalSupply, marketCapUsd },
    feeSplit: FEE_SPLIT,
    protocolHoldings: {
      robotmoney: income ? income.protocolHeld : null,
      pctOfSupply: income && totalSupply ? round2((income.protocolHeld / totalSupply) * 100) : null,
    },
    market: { liquidityUsd: pool?.liquidityUsd ?? null, volume24hUsd: pool?.volume24hUsd ?? null },
    feeIncome: {
      lifetimeWeth: income ? income.lifetimeWeth : null,
      lifetimeRobotmoney: income ? income.lifetimeRobotmoney : null,
      lifetimeUsd,
      last30DaysUsd,
    },
    asOf: new Date(now).toISOString(),
    source,
    stale,
  };
}

export const getTokenMetrics = ttlCached(computeTokenMetrics, CACHE_TTL_MS);

export function _resetTokenMetricsCacheForTests(): void {
  getTokenMetrics._resetForTests();
}

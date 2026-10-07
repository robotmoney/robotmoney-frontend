// ROBOTMONEY token-metrics feed for GET /api/dashboards/token-metrics (live-data
// contract §2). Replaces the baked price/supply/marketCap + fee-split numbers in
// the frontend allocation view.
//
// - priceUsd: keyless GeckoTerminal spot via token-prices.ts (the same vendor +
//   hermetic-stub path as wallet-balances), pinned per priceKind.
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
//   reads it, cached ten minutes.
// - feeSplit: the FIXED beneficiary shares of the token's Doppler pool (Protocol
//   57 / Bankr 36.1 / Doppler 5 / Ecosystem 1.9) — static/managed, not a chain
//   read; kept in the DTO so the frontend stops baking it.
//
// Honesty (#50): a failed supply or price leg degrades that field to null +
// stale:true — never a fabricated price. 'stub' payloads are never labelled live.
import {
  config,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolveTrackedAssets,
  ROBOTMONEY_DOPPLER,
  type BaseRpcSource,
} from "../config.ts";
import { callTotalSupply, type RpcCallOptions } from "./base-rpc-client.ts";
import { readTokenFeeIncome, type TokenFeeIncomeRead } from "./token-fee-income.ts";
import { fetchAssetPriceUsd, fetchGeckoPoolStatsUsd, type GeckoPoolStats } from "./token-prices.ts";
import { ttlCached } from "./ttl-cache.ts";

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

// The pool's market moves slowly, and GeckoTerminal's keyless tier is shared
// with every price read: ten minutes keeps this to a handful of calls an hour.
// A failed read is not cached (ttlCached), so the next request tries again.
const POOL_TTL_MS = 10 * 60_000;
const readPoolStats = ttlCached(() => fetchGeckoPoolStatsUsd(ROBOTMONEY_DOPPLER.poolId), POOL_TTL_MS);

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

async function computeTokenMetrics(): Promise<TokenMetrics> {
  const now = Date.now();

  // Resolved per call (not module load) so provenance tracks the current env.
  // Fail-closed resolvers stay OUTSIDE the leg try/catches below: an invalid
  // marker must refuse loudly, never degrade into a payload claiming 'live'.
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const rmAsset = resolveTrackedAssets().find((a) => a.symbol === "ROBOTMONEY");

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

  // Price leg. Reuses the shared keyless price path (pinned/stub/gecko).
  let priceUsd: number | null;
  try {
    if (!rmAsset) throw new Error("token-metrics: ROBOTMONEY tracked asset not resolved");
    priceUsd = await fetchAssetPriceUsd(rmAsset, priceSource);
  } catch (err) {
    console.error("token-metrics: price read failed, degrading to null:", err);
    priceUsd = null;
    stale = true;
  }

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

  // Pool leg: GeckoTerminal, on the price source like the price leg.
  let pool: GeckoPoolStats | null;
  if (priceSource === "stub") {
    pool = STUB_POOL;
  } else {
    try {
      pool = await readPoolStats();
    } catch (err) {
      console.error("token-metrics: pool read failed, degrading to null:", err);
      pool = null;
      stale = true;
    }
  }

  // WETH's price values the WETH side of the fees; only read when there is one.
  let wethUsd: number | null = null;
  if (income) {
    try {
      const weth = resolveTrackedAssets().find((a) => a.symbol === "WETH");
      if (!weth) throw new Error("token-metrics: WETH tracked asset not resolved");
      wethUsd = await fetchAssetPriceUsd(weth, priceSource);
    } catch (err) {
      console.error("token-metrics: WETH price read failed, degrading the fees' USD value to null:", err);
      stale = true;
    }
  }

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
  readPoolStats._resetForTests();
}

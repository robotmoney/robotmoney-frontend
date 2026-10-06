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
  type BaseRpcSource,
} from "../config.ts";
import { callTotalSupply, type RpcCallOptions } from "./base-rpc-client.ts";
import { fetchAssetPriceUsd } from "./token-prices.ts";
import { ttlCached } from "./ttl-cache.ts";

const WEI_18 = 1e18;

// Hermetic fixture supply (18dp normalized token count). Recognizable magnitude
// (55B ROBOTMONEY) so the smoke's marketCap is reproducible without a live read.
const STUB_TOTAL_SUPPLY = 55_000_000_000;

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

  return {
    robotmoney: { priceUsd, totalSupply, marketCapUsd },
    feeSplit: FEE_SPLIT,
    asOf: new Date(now).toISOString(),
    source,
    stale,
  };
}

export const getTokenMetrics = ttlCached(computeTokenMetrics, CACHE_TTL_MS);

export function _resetTokenMetricsCacheForTests(): void {
  getTokenMetrics._resetForTests();
}

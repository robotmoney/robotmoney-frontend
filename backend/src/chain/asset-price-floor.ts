// Per-symbol first-priceable-day floor (D41; docs/decisions.md;
// docs/technical/markets-asset-pricing-ingest.md §5.6 point 2, §8.1).
//
// WHAT IT ANSWERS. "What is the earliest UTC day asset_prices could ever hold a
// row for this symbol?" ROBOTMONEY and BNKR have inception dates and their
// pools carry no candles before them — without this floor, dense per-symbol
// gap detection would report every day back to the series start as a
// permanent, unfillable gap, exactly the noisy-report problem `expectedKeys`
// was built to solve on the amounts side (markets §8.1).
//
// A `usdc` priceKind (USDC, ZYFAI-SS1, GIZA-SS1) is pinned $1 and costs no
// request: it is priceable from the day it was tracked
// (`TrackedAsset.deployedAt`), full stop.
//
// A `gecko` priceKind's floor is a VENDOR fact, not a config one.
// `fetchDailyCloses` (chain/historical-prices.ts) already folds `oldestSec`
// and `floorProven` across every page it reads, so the FIRST wide range call
// for a pool reports the floor as a side effect of reading candles it would
// read anyway. `floorProven` distinguishes "the vendor's own paging proved
// nothing older exists" from "paging merely stopped at one of its own
// bounds" — only the former is safe to persist as permanent. An unproven
// result is never cached, so the next attempt tries again rather than
// freezing a partial answer.
//
// WHY THE CACHE IS PERMANENT, LIKE chain_address_floors. A pool's first traded
// day never moves backward once proven, so it is resolved once and reused
// forever — a second repair pass over a symbol already proven costs zero
// OHLCV requests for this purpose. The store is injected
// (`AssetPriceFloorCache`) rather than imported so this module stays a pure
// chain module, exactly as address-floor-resolver.ts's `AddressFloorCache`
// does; ops/asset-prices.ts supplies the Postgres-backed one.
import type { TrackedAsset } from "../config.ts";
import { pinnedPoolForToken } from "../config.ts";
import { fetchDailyCloses, resolvePoolForToken, type DailyCloseWindow } from "./historical-prices.ts";

export interface AssetPriceFloor {
  symbol: string;
  /** Earliest UTC calendar day this symbol could ever have a price row for. */
  firstPriceableDate: string;
  /** Whether the vendor's own paging proved nothing older exists. A `false`
   *  floor here is a `usdc`-priceKind config floor, always proven by
   *  construction (a pin has no vendor history to run out of). */
  proven: boolean;
}

/** Permanent store for resolved floors. `get` returning null means "not
 *  resolved (or not proven) yet"; there is no expiry, by construction. */
export interface AssetPriceFloorCache {
  get(symbol: string): Promise<AssetPriceFloor | null>;
  set(floor: AssetPriceFloor): Promise<void>;
}

/** A cache that stores nothing — correct answers at full request cost, for a
 *  caller (e.g. a test) that does not want persistence. */
export const nullAssetPriceFloorCache: AssetPriceFloorCache = {
  async get() {
    return null;
  },
  async set() {},
};

// How far back the one wide floor-discovery request reaches. Base mainnet
// launched in 2023; going back to 2015 costs nothing extra (fetchDailyCloses
// pages until an EMPTY response proves the floor, not until this date is
// reached) and needs no maintenance as the chain ages.
const FLOOR_DISCOVERY_FROM_DATE = "2015-01-01";

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDay(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export interface ResolveAssetPriceFloorDeps {
  fetchCloses(poolKey: string, tokenAddress: string, fromDate: string, toDate: string): Promise<DailyCloseWindow>;
  resolvePool(tokenAddress: string): Promise<string>;
}

export const defaultResolveAssetPriceFloorDeps: ResolveAssetPriceFloorDeps = {
  fetchCloses: (poolKey, tokenAddress, fromDate, toDate) => fetchDailyCloses(poolKey, tokenAddress, fromDate, toDate),
  resolvePool: (tokenAddress) => resolvePoolForToken(tokenAddress),
};

/** Resolve one asset's floor. `usdc`/`yahoo` priceKinds never touch the
 *  network — a `yahoo` asset (SP500) has no floor at all here, because it is
 *  never part of the price series (markets §3.2, §5.6); callers should not
 *  ask this function about one. */
export async function resolveAssetPriceFloor(
  asset: TrackedAsset,
  cache: AssetPriceFloorCache = nullAssetPriceFloorCache,
  deps: ResolveAssetPriceFloorDeps = defaultResolveAssetPriceFloorDeps,
): Promise<AssetPriceFloor | null> {
  if (asset.priceKind === "yahoo") return null;
  if (asset.priceKind === "usdc") {
    const floor: AssetPriceFloor = { symbol: asset.symbol, firstPriceableDate: asset.deployedAt, proven: true };
    await cache.set(floor);
    return floor;
  }
  const hit = await cache.get(asset.symbol);
  if (hit && hit.proven) return hit;

  if (!asset.address) return null;
  const poolKey = pinnedPoolForToken(asset.address) ?? (await deps.resolvePool(asset.address));
  const read = await deps.fetchCloses(poolKey, asset.address, FLOOR_DISCOVERY_FROM_DATE, utcToday());
  if (read.oldestSec === null) return null; // no candle at all yet — nothing to persist
  const floor: AssetPriceFloor = { symbol: asset.symbol, firstPriceableDate: isoDay(read.oldestSec), proven: read.floorProven };
  if (floor.proven) await cache.set(floor);
  return floor;
}

/** Resolve every priceable asset's floor (skips `yahoo`/SP500). Cache hits for
 *  already-`proven` symbols cost no request at all. */
export async function resolveAssetPriceFloors(
  assets: readonly TrackedAsset[],
  cache: AssetPriceFloorCache = nullAssetPriceFloorCache,
  deps: ResolveAssetPriceFloorDeps = defaultResolveAssetPriceFloorDeps,
): Promise<Map<string, AssetPriceFloor>> {
  const out = new Map<string, AssetPriceFloor>();
  for (const asset of assets) {
    if (asset.priceKind === "yahoo") continue;
    const floor = await resolveAssetPriceFloor(asset, cache, deps);
    if (floor) out.set(asset.symbol, floor);
  }
  return out;
}

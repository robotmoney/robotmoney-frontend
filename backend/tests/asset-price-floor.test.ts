// Per-symbol first-priceable-day floor (D41; issue #849;
// docs/technical/markets-asset-pricing-ingest.md §5.6 point 2, §8.1). Fully
// offline: `fetchCloses`/`resolvePool` are injected fixtures, exactly the
// shape backend/tests/address-floor-resolver.test.ts uses for its chain
// fixture — every assertion is about the ALGORITHM (proven vs. unproven,
// the permanent cache, the usdc/gecko split), never a live vendor.
//
// RED CONTROL: none of this module existed before #849 — the whole file
// fails to import against the pre-change tree.
import { expect, test } from "bun:test";
import {
  nullAssetPriceFloorCache,
  resolveAssetPriceFloor,
  resolveAssetPriceFloors,
  type AssetPriceFloor,
  type AssetPriceFloorCache,
  type ResolveAssetPriceFloorDeps,
} from "../src/chain/asset-price-floor.ts";
import type { TrackedAsset } from "../src/config.ts";

function usdcAsset(symbol: string, deployedAt: string): TrackedAsset {
  return {
    symbol,
    group: "Stable",
    color: "#10b981",
    valuationKind: "erc20",
    priceKind: "usdc",
    decimals: 6,
    address: "0xusdc",
    poolId: null,
    deployedAt,
  };
}

function geckoAsset(symbol: string, address: string, deployedAt = "2026-03-18"): TrackedAsset {
  return {
    symbol,
    group: "Protocol",
    color: "#f59e0b",
    valuationKind: "erc20",
    priceKind: "gecko",
    decimals: 18,
    address,
    poolId: null,
    deployedAt,
  };
}

function yahooAsset(symbol: string): TrackedAsset {
  return {
    symbol,
    group: "Stocks",
    color: "#8b5cf6",
    valuationKind: "config",
    priceKind: "yahoo",
    decimals: 0,
    address: null,
    poolId: null,
    deployedAt: "2026-05-01",
  };
}

function memoryCache(): AssetPriceFloorCache {
  const store = new Map<string, AssetPriceFloor>();
  return {
    async get(symbol) {
      return store.get(symbol) ?? null;
    },
    async set(floor) {
      store.set(floor.symbol, floor);
    },
  };
}

/** A pool fixture whose candles run from `oldest` to `newest`, proving the
 *  floor only when `proven` is true — mirrors historical-prices.ts's own
 *  `floorProven` contract (an empty page, or paging past the request's start,
 *  proves nothing older exists; stopping at one of the request's own bounds
 *  proves nothing). */
function fixturePool(oldestSec: number | null, proven: boolean, calls: string[]): ResolveAssetPriceFloorDeps {
  return {
    async fetchCloses(poolKey, tokenAddress) {
      calls.push(`${poolKey}:${tokenAddress}`);
      return { closes: new Map(), oldestSec, newestSec: oldestSec, floorProven: proven };
    },
    async resolvePool() {
      throw new Error("no pin configured for this fixture — resolvePool should not be reached");
    },
  };
}

test("a usdc-priced asset is priceable from its config deployedAt — proven, no network", async () => {
  const calls: string[] = [];
  const deps: ResolveAssetPriceFloorDeps = {
    async fetchCloses() {
      calls.push("fetchCloses");
      return { closes: new Map(), oldestSec: null, newestSec: null, floorProven: false };
    },
    async resolvePool() {
      calls.push("resolvePool");
      return "0xpool";
    },
  };
  const floor = await resolveAssetPriceFloor(usdcAsset("USDC", "2026-03-18"), nullAssetPriceFloorCache, deps);
  expect(floor).toEqual({ symbol: "USDC", firstPriceableDate: "2026-03-18", proven: true });
  expect(calls).toEqual([]);
});

test("SP500 (yahoo priceKind) never gets a floor — it is not part of the price series", async () => {
  const floor = await resolveAssetPriceFloor(yahooAsset("SP500"));
  expect(floor).toBeNull();
});

test("a gecko-priced asset's floor is the vendor's oldest PROVEN candle day, persisted", async () => {
  const cache = memoryCache();
  const calls: string[] = [];
  const oldestSec = Date.parse("2026-01-05T00:00:00Z") / 1000;
  const deps = fixturePool(oldestSec, true, calls);
  const asset = { ...geckoAsset("ROBOTMONEY", "0xrobot"), poolId: null };
  const floor = await resolveAssetPriceFloor(asset, cache, {
    ...deps,
    async resolvePool(address) {
      calls.push(`resolvePool:${address}`);
      return "0xpool";
    },
  });
  expect(floor).toEqual({ symbol: "ROBOTMONEY", firstPriceableDate: "2026-01-05", proven: true });
  expect(await cache.get("ROBOTMONEY")).toEqual(floor);
  expect(calls).toEqual(["resolvePool:0xrobot", "0xpool:0xrobot"]);
});

test("an UNPROVEN result is never cached — the next attempt tries again", async () => {
  const cache = memoryCache();
  const calls: string[] = [];
  const oldestSec = Date.parse("2026-01-05T00:00:00Z") / 1000;
  const deps: ResolveAssetPriceFloorDeps = {
    ...fixturePool(oldestSec, false, calls),
    async resolvePool() {
      return "0xpool";
    },
  };
  const asset = geckoAsset("ROBOTMONEY", "0xrobot");
  const floor = await resolveAssetPriceFloor(asset, cache, deps);
  expect(floor).toEqual({ symbol: "ROBOTMONEY", firstPriceableDate: "2026-01-05", proven: false });
  expect(await cache.get("ROBOTMONEY")).toBeNull();
});

test("a proven cache hit costs zero requests — resolved once, reused forever", async () => {
  const cache = memoryCache();
  await cache.set({ symbol: "ROBOTMONEY", firstPriceableDate: "2026-01-05", proven: true });
  const deps: ResolveAssetPriceFloorDeps = {
    async fetchCloses() {
      throw new Error("must not be called for an already-proven symbol");
    },
    async resolvePool() {
      throw new Error("must not be called for an already-proven symbol");
    },
  };
  const floor = await resolveAssetPriceFloor(geckoAsset("ROBOTMONEY", "0xrobot"), cache, deps);
  expect(floor).toEqual({ symbol: "ROBOTMONEY", firstPriceableDate: "2026-01-05", proven: true });
});

test("no candle at all yet resolves to null rather than a fabricated floor", async () => {
  const calls: string[] = [];
  const deps: ResolveAssetPriceFloorDeps = {
    ...fixturePool(null, false, calls),
    async resolvePool() {
      return "0xpool";
    },
  };
  const floor = await resolveAssetPriceFloor(geckoAsset("BNKR", "0xbnkr"), nullAssetPriceFloorCache, deps);
  expect(floor).toBeNull();
});

test("resolveAssetPriceFloors skips yahoo (SP500) and collects every other resolvable floor", async () => {
  const calls: string[] = [];
  const oldestSec = Date.parse("2026-01-05T00:00:00Z") / 1000;
  const deps: ResolveAssetPriceFloorDeps = {
    ...fixturePool(oldestSec, true, calls),
    async resolvePool() {
      return "0xpool";
    },
  };
  const assets = [usdcAsset("USDC", "2026-03-18"), geckoAsset("ROBOTMONEY", "0xrobot"), yahooAsset("SP500")];
  const floors = await resolveAssetPriceFloors(assets, nullAssetPriceFloorCache, deps);
  expect([...floors.keys()].sort()).toEqual(["ROBOTMONEY", "USDC"]);
  expect(floors.get("USDC")).toEqual({ symbol: "USDC", firstPriceableDate: "2026-03-18", proven: true });
});

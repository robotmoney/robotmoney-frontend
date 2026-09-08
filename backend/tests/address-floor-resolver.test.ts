// Per-address earliest-valid-block floor (issue #760;
// docs/technical/markets-asset-pricing-ingest.md §6.1, §8.1). Fully offline:
// the chain is a deterministic fixture (a fixed deployment block, code present
// from there onward) injected through ResolveAddressFloorDeps, so every
// assertion is about the ALGORITHM — the exact boundary, the probe budget, the
// permanent cache, and the refusal to trust an address with no code anywhere.
//
// RED CONTROL: none of this module existed before #760 — the whole file fails
// to import against the pre-change tree, and `eth_getCode` had no wrapper in
// base-rpc-client.ts at all.
import { expect, test } from "bun:test";
import {
  ADDRESS_FLOOR_CALL_BUDGET,
  nullAddressFloorCache,
  resolveAddressFloor,
  resolveAddressFloors,
  type AddressFloorCache,
  type ResolveAddressFloorDeps,
} from "../src/chain/address-floor-resolver.ts";

const OPTS = { rpcUrl: "https://mainnet.base.org" };
const HEAD = 20_000_000;
const ADDR = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** A fixture contract deployed at `deployedAt`: no code before it, code from it
 *  onward, all the way to HEAD. */
function fixtureContract(deployedAt: number): { deps: ResolveAddressFloorDeps; probes: number[] } {
  const probes: number[] = [];
  return {
    probes,
    deps: {
      async latestBlockNumber() {
        return HEAD;
      },
      async hasCodeAt(_address, blockNumber) {
        probes.push(blockNumber);
        return blockNumber >= deployedAt;
      },
    },
  };
}

function memoryCache(): AddressFloorCache {
  const store = new Map<string, number>();
  return {
    async get(address) {
      return store.get(address) ?? null;
    },
    async set(address, floorBlock) {
      store.set(address, floorBlock);
    },
  };
}

test("finds the exact deployment block — the boundary property holds precisely", async () => {
  for (const deployedAt of [0, 1, 12_345, 9_999_999, HEAD]) {
    const { deps } = fixtureContract(deployedAt);
    const result = await resolveAddressFloor(ADDR, OPTS, nullAddressFloorCache, deps);
    expect(result.floorBlock).toBe(deployedAt);
    expect(result.cached).toBe(false);
  }
});

test("stays within the probe budget on a 20M-block chain (O(log n))", async () => {
  const { deps, probes } = fixtureContract(4_200_000);
  const result = await resolveAddressFloor(ADDR, OPTS, nullAddressFloorCache, deps);
  expect(result.rpcCalls).toBeLessThanOrEqual(ADDRESS_FLOOR_CALL_BUDGET);
  expect(probes.length).toBeLessThanOrEqual(ADDRESS_FLOOR_CALL_BUDGET);
  // log2(20_000_000) ≈ 25 — well under the 64-probe budget, proving this is
  // genuinely a search, not a linear scan.
  expect(probes.length).toBeLessThan(30);
});

test("an address with no code even at the chain head THROWS rather than guessing", async () => {
  const deps: ResolveAddressFloorDeps = {
    async latestBlockNumber() {
      return HEAD;
    },
    async hasCodeAt() {
      return false;
    },
  };
  await expect(resolveAddressFloor(ADDR, OPTS, nullAddressFloorCache, deps)).rejects.toThrow(/no code even at the chain head/);
});

test("the floor is cached PERMANENTLY — a second resolution costs zero probes", async () => {
  const cache = memoryCache();
  const { deps, probes } = fixtureContract(7_500_000);
  const first = await resolveAddressFloor(ADDR, OPTS, cache, deps);
  expect(first.floorBlock).toBe(7_500_000);
  expect(first.cached).toBe(false);
  const probesAfterFirst = probes.length;
  expect(probesAfterFirst).toBeGreaterThan(0);

  const second = await resolveAddressFloor(ADDR, OPTS, cache, deps);
  expect(second.floorBlock).toBe(7_500_000);
  expect(second.cached).toBe(true);
  expect(second.rpcCalls).toBe(0);
  expect(probes.length).toBe(probesAfterFirst); // no new probes at all
});

test("resolveAddressFloors shares ONE head read across every cache miss", async () => {
  let headReads = 0;
  const codeByAddress: Record<string, number> = { "0xaaa": 1_000_000, "0xbbb": 2_000_000, "0xccc": 500_000 };
  const deps: ResolveAddressFloorDeps = {
    async latestBlockNumber() {
      headReads += 1;
      return HEAD;
    },
    async hasCodeAt(address, blockNumber) {
      return blockNumber >= codeByAddress[address]!;
    },
  };
  const floors = await resolveAddressFloors(Object.keys(codeByAddress), OPTS, nullAddressFloorCache, deps);
  for (const [address, floorBlock] of Object.entries(codeByAddress)) {
    expect(floors.get(address)?.floorBlock).toBe(floorBlock);
  }
  expect(headReads).toBe(1); // ONE head read for three addresses, not three
});

test("resolveAddressFloors: a cache hit for every address costs zero head reads", async () => {
  let headReads = 0;
  const cache = memoryCache();
  await cache.set("0xaaa", 1_234);
  const deps: ResolveAddressFloorDeps = {
    async latestBlockNumber() {
      headReads += 1;
      return HEAD;
    },
    async hasCodeAt() {
      throw new Error("must not probe — the address is already cached");
    },
  };
  const floors = await resolveAddressFloors(["0xaaa"], OPTS, cache, deps);
  expect(floors.get("0xaaa")?.floorBlock).toBe(1_234);
  expect(floors.get("0xaaa")?.cached).toBe(true);
  expect(headReads).toBe(0);
});

test("resolveAddressFloors deduplicates repeated addresses", async () => {
  let probes = 0;
  const deps: ResolveAddressFloorDeps = {
    async latestBlockNumber() {
      return HEAD;
    },
    async hasCodeAt(_address, blockNumber) {
      probes += 1;
      return blockNumber >= 100;
    },
  };
  const floors = await resolveAddressFloors(["0xaaa", "0xaaa", "0xaaa"], OPTS, nullAddressFloorCache, deps);
  expect(floors.size).toBe(1);
  expect(floors.get("0xaaa")?.floorBlock).toBe(100);
  // One binary search's worth of probes, not three.
  expect(probes).toBeLessThan(30);
});

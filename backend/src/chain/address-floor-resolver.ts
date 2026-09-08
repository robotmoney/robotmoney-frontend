// Per-address earliest-valid-block floor (issue #760;
// docs/technical/markets-asset-pricing-ingest.md §6.1, §8.1).
//
// WHAT IT ANSWERS. "At what block did this address FIRST have code?" That is a
// CHAIN fact, distinct from `TrackedAsset.deployedAt` (config.ts), which is the
// calendar day an asset was first TRACKED — a CONFIGURATION fact that can
// predate, postdate, or (today, coincidentally) equal the block at which its
// contract actually got code. §6.1's silent-zero rail already proves that
// `success:true && returnData:"0x"` on a block-addressed read means "no
// contract here yet", never a zero — this module is what lets a caller know
// that BEFORE issuing the read and burning a retry attempt to relearn it, by
// giving the caller the exact block below which the answer is already known.
//
// HOW IT SEARCHES. `eth_getCode` is monotonic in one direction over a
// contract's lifetime: absent before deployment, present from the deployment
// block onward (a `SELFDESTRUCT` could violate that in principle, but no
// tracked asset here is expected to self-destruct and re-deploy at the same
// address). A standard binary search over that monotonic boundary finds the
// exact deployment block in O(log latest) probes — comfortably under
// ADDRESS_FLOOR_CALL_BUDGET even at Base's tens-of-millions block height.
// Exceeding the budget THROWS rather than guessing, the same discipline
// block-resolver.ts's RESOLVER_CALL_BUDGET uses for date resolution.
//
// WHY THE CACHE IS PERMANENT. A contract's deployment block never changes:
// the answer for an address is the same forever, so it is resolved ONCE and
// cached FOREVER (chain_address_floors, migration 0045) — a second backfill
// run, or a run over a different window, costs zero resolver calls for an
// address already known. The store is injected (`AddressFloorCache`) rather
// than imported so this module stays a pure chain module, exactly as
// block-resolver.ts's `DayBlockCache` does — ops/wallet-backfill.ts supplies
// the Postgres-backed one.
//
// EVERY READ HERE GOES THROUGH base-rpc-client.ts, so it shares the one RPC
// rate budget with the live sampler and the day resolver. This module never
// constructs a limiter of its own.
import { ethBlockNumber, ethGetCode, isEmptyReturnData, toBlockTag, type RpcCallOptions } from "./base-rpc-client.ts";

/** Hard per-address ceiling on `eth_getCode` probes. Base's block height is in
 *  the tens of millions, so log2(latest) is comfortably under this; it exists
 *  so a wrong assumption (an address with no code even at the chain head)
 *  fails loudly instead of looping. Resolved once, an address never pays this
 *  cost again — see the cache above. */
export const ADDRESS_FLOOR_CALL_BUDGET = 64;

export interface AddressFloor {
  address: string;
  /** First block at which `address` has on-chain code. */
  floorBlock: number;
  /** How many eth_getCode probes this resolution cost (0 on a cache hit). */
  rpcCalls: number;
  /** Whether the answer came from the permanent cache. */
  cached: boolean;
}

/** Permanent store for resolved floors. `get` returning null simply means "not
 *  resolved yet"; there is no expiry, by construction (see the header). */
export interface AddressFloorCache {
  get(address: string): Promise<number | null>;
  set(address: string, floorBlock: number): Promise<void>;
}

/** A cache that stores nothing — the default, so a caller that does not want
 *  persistence (e.g. a test) still gets correct answers, at full RPC cost. */
export const nullAddressFloorCache: AddressFloorCache = {
  async get() {
    return null;
  },
  async set() {},
};

export interface ResolveAddressFloorDeps {
  latestBlockNumber(opts: RpcCallOptions): Promise<number>;
  hasCodeAt(address: string, blockNumber: number, opts: RpcCallOptions): Promise<boolean>;
}

export const defaultResolveAddressFloorDeps: ResolveAddressFloorDeps = {
  latestBlockNumber: (opts) => ethBlockNumber(opts),
  async hasCodeAt(address, blockNumber, opts) {
    const code = await ethGetCode(address, toBlockTag(blockNumber), opts);
    return !isEmptyReturnData(code);
  },
};

/**
 * Resolve the first block at which `address` has on-chain code.
 *
 * `latestBlockNumber`, when supplied, saves the caller an extra head read when
 * it already has one in hand (see resolveAddressFloors below, which shares
 * ONE head read across every address it resolves in a pass, the same way
 * block-resolver.ts's resolveDayBlocks shares one head read across days).
 * Omitted, this function fetches its own.
 *
 * An address with no code even at the chain head THROWS rather than returning
 * a fabricated floor — callers only ask this for addresses they are actively
 * tracking (config.ts's TrackedAsset.address), which are deployed by
 * definition; an address that fails that check is a configuration mistake,
 * not a day this module can silently absorb.
 */
export async function resolveAddressFloor(
  address: string,
  opts: RpcCallOptions,
  cache: AddressFloorCache = nullAddressFloorCache,
  deps: ResolveAddressFloorDeps = defaultResolveAddressFloorDeps,
  latestBlockNumber?: number,
): Promise<AddressFloor> {
  const hit = await cache.get(address);
  if (hit !== null && Number.isSafeInteger(hit) && hit >= 0) {
    return { address, floorBlock: hit, rpcCalls: 0, cached: true };
  }

  let calls = 0;
  const hasCode = async (n: number): Promise<boolean> => {
    if (calls >= ADDRESS_FLOOR_CALL_BUDGET) {
      throw new Error(
        `address-floor-resolver: ${address} exceeded the ${ADDRESS_FLOOR_CALL_BUDGET}-probe budget without bracketing its deployment block`,
      );
    }
    calls += 1;
    return deps.hasCodeAt(address, n, opts);
  };

  let latest = latestBlockNumber;
  if (latest === undefined) {
    calls += 1;
    latest = await deps.latestBlockNumber(opts);
  }

  if (!(await hasCode(latest))) {
    throw new Error(`address-floor-resolver: ${address} has no code even at the chain head (block ${latest})`);
  }

  // Standard "first true" binary search over a monotone false…false,true…true
  // boundary: low converges on the smallest block at which hasCode is true.
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (await hasCode(mid)) high = mid;
    else low = mid + 1;
  }

  await cache.set(address, low);
  return { address, floorBlock: low, rpcCalls: calls, cached: false };
}

/**
 * Resolve MANY addresses' floors, sharing ONE `latest` head read across every
 * cache miss — the same sharing resolveDayBlocks (block-resolver.ts) applies
 * across days, applied here across addresses instead. Cache hits cost nothing
 * and never trigger the head read at all.
 */
export async function resolveAddressFloors(
  addresses: readonly string[],
  opts: RpcCallOptions,
  cache: AddressFloorCache = nullAddressFloorCache,
  deps: ResolveAddressFloorDeps = defaultResolveAddressFloorDeps,
): Promise<Map<string, AddressFloor>> {
  const unique = [...new Set(addresses)];
  const out = new Map<string, AddressFloor>();
  const misses: string[] = [];
  for (const address of unique) {
    const hit = await cache.get(address);
    if (hit !== null && Number.isSafeInteger(hit) && hit >= 0) {
      out.set(address, { address, floorBlock: hit, rpcCalls: 0, cached: true });
    } else {
      misses.push(address);
    }
  }
  if (misses.length === 0) return out;

  const latest = await deps.latestBlockNumber(opts);
  for (const address of misses) {
    out.set(address, await resolveAddressFloor(address, opts, cache, deps, latest));
  }
  return out;
}

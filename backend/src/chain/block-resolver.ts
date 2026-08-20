// date → block resolution for block-addressed chain reads (issue #709,
// docs/technical/data-self-healing.md §6.5.1).
//
// WHAT IT ANSWERS. "Which block do I read to see the state of UTC day D?" The
// answer this module gives is THE LAST BLOCK OF DAY D — the block with the
// greatest number whose timestamp is strictly before D+1T00:00:00Z. That is the
// day's CLOSING state, which is the honest analogue of what the live sampler
// writes: `wallet.sample_balances` runs every minute and its last run of the day
// is the value the (sample_date, symbol) row ends up holding. Resolving to the
// day's OPENING block instead would silently publish a different measurement
// under the same key.
//
// WHY IT IS CHEAP. Base produces blocks on a fixed 2-second cadence, so a
// proportional estimate from `latest` lands within about one block and a short
// bracketing walk finishes the job. The budget is ≤8 `eth_getBlockByNumber`
// calls per day (RESOLVER_CALL_BUDGET); exceeding it THROWS rather than
// returning a nearby-but-unverified block, because a wrong block is a wrong
// balance under a right-looking date.
//
// WHY THE CACHE IS PERMANENT. A past UTC midnight's block is immutable: the
// answer for 2026-07-04 is the same forever. So a resolved day is cached
// FOREVER, not for a TTL, and a second run over the same window costs zero
// resolver calls. The store is injected (`DayBlockCache`) rather than imported
// so this module stays a pure chain module — ops/wallet-backfill.ts supplies the
// Postgres-backed one (`chain_day_blocks`, migration 0033).
//
// EVERY READ HERE GOES THROUGH base-rpc-client.ts, so it shares the one RPC rate
// budget with the live sampler (see that file's token-bucket section). This
// module never constructs a limiter of its own.
import { ethBlockNumber, ethGetBlockByNumber, type RpcCallOptions } from "./base-rpc-client.ts";

/** Base's fixed block cadence. Used only to ESTIMATE a starting probe — every
 *  returned block is verified against real timestamps, so a cadence change
 *  costs extra probes, never a wrong answer. */
export const BASE_BLOCK_TIME_SEC = 2;

/** Hard per-day ceiling on `eth_getBlockByNumber` probes. Plan A's arithmetic
 *  put the expected cost at ~1-3; 8 is the budget at which we stop and fail
 *  loudly instead of guessing. */
export const RESOLVER_CALL_BUDGET = 8;

export interface ResolvedDayBlock {
  /** ISO calendar day (UTC) this block closes. */
  date: string;
  /** The last block of that day. */
  blockNumber: number;
  /** That block's own timestamp, unix seconds. */
  blockTimestampSec: number;
  /** How many RPC probes this resolution cost (0 on a cache hit). */
  rpcCalls: number;
  /** Whether the answer came from the permanent cache. */
  cached: boolean;
}

/** Permanent store for resolved days. `get` returning null simply means "not
 *  resolved yet"; there is no expiry, by construction (see the header). */
export interface DayBlockCache {
  get(date: string): Promise<{ blockNumber: number; blockTimestampSec: number } | null>;
  set(date: string, blockNumber: number, blockTimestampSec: number): Promise<void>;
}

/** A cache that stores nothing — the default, so a caller that does not want
 *  persistence still gets correct answers (at full RPC cost). */
export const nullDayBlockCache: DayBlockCache = {
  async get() {
    return null;
  },
  async set() {},
};

function assertIsoDay(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`block-resolver: not an ISO calendar day: ${date}`);
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`block-resolver: unparseable date: ${date}`);
}

/** Exclusive upper bound of UTC day `date`, in unix seconds: midnight opening
 *  the NEXT day. The resolved block's timestamp must be strictly below it. */
export function dayEndExclusiveSec(date: string): number {
  assertIsoDay(date);
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + 86_400;
}

interface BlockStamp {
  number: number;
  timestampSec: number;
}

export interface ResolveDayBlockDeps {
  latestBlockNumber(opts: RpcCallOptions): Promise<number>;
  blockAt(blockNumber: number, opts: RpcCallOptions): Promise<BlockStamp>;
}

export const defaultResolveDayBlockDeps: ResolveDayBlockDeps = {
  latestBlockNumber: (opts) => ethBlockNumber(opts),
  async blockAt(blockNumber, opts) {
    const b = await ethGetBlockByNumber(blockNumber, opts);
    return { number: parseInt(b.number, 16), timestampSec: parseInt(b.timestamp, 16) };
  },
};

/**
 * Resolve UTC day `date` to the last block of that day.
 *
 * Refuses a day that is not fully closed: `now` must be at or past the day's
 * exclusive end. A day still in progress has no "last block" yet, and reading
 * one anyway would write a partial day under a key the live sampler is still
 * updating.
 */
export async function resolveDayBlock(
  date: string,
  opts: RpcCallOptions,
  cache: DayBlockCache = nullDayBlockCache,
  deps: ResolveDayBlockDeps = defaultResolveDayBlockDeps,
  now: Date = new Date(),
): Promise<ResolvedDayBlock> {
  const endSec = dayEndExclusiveSec(date);
  if (Math.floor(now.getTime() / 1000) < endSec) {
    throw new Error(`block-resolver: ${date} has not closed yet — refusing to resolve a block for an open day`);
  }

  const hit = await cache.get(date);
  if (hit) {
    return { date, blockNumber: hit.blockNumber, blockTimestampSec: hit.blockTimestampSec, rpcCalls: 0, cached: true };
  }

  // The target instant is the LAST moment of the day; we want the greatest
  // block strictly below the next day's midnight.
  const targetSec = endSec - 1;

  let calls = 0;
  const probe = async (n: number): Promise<BlockStamp> => {
    if (calls >= RESOLVER_CALL_BUDGET) {
      throw new Error(
        `block-resolver: ${date} exceeded the ${RESOLVER_CALL_BUDGET}-probe budget without bracketing the day boundary`,
      );
    }
    calls += 1;
    return deps.blockAt(n, opts);
  };

  const latestNumber = await deps.latestBlockNumber(opts);
  calls += 1; // eth_blockNumber is charged against the same budget
  let current = await probe(latestNumber);
  if (current.timestampSec <= targetSec) {
    throw new Error(
      `block-resolver: ${date} is not in the chain's past (head block ${current.number} is at or before the day's end)`,
    );
  }

  // Proportional correction with a SELF-CORRECTING cadence estimate. The first
  // step uses Base's nominal 2s; every subsequent step uses the rate actually
  // observed between the last two probes. That matters because the 2s constant
  // is Plan A's arithmetic, not a guarantee — and a resolver that trusts a wrong
  // constant does not fail, it lands on the wrong day and writes a plausible
  // balance under a right-looking date. Measuring instead of assuming converges
  // on any linear cadence in about three probes.
  let secPerBlock = BASE_BLOCK_TIME_SEC;
  for (let i = 0; i < 4; i++) {
    const driftSec = targetSec - current.timestampSec;
    const step = Math.trunc(driftSec / secPerBlock);
    if (step === 0) break;
    const next = Math.min(latestNumber, Math.max(0, current.number + step));
    if (next === current.number) break;
    const previous = current;
    current = await probe(next);
    const spanBlocks = previous.number - current.number;
    if (spanBlocks !== 0) {
      const observed = (previous.timestampSec - current.timestampSec) / spanBlocks;
      if (observed > 0) secPerBlock = observed;
    }
  }

  // Bracket exactly: walk back while we are past the boundary, then forward
  // while the NEXT block is still inside the day. Both walks are bounded by the
  // probe budget, so a cadence surprise fails loudly instead of drifting.
  while (current.timestampSec > targetSec) {
    if (current.number === 0) throw new Error(`block-resolver: ${date} precedes the chain's genesis block`);
    current = await probe(current.number - 1);
  }
  for (;;) {
    if (current.number >= latestNumber) break;
    const ahead = await probe(current.number + 1);
    if (ahead.timestampSec > targetSec) break;
    current = ahead;
  }

  await cache.set(date, current.number, current.timestampSec);
  return { date, blockNumber: current.number, blockTimestampSec: current.timestampSec, rpcCalls: calls, cached: false };
}

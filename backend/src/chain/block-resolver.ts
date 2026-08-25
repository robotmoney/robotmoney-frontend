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
import {
  ethBlockNumber,
  ethGetBlockByNumber,
  ethGetBlockByNumberBatch,
  type RpcCallOptions,
} from "./base-rpc-client.ts";

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
  /** Canonical hash of the closing block. */
  blockHash: string;
  /** That block's own timestamp, unix seconds. */
  blockTimestampSec: number;
  /** The immediately following block, which proves the UTC boundary. */
  boundaryNextBlockNumber: number;
  boundaryNextBlockHash: string;
  boundaryNextBlockTimestampSec: number;
  /** How many RPC probes this resolution cost (0 on a cache hit). */
  rpcCalls: number;
  /** Whether the answer came from the permanent cache. */
  cached: boolean;
}

export interface CachedDayBlockProof {
  blockNumber: number;
  blockHash: string | null;
  blockTimestampSec: number;
  boundaryNextBlockNumber: number | null;
  boundaryNextBlockHash: string | null;
  boundaryNextBlockTimestampSec: number | null;
}

type CompleteDayBlockProof = {
  blockNumber: number;
  blockHash: string;
  blockTimestampSec: number;
  boundaryNextBlockNumber: number;
  boundaryNextBlockHash: string;
  boundaryNextBlockTimestampSec: number;
};

/** Permanent store for resolved days. `get` returning null simply means "not
 *  resolved yet"; there is no expiry, by construction (see the header). */
export interface DayBlockCache {
  get(date: string): Promise<CachedDayBlockProof | null>;
  set(date: string, proof: CachedDayBlockProof): Promise<void>;
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
  hash: string;
  timestampSec: number;
}

function blockNumberMismatch(requested: number, stamp: BlockStamp): string | null {
  return stamp.number === requested
    ? null
    : `block-resolver: requested block ${requested} but RPC returned block ${stamp.number}`;
}

export interface ResolveDayBlockDeps {
  latestBlockNumber(opts: RpcCallOptions): Promise<number>;
  blockAt(blockNumber: number, opts: RpcCallOptions): Promise<BlockStamp>;
}

export const defaultResolveDayBlockDeps: ResolveDayBlockDeps = {
  latestBlockNumber: (opts) => ethBlockNumber(opts),
  async blockAt(blockNumber, opts) {
    const b = await ethGetBlockByNumber(blockNumber, opts);
    if (typeof b.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) {
      throw new Error(`block-resolver: block ${blockNumber} has no canonical hash`);
    }
    return { number: parseInt(b.number, 16), hash: b.hash, timestampSec: parseInt(b.timestamp, 16) };
  },
};

function completeCachedProof(date: string, hit: CachedDayBlockProof): ResolvedDayBlock | null {
  const endSec = dayEndExclusiveSec(date);
  if (
    !Number.isSafeInteger(hit.blockNumber)
    || !Number.isSafeInteger(hit.boundaryNextBlockNumber)
    || hit.boundaryNextBlockNumber !== hit.blockNumber + 1
    || typeof hit.blockHash !== "string"
    || !/^0x[0-9a-fA-F]{64}$/.test(hit.blockHash)
    || typeof hit.boundaryNextBlockHash !== "string"
    || !/^0x[0-9a-fA-F]{64}$/.test(hit.boundaryNextBlockHash)
    || !Number.isFinite(hit.blockTimestampSec)
    || typeof hit.boundaryNextBlockTimestampSec !== "number"
    || !Number.isFinite(hit.boundaryNextBlockTimestampSec)
    || hit.blockTimestampSec >= endSec
    || hit.boundaryNextBlockTimestampSec < endSec
  ) return null;
  return {
    date,
    blockNumber: hit.blockNumber,
    blockHash: hit.blockHash,
    blockTimestampSec: hit.blockTimestampSec,
    boundaryNextBlockNumber: hit.boundaryNextBlockNumber,
    boundaryNextBlockHash: hit.boundaryNextBlockHash,
    boundaryNextBlockTimestampSec: hit.boundaryNextBlockTimestampSec,
    rpcCalls: 0,
    cached: true,
  };
}

function cacheProof(closing: BlockStamp, boundaryNext: BlockStamp): CompleteDayBlockProof {
  return {
    blockNumber: closing.number,
    blockHash: closing.hash,
    blockTimestampSec: closing.timestampSec,
    boundaryNextBlockNumber: boundaryNext.number,
    boundaryNextBlockHash: boundaryNext.hash,
    boundaryNextBlockTimestampSec: boundaryNext.timestampSec,
  };
}

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
    const complete = completeCachedProof(date, hit);
    if (complete) return complete;
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
    const stamp = await deps.blockAt(n, opts);
    const mismatch = blockNumberMismatch(n, stamp);
    if (mismatch) throw new Error(mismatch);
    return stamp;
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
  let boundaryNext: BlockStamp | null = null;
  for (;;) {
    if (current.number >= latestNumber) break;
    const ahead = await probe(current.number + 1);
    if (ahead.timestampSec > targetSec) {
      boundaryNext = ahead;
      break;
    }
    current = ahead;
  }

  if (!boundaryNext) throw new Error(`block-resolver: ${date} could not prove the first block after UTC midnight`);
  const proof = cacheProof(current, boundaryNext);
  await cache.set(date, proof);
  return { date, ...proof, rpcCalls: calls, cached: false };
}

// ── Resolving MANY days in lockstep (the batched path) ───────────────────────
//
// WHY THIS EXISTS. resolveDayBlock above is cheap in RPC CALLS (~3-8 probes),
// but the provider meters HTTP HITS and that function spends one hit per probe.
// A ten-day repair run therefore paid ~50 hits to LOCATE ten blocks — roughly
// 80% of the run's entire budget — before reading a single balance.
//
// The searches are sequentially dependent WITHIN a day (each probe's target is
// computed from the previous probe's timestamp) but completely INDEPENDENT
// ACROSS days. So they run in LOCKSTEP: every active day contributes one probe
// to a round, the round goes out as ONE batched POST, and each day advances its
// own state from its own answer. Sequential depth stays ~3-8 ROUNDS no matter
// how many days are resolving — ten days cost about what one day costs.
//
// WHAT IS DELIBERATELY UNCHANGED. Every returned block is still VERIFIED against
// real timestamps and still has the bracket property asserted, with the same
// self-correcting cadence estimate. Base's fixed 2s slots make a UTC day almost
// exactly 43200 blocks, and it is tempting to derive a neighbour arithmetically
// from a cached day — but this module's header says why that is not enough on
// its own: "a resolver that trusts a wrong constant does not fail, it lands on
// the wrong day and writes a plausible balance under a right-looking date."
// Arithmetic may pick a better STARTING PROBE; it may never be the answer.
//
// PER-DAY FAILURE, NOT PER-BATCH. A day that exhausts its probe budget, or whose
// probe errors, fails ALONE — the same contract rpcBatchRequest and aggregate3's
// allowFailure establish. One unresolvable day must not cost a window nine good
// ones.

/** One probe's answer, or why it could not be had. Shaped like BatchResult so
 *  failure reads the same way everywhere in the chain layer. */
export type BlockProbe = { ok: true; stamp: BlockStamp } | { ok: false; error: string };

export interface ResolveDayBlocksDeps {
  latestBlockNumber(opts: RpcCallOptions): Promise<number>;
  /** MANY headers in one hit, positionally aligned with `blockNumbers`. */
  blocksAt(blockNumbers: readonly number[], opts: RpcCallOptions): Promise<BlockProbe[]>;
}

export const defaultResolveDayBlocksDeps: ResolveDayBlocksDeps = {
  latestBlockNumber: (opts) => ethBlockNumber(opts),
  async blocksAt(blockNumbers, opts) {
    const res = await ethGetBlockByNumberBatch(blockNumbers, opts);
    return res.map((r) => {
      if (!r.ok) return { ok: false as const, error: r.error.message };
      if (typeof r.result.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.result.hash)) {
        return { ok: false as const, error: "block-resolver: block has no canonical hash" };
      }
      return {
        ok: true as const,
        stamp: {
          number: parseInt(r.result.number, 16),
          hash: r.result.hash,
          timestampSec: parseInt(r.result.timestamp, 16),
        },
      };
    });
  },
};

/** `shared: true` marks a failure that belongs to the WINDOW, not to this day —
 *  the one head read every day in the window depends on. The caller uses it to
 *  decide whether the day has earned an attempt against its own retry ceiling;
 *  see deferDay() in ops/wallet-backfill.ts. */
export type DayBlockOutcome =
  | ({ ok: true } & ResolvedDayBlock)
  | { ok: false; date: string; error: string; shared?: boolean };

/** Per-day search state while the lockstep loop runs. */
interface DaySearch {
  date: string;
  targetSec: number;
  current: BlockStamp;
  boundaryNext: BlockStamp | null;
  secPerBlock: number;
  calls: number;
  /** 'estimate' → proportional convergence; 'back'/'forward' → exact bracketing. */
  phase: "estimate" | "back" | "forward" | "done";
  estimateSteps: number;
  failed: string | null;
}

/**
 * Resolve MANY UTC days to their last blocks in as few HTTP hits as the
 * searches' sequential depth allows.
 *
 * Cache hits cost nothing and never enter the loop. Everything else runs the
 * same algorithm resolveDayBlock does, one ROUND at a time across all
 * outstanding days. Results are positionally aligned with `dates`.
 */
export async function resolveDayBlocks(
  dates: readonly string[],
  opts: RpcCallOptions,
  cache: DayBlockCache = nullDayBlockCache,
  deps: ResolveDayBlocksDeps = defaultResolveDayBlocksDeps,
  now: Date = new Date(),
): Promise<DayBlockOutcome[]> {
  const out = new Map<string, DayBlockOutcome>();
  const unresolved: string[] = [];
  const nowSec = Math.floor(now.getTime() / 1000);

  for (const date of dates) {
    try {
      assertIsoDay(date);
    } catch (err) {
      out.set(date, { ok: false, date, error: String(err) });
      continue;
    }
    if (nowSec < dayEndExclusiveSec(date)) {
      out.set(date, {
        ok: false,
        date,
        error: `block-resolver: ${date} has not closed yet — refusing to resolve a block for an open day`,
      });
      continue;
    }
    const hit = await cache.get(date);
    if (hit) {
      const complete = completeCachedProof(date, hit);
      if (complete) {
        out.set(date, { ok: true, ...complete });
        continue;
      }
    }
    unresolved.push(date);
  }

  if (unresolved.length > 0) {
    // ONE head read for the whole window, not one per day. Sharing the head is
    // also what makes the first probe round a single hit.
    const latestNumber = await deps.latestBlockNumber(opts);
    const headProbe = (await deps.blocksAt([latestNumber], opts))[0];

    const headMismatch = headProbe?.ok ? blockNumberMismatch(latestNumber, headProbe.stamp) : null;
    if (!headProbe || !headProbe.ok || headMismatch) {
      const error = headMismatch
        ?? `block-resolver: could not read head block ${latestNumber}${headProbe && !headProbe.ok ? ` — ${headProbe.error}` : ""}`;
      // ONE head read backs every unresolved day, so its failure is the window's
      // and not any day's. Flagged so the caller does not charge ten retry
      // ceilings for one transient.
      for (const date of unresolved) out.set(date, { ok: false, date, error, shared: true });
    } else {
      const head = headProbe.stamp;
      const searches: DaySearch[] = [];
      for (const date of unresolved) {
        const targetSec = dayEndExclusiveSec(date) - 1;
        if (head.timestampSec <= targetSec) {
          out.set(date, {
            ok: false,
            date,
            error: `block-resolver: ${date} is not in the chain's past (head block ${head.number} is at or before the day's end)`,
          });
          continue;
        }
        // The shared head read is charged to every day that uses it, exactly as
        // the single-day resolver charges its own eth_blockNumber + head probe.
        searches.push({
          date,
          targetSec,
          current: head,
          boundaryNext: null,
          secPerBlock: BASE_BLOCK_TIME_SEC,
          calls: 2,
          phase: "estimate",
          estimateSteps: 0,
          failed: null,
        });
      }

      // ── The lockstep loop: one batched round per iteration. ────────────────
      for (;;) {
        const targets: number[] = [];
        const probing: DaySearch[] = [];
        for (const s of searches) {
          if (s.phase === "done" || s.failed !== null) continue;
          const next = nextProbeFor(s, latestNumber);
          if (next === null) continue; // settled without needing another probe
          if (s.calls >= RESOLVER_CALL_BUDGET) {
            s.failed = `block-resolver: ${s.date} exceeded the ${RESOLVER_CALL_BUDGET}-probe budget without bracketing the day boundary`;
            continue;
          }
          s.calls += 1;
          targets.push(next);
          probing.push(s);
        }
        if (targets.length === 0) break;

        const probes = await deps.blocksAt(targets, opts);
        for (let i = 0; i < probing.length; i++) {
          const s = probing[i]!;
          const p = probes[i];
          if (!p || !p.ok) {
            s.failed = `block-resolver: ${s.date} probe of block ${targets[i]} failed${p && !p.ok ? ` — ${p.error}` : ""}`;
            continue;
          }
          const mismatch = blockNumberMismatch(targets[i]!, p.stamp);
          if (mismatch) {
            s.failed = `${mismatch} while resolving ${s.date}`;
            continue;
          }
          advance(s, p.stamp, latestNumber);
        }
      }

      for (const s of searches) {
        if (s.failed !== null) {
          out.set(s.date, { ok: false, date: s.date, error: s.failed });
          continue;
        }
        if (!s.boundaryNext) {
          out.set(s.date, {
            ok: false,
            date: s.date,
            error: `block-resolver: ${s.date} could not prove the first block after UTC midnight`,
          });
          continue;
        }
        const proof = cacheProof(s.current, s.boundaryNext);
        await cache.set(s.date, proof);
        out.set(s.date, {
          ok: true,
          date: s.date,
          ...proof,
          rpcCalls: s.calls,
          cached: false,
        });
      }
    }
  }

  return dates.map((d) => out.get(d) ?? { ok: false, date: d, error: `block-resolver: ${d} produced no outcome` });
}

/** The next block this day wants to look at, or null when its phase has nothing
 *  left to ask. Kept separate from `advance` so the state machine reads in one
 *  place rather than being spread through the loop. */
function nextProbeFor(s: DaySearch, latestNumber: number): number | null {
  if (s.phase === "estimate") {
    const driftSec = s.targetSec - s.current.timestampSec;
    const step = Math.trunc(driftSec / s.secPerBlock);
    const next = Math.min(latestNumber, Math.max(0, s.current.number + step));
    if (step === 0 || next === s.current.number || s.estimateSteps >= 4) {
      s.phase = s.current.timestampSec > s.targetSec ? "back" : "forward";
      return nextProbeFor(s, latestNumber);
    }
    s.estimateSteps += 1;
    return next;
  }
  if (s.phase === "back") {
    if (s.current.timestampSec <= s.targetSec) {
      s.phase = "forward";
      return nextProbeFor(s, latestNumber);
    }
    if (s.current.number === 0) {
      s.failed = `block-resolver: ${s.date} precedes the chain's genesis block`;
      s.phase = "done";
      return null;
    }
    return s.current.number - 1;
  }
  if (s.phase === "forward") {
    if (s.current.number >= latestNumber) {
      s.phase = "done";
      return null;
    }
    return s.current.number + 1;
  }
  return null;
}

/** Fold one probe answer into a day's state, mirroring resolveDayBlock's own
 *  transitions: the cadence estimate is re-measured from the observed span, and
 *  each walk stops on the same condition. */
function advance(s: DaySearch, stamp: BlockStamp, latestNumber: number): void {
  if (s.phase === "estimate") {
    const previous = s.current;
    s.current = stamp;
    const spanBlocks = previous.number - stamp.number;
    if (spanBlocks !== 0) {
      const observed = (previous.timestampSec - stamp.timestampSec) / spanBlocks;
      if (observed > 0) s.secPerBlock = observed;
    }
    return;
  }
  if (s.phase === "back") {
    s.current = stamp;
    if (s.current.timestampSec <= s.targetSec) s.phase = "forward";
    return;
  }
  if (s.phase === "forward") {
    // The probe is the block AHEAD. It becomes `current` only while it is still
    // inside the day; the first block past the boundary ENDS the walk and is
    // discarded, which is what leaves `current` as the day's LAST block.
    if (stamp.timestampSec > s.targetSec) {
      s.boundaryNext = stamp;
      s.phase = "done";
      return;
    }
    s.current = stamp;
    if (s.current.number >= latestNumber) s.phase = "done";
  }
}

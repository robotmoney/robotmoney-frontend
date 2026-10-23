// The buyback indexer (live-data contract §1), run by the pipeline worker as the
// `buybacks.refresh` job. Refreshes buyback_swaps from Base via eth_getLogs
// (see the section header below). The read path is the api's
// (chain/buyback-logs.ts getBuybacks).
//
// THE DATABASE STEPS ARE THE API'S (issue 1034, D75). The worker holds no
// database credential: it reads the scan state and records each scanned window
// (its swaps and the advanced cursor, in one transaction) through
// `BuybackIndexStore`, by default the api's pipeline operations
// (pipeline/stores/buybacks.ts).
import {
  config,
  resolveBuybackConfig,
  WETH_USDC_POOL,
  BUYBACK_LOG_CHUNK,
  BUYBACK_MAX_CHUNKS,
} from "../config.ts";
import {
  BaseRpcHttpError,
  decodeUint256,
  encodeAddressArg,
  ethBlockNumber,
  ethGetBlockByNumber,
  ethGetBlockByNumberBatch,
  ethGetLogs,
  rpcBatchRequest,
  type EthGetLogsParams,
  type EthLog,
  type RpcCallOptions,
} from "./base-rpc-client.ts";
import { fetchGeckoDailyCloseUsd } from "./token-prices.ts";
import { pipelineIngest, pipelineRead } from "../worker/pipeline-client.ts";
import { pipelineChunks } from "../lib/pipeline-wire.ts";

// keccak256("Transfer(address,address,uint256)") — the standard ERC-20 Transfer
// event topic0 (widely published; not computed here).
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const WEI_18 = 1e18;

/** One decoded live swap, as the indexer persists it. */
export interface BuybackSwapRow {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  occurredOn: string;
  wethSpent: number;
  valueUsd: number | null;
  robotmoneyReceived: number;
}

/** The indexer's two database steps. */
export interface BuybackIndexStore {
  /** The durable last-scanned block, and the highest already-indexed live block. */
  scanState(): Promise<{ cursor: number | null; persistedMax: number | null }>;
  /** Insert `swaps` (idempotent on tx_hash) and, when given, advance the cursor to `scannedTo`; returns rows inserted. */
  recordWindow(swaps: readonly BuybackSwapRow[], scannedTo: number | null): Promise<number>;
}

/** The store, through the api (pipeline/ops.ts `buybacks.*`). */
export const pipelineBuybackIndexStore: BuybackIndexStore = {
  scanState: () => pipelineRead<{ cursor: number | null; persistedMax: number | null }>("buybacks.scan_state"),
  recordWindow: (swaps, scannedTo) => pipelineIngest<number>("buybacks.record_window", [...swaps], scannedTo),
};

// --- Live indexer (worker/handlers/buybacks.ts) ------------------------------
// Refreshes buyback_swaps from Base via eth_getLogs: ROBOTMONEY Transfer events
// INTO the primary prop wallet, joined to the paired WETH-out leg for the input
// amount, priced via GeckoTerminal for the USD value AT THE SWAP'S OWN BLOCK
// TIME. An unpaired transfer is skipped rather than back-filled with an invented
// input amount; a swap whose historical price cannot be read is persisted with a
// NULL value_usd — absence, which the migration's "a value is NEVER fabricated"
// invariant asks for, not a substituted number. Skips entirely under a non-live
// source (hermetic smoke/CI never reaches a live log indexer). Bounded per run so
// a single refresh never scans an unbounded block range on a rate-limited public
// RPC.
function topicAddress(address: string): string {
  return "0x" + encodeAddressArg(address);
}

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

// eth_blockNumber / eth_getBlockByNumber go through the shared base-rpc-client
// transport (no private JSON-RPC client here — one transport for the whole app).
// Both the calendar day (persisted as occurred_on) and the raw unix timestamp
// (which selects the historical price candle) come from the SAME block read, so
// a row's date and its price can never describe different days.
const blockTimeCache = new Map<number, { day: string; ts: number }>();

function rememberBlockTime(blockNumber: number, timestampHex: string): { day: string; ts: number } {
  const ts = parseInt(timestampHex, 16);
  const at = { day: new Date(ts * 1000).toISOString().slice(0, 10), ts };
  blockTimeCache.set(blockNumber, at);
  return at;
}

/**
 * Fill the block-time cache for a whole chunk's blocks in batched POSTs.
 *
 * The scan loop below reads one swap at a time, and each swap needs its own
 * block's timestamp — so an N-swap chunk made N separate `eth_getBlockByNumber`
 * round trips against a provider that meters requests. The block numbers are
 * all known the moment the chunk's logs land, and none of them depends on any
 * other, so they are exactly the independent axis markets §7 says to batch.
 *
 * BEST-EFFORT BY DESIGN. A block that the batch could not answer is simply left
 * uncached, and `blockTime` falls back to its single read — which throws the
 * same way it always did. Priming may make the scan cheaper; it may never make
 * it wrong, and it may never turn a failed read into a missing row.
 */
async function primeBlockTimes(blockNumbers: readonly number[]): Promise<void> {
  const wanted = [...new Set(blockNumbers)].filter((n) => !blockTimeCache.has(n));
  if (wanted.length === 0) return;
  const res = await ethGetBlockByNumberBatch(wanted, rpcOpts());
  for (let i = 0; i < wanted.length; i++) {
    const r = res[i];
    if (r?.ok && r.result.timestamp) rememberBlockTime(wanted[i]!, r.result.timestamp);
  }
}

async function blockTime(blockNumber: number): Promise<{ day: string; ts: number }> {
  const hit = blockTimeCache.get(blockNumber);
  if (hit) return hit;
  const block = await ethGetBlockByNumber(blockNumber, rpcOpts());
  return rememberBlockTime(blockNumber, block.timestamp);
}

// The WETH-out logs of a single block, keyed by block. The scan needs them
// per TX, but the filter is per BLOCK and the tx match happens client-side, so
// one read serves every swap in that block.
const wethLogsCache = new Map<number, EthLog[]>();

/**
 * Drop both of the SCAN's block-keyed caches (distinct from
 * _resetBuybackCacheForTests above, which clears the read path's TTL cache). Called at the START of every scan run, and by
 * tests between cases.
 *
 * BOUNDED BY THE RUN, not by the process. Both maps exist to let one run's
 * batched prefetch serve its own per-swap loop; keeping them across runs would
 * buy almost nothing — the cursor moves forward, so a later run asks about
 * different blocks — while growing without limit inside a worker that lives for
 * weeks. `wethLogsCache` holds log ARRAYS rather than two numbers, so it is the
 * one that would actually matter. Clearing per run makes the high-water mark one
 * run's working set, which the chunk bounds already cap.
 */
export function resetBuybackScanCaches(): void {
  blockTimeCache.clear();
  wethLogsCache.clear();
}

/** Test-only alias, matching base-rpc-client's `_reset*ForTests` convention. */
export const _resetBuybackScanCachesForTests = resetBuybackScanCaches;

function wethLogsParams(wethToken: string, primaryWallet: string, blockNumber: number): EthGetLogsParams {
  const blockHex = "0x" + blockNumber.toString(16);
  return {
    address: wethToken,
    topics: [TRANSFER_TOPIC, topicAddress(primaryWallet), null],
    fromBlock: blockHex,
    toBlock: blockHex,
  };
}

/**
 * Fill the WETH-log cache for a chunk's blocks, ten `eth_getLogs` per POST.
 *
 * Same shape as primeBlockTimes, and same refusal: an unanswered block is left
 * out of the cache so the per-tx path re-reads it and fails loudly if it must.
 * An unpaired swap must stay unpaired for a real reason, never because a batch
 * entry quietly went missing.
 */
async function primeWethLogs(
  wethToken: string,
  primaryWallet: string,
  blockNumbers: readonly number[],
): Promise<void> {
  const wanted = [...new Set(blockNumbers)].filter((n) => !wethLogsCache.has(n));
  if (wanted.length === 0) return;
  const res = await rpcBatchRequest<EthLog[]>(
    wanted.map((n) => ({ method: "eth_getLogs", params: [wethLogsParams(wethToken, primaryWallet, n)] })),
    rpcOpts(),
  );
  for (let i = 0; i < wanted.length; i++) {
    const r = res[i];
    if (r?.ok && Array.isArray(r.result)) wethLogsCache.set(wanted[i]!, r.result);
  }
}

// WETH/USD at a swap's own block time, from the settled daily candle of the
// deepest Base WETH/USDC pool. Returns null — never a substitute price — when
// the candle cannot be read, so the caller persists an honest NULL value_usd.
//
// The pool is a baked constant and the token is the same address whose transfers
// this indexer counts as the swap's input leg, so the request asserts that the
// candle prices the very token being spent. If an operator re-points
// WETH_ADDRESS at something that pool does not hold, the two stop describing one
// asset and the read refuses rather than quietly pricing the input leg in
// whatever the pool's base side happens to be — a refusal that lands here and
// becomes a NULL, which is the honest answer for a swap nothing can price.
// A refusal and a genuinely missing candle both arrive as an error; they are
// told apart by the message, which is why the thrown text names the tokens.
async function wethPriceUsdAt(wethToken: string, blockTimestamp: number): Promise<number | null> {
  try {
    return await fetchGeckoDailyCloseUsd(WETH_USDC_POOL, wethToken, blockTimestamp);
  } catch (err) {
    console.warn(
      `buyback-logs: no usable historical WETH price for ${new Date(blockTimestamp * 1000).toISOString().slice(0, 10)}, persisting value_usd NULL:`,
      err,
    );
    return null;
  }
}

// Sum the WETH transferred OUT of the primary wallet within a single tx's block
// (the swap input leg paired to the ROBOTMONEY-in). Returns null when no paired
// WETH-out is found in that block for the tx (so the caller skips the row rather
// than inventing an input amount).
async function wethSpentForTx(
  wethToken: string,
  primaryWallet: string,
  blockNumber: number,
  txHash: string,
): Promise<number | null> {
  // Served from the chunk's primed batch when it is there; otherwise read on
  // its own, which is also what happens when priming could not answer this
  // block. The result is identical either way — only the number of round trips
  // differs.
  const logs =
    wethLogsCache.get(blockNumber) ??
    (await (async () => {
      const fetched = await ethGetLogs(wethLogsParams(wethToken, primaryWallet, blockNumber), rpcOpts());
      wethLogsCache.set(blockNumber, fetched);
      return fetched;
    })());
  let raw = 0n;
  let matched = false;
  for (const log of logs) {
    if (log.transactionHash.toLowerCase() !== txHash.toLowerCase()) continue;
    raw += decodeUint256(log.data);
    matched = true;
  }
  return matched ? Number(raw) / WEI_18 : null;
}

// The provider's eth_getLogs block-range cap, once it has said what it is (RM-156). mainnet.base.org, the
// BASE_RPC_URL default, now caps a range at 500 blocks and answers anything wider with HTTP 413 and "eth_getLogs is
// limited to a 500 range". Halving a 9000-block window gets under that only after five levels, about 31 refused
// requests per window, each spending the shared rate budget. Read from the answer instead, the cap sizes every later
// window in this process: one refusal, then windows the provider takes. Process-wide, because the provider does
// not change between runs; null until a provider has named one.
let learnedRangeCap: number | null = null;
const RANGE_CAP_RE = /limited to a (\d+) range/i;

/** The provider's range cap as an RPC error states it, or null when it does not. */
export function rangeCapFromError(err: unknown): number | null {
  if (!(err instanceof BaseRpcHttpError) || err.status !== 413) return null;
  const m = RANGE_CAP_RE.exec(err.detail);
  const cap = m ? Number(m[1]) : NaN;
  return Number.isInteger(cap) && cap > 0 ? cap : null;
}

/** The window the scan reads in: the provider's cap once known, BUYBACK_LOG_CHUNK until then. */
export function buybackLogWindow(): number {
  return learnedRangeCap != null ? Math.min(learnedRangeCap, BUYBACK_LOG_CHUNK) : BUYBACK_LOG_CHUNK;
}

/** Test-only: forget the learned cap. */
export function _resetBuybackRangeCapForTests(): void {
  learnedRangeCap = null;
}

/**
 * `eth_getLogs` over [from, to], halving the range when the provider answers HTTP 413 (the response would be too big).
 *
 * A busy range can exceed a provider's response limit even when it is under the block-range cap that
 * BUYBACK_LOG_CHUNK was sized for. On production, 2026-09-29 to 09-30, the scan failed five times with
 * `Base RPC HTTP 413` and left the persisted rows (and so the buyback figures) where they were (issue 1061).
 * The halves are disjoint and are read low then high, so every log is returned once and in block order. A range
 * that never answers 413 makes one request. A single block that still answers 413 throws: it cannot be split.
 */
async function getLogsSplittingOn413(
  filter: { address: string; topics: (string | null)[] },
  from: number,
  to: number,
): Promise<EthLog[]> {
  try {
    return await ethGetLogs({ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }, rpcOpts());
  } catch (err) {
    if (!(err instanceof BaseRpcHttpError) || err.status !== 413 || from >= to) throw err;
    // A 413 that names the provider's range cap: read [from, to] in windows of that size, and remember it.
    const cap = rangeCapFromError(err);
    if (cap != null && to - from + 1 > cap) {
      learnedRangeCap = cap;
      console.warn(`[buyback-logs] the provider caps eth_getLogs at ${cap} blocks; reading ${from}-${to} in windows of ${cap}`);
      const logs: EthLog[] = [];
      for (let lo = from; lo <= to; lo += cap) logs.push(...(await getLogsSplittingOn413(filter, lo, Math.min(lo + cap - 1, to))));
      return logs;
    }
    const mid = from + Math.floor((to - from) / 2);
    console.warn(`[buyback-logs] eth_getLogs ${from}-${to} answered HTTP 413; reading ${from}-${mid} and ${mid + 1}-${to} separately`);
    const low = await getLogsSplittingOn413(filter, from, mid);
    const high = await getLogsSplittingOn413(filter, mid + 1, to);
    return [...low, ...high];
  }
}

export interface IndexResult {
  indexed: number;
  skipped: string | null;
  scannedToBlock: number | null;
}

/**
 * The one line a failed live scan logs. The error, and for an HTTP answer its status and the start of the
 * provider's body, sit on that same line: Bun prints an Error argument on later lines, and soak check R8.v
 * reads line by line to tell a Base RPC 429 (a WARN) from any other failure (issue 1387).
 */
export function liveIndexFailedLine(err: unknown): string {
  const what = err instanceof BaseRpcHttpError ? `${err.name}: ${err.message}${err.detail ? ` ${err.detail}` : ""}` : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return `buyback-logs: live index failed, leaving persisted rows in place: ${what.replace(/\s+/g, " ")}`;
}

/**
 * @param db the pool the indexer's sites run on: the worker's (rm_worker) from
 *   the buybacks handler; the api's by default, for tests and the dashboards
 *   process. The four indexer sites declare rm_worker.
 */
export async function indexBuybacks(store: BuybackIndexStore = pipelineBuybackIndexStore): Promise<IndexResult> {
  const cfg = resolveBuybackConfig();
  if (cfg.source !== "live") {
    // Hermetic smoke / CI: never reach a live log indexer; the seeded rows stand.
    return { indexed: 0, skipped: `source-${cfg.source}`, scannedToBlock: null };
  }

  // Committed scan bounds (issues #640/#641): all are committed constants, not env
  // reads. The floor is the committed BUYBACK_FROM_BLOCK constant (config.ts), not
  // an env read: a bounded per-run scan starting at block 0 would spend ~51 days
  // of empty eth_getLogs calls before reaching the buyback era. With no env read
  // there is no value to malform, so the old NaN path — which slipped past the
  // `floor <= 0` warning and froze the chunk loop permanently — cannot recur.
  // The chunk/maxChunks constants are the committed scan-window bounds (see
  // config.ts); a provider that caps ranges lower names its cap, and the
  // window follows it (buybackLogWindow).
  // One run's reach is BUYBACK_MAX_CHUNKS windows of BUYBACK_LOG_CHUNK blocks. When the provider caps ranges
  // below the chunk (RM-156), the window shrinks to its cap and the run reads more, smaller windows, so a run still
  // covers the same blocks: the budget is the blocks, and the windows are how the provider will take them.
  const blockBudget = BUYBACK_LOG_CHUNK * BUYBACK_MAX_CHUNKS;
  const floor = cfg.fromBlock;

  // One run, one working set. See resetBuybackScanCaches for why these are scoped to
  // the run rather than the process.
  resetBuybackScanCaches();

  let indexed = 0;
  let scannedToBlock: number | null = null;
  try {
    // Resume point: the highest block we have already SCANNED (persisted cursor),
    // independent of whether a buyback was found there — this is what lets a
    // bounded per-run scan crawl forward across empty windows instead of
    // restarting from the floor forever (the NULL-block seed rows contribute no
    // MAX(block_number), so the old row-derived cursor never advanced). We also
    // never resume before the highest already-indexed live block.
    const { cursor, persistedMax } = await store.scanState();
    let from = Math.max(
      cursor != null ? cursor + 1 : floor,
      persistedMax != null ? persistedMax + 1 : floor,
    );
    const latest = await ethBlockNumber(rpcOpts());

    // NOTE: no per-run spot price is read here. A single current-spot price used
    // for every row was defensible only while the scan stayed near the chain
    // head; with the floor set (BUYBACK_FROM_BLOCK) the very first runs backfill
    // ~5 months of history, and stamping today's WETH price on a swap from March
    // is a fabricated value_usd — ~13.5% wrong at the seeded buybacks alone
    // (~$1,884.55 today vs ~$2,179.3 then). Each row is priced from its own
    // block's day candle below, cached per day so a many-swap day costs one call.
    for (let scanned = 0; scanned < blockBudget && from <= latest; ) {
      const to = Math.min(from + buybackLogWindow() - 1, latest);
      scanned += to - from + 1;
      const logs: EthLog[] = await getLogsSplittingOn413(
        { address: cfg.robotmoneyToken, topics: [TRANSFER_TOPIC, null, topicAddress(cfg.primaryWallet)] },
        from,
        to,
      );
      // ONE batched prefetch per chunk, before the per-swap loop below.
      // Every swap needs its block's timestamp and its block's WETH-out logs,
      // and both sets of block numbers are fully known right here — so they go
      // out ten to a POST instead of two round trips per swap, serially. The
      // loop's logic is untouched: it still asks for one swap's data at a time
      // and still refuses a swap it cannot pair.
      const chunkBlocks = logs.map((l) => parseInt(l.blockNumber, 16));
      await primeBlockTimes(chunkBlocks);
      await primeWethLogs(cfg.wethToken, cfg.primaryWallet, chunkBlocks);

      const swaps: BuybackSwapRow[] = [];
      for (const log of logs) {
        const blockNumber = parseInt(log.blockNumber, 16);
        const logIndex = parseInt(log.logIndex, 16);
        const robotmoneyReceived = Number(decodeUint256(log.data)) / WEI_18;
        // An unpaired transfer still yields no row — the WETH input amount is not
        // recoverable and would have to be invented.
        const wethSpent = await wethSpentForTx(cfg.wethToken, cfg.primaryWallet, blockNumber, log.transactionHash);
        if (wethSpent == null) continue;
        const at = await blockTime(blockNumber);
        // Priced at THIS swap's block time, not the run's. An unavailable candle
        // gives NULL: the swap itself is real and fully attested (hash, block,
        // amounts), so dropping it would lose a true row, while writing a
        // stand-in USD number would be exactly the fabrication migration 0015
        // forbids. NULL says "this row's USD value is unknown".
        const wethPriceUsd = await wethPriceUsdAt(cfg.wethToken, at.ts);
        const valueUsd = wethPriceUsd == null ? null : Math.round(wethSpent * wethPriceUsd * 100) / 100;
        swaps.push({
          blockNumber,
          txHash: log.transactionHash.toLowerCase(),
          logIndex,
          occurredOn: at.day,
          wethSpent,
          valueUsd,
          robotmoneyReceived,
        });
      }
      // Record THIS window: its swaps (idempotent on the tx_hash natural key, so
      // a re-scan never duplicates one) and the advanced cursor, regardless of
      // hits, so the next run resumes past it. The api writes a chunk's swaps
      // and the cursor in one transaction; a window with more swaps than one
      // request may carry sends the earlier chunks first and the cursor last.
      const chunks = swaps.length > 0 ? pipelineChunks(swaps) : [[]];
      for (let i = 0; i < chunks.length; i++) {
        indexed += await store.recordWindow(chunks[i]!, i === chunks.length - 1 ? to : null);
      }
      scannedToBlock = to;
      from = to + 1;
    }
  } catch (err) {
    console.error(liveIndexFailedLine(err));
  }
  return { indexed, skipped: null, scannedToBlock };
}

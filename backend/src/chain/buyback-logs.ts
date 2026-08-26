// Token-buyback dashboard feed for GET /api/dashboards/buybacks (live-data
// contract §1). Replaces the baked buyback table in the frontend
// (allocation.html:383-403). A buyback is a WETH -> ROBOTMONEY swap: a ROBOTMONEY
// Transfer event INTO the primary prop wallet (source of truth: robotmoney-site
// wallet.ts::fetchBuybackTransactions).
//
// Read path (getBuybacks): serves the durable buyback_swaps table (migration
// 0015) — the 10 real historical rows are the 'seed' provenance backfill, and
// the worker indexer (indexBuybacks, called from worker/handlers/buybacks.ts)
// adds any NEW live swaps keyed on tx_hash. On a table/read failure it degrades
// honestly rather than fabricating rows. Per #50: 'stub'/'stale'/'seed' are
// never presented as live chain data.
import {
  config,
  resolveBuybackConfig,
  resolveBaseRpcSource,
  WETH_USDC_POOL,
  BUYBACK_LOG_CHUNK,
  BUYBACK_MAX_CHUNKS,
  type BaseRpcSource,
} from "../config.ts";
import { sql } from "../db/client.ts";
import {
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
import { ttlCached } from "./ttl-cache.ts";

// keccak256("Transfer(address,address,uint256)") — the standard ERC-20 Transfer
// event topic0 (widely published; not computed here).
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const WEI_18 = 1e18;

export type Provenance = "live" | "stub" | "stale" | "seed";

export interface BuybackRow {
  date: string; // ISO calendar day, e.g. "2026-03-23"
  txHash: string; // 0x… Base tx hash
  wethSpent: number; // WETH amount, 18dp normalized
  valueUsd: number; // USD value of the WETH spent
  robotmoneyReceived: number; // ROBOTMONEY tokens received (raw count)
  provenance: Provenance;
}

export interface Buybacks {
  asOf: string;
  source: BaseRpcSource;
  stale: boolean; // true when a live source is degraded to persisted/seed rows only
  rows: BuybackRow[]; // newest-first
  totals: { wethSpent: number; valueUsd: number; robotmoneyReceived: number };
}

interface DbRow {
  tx_hash: string;
  occurred_on: Date | string | null;
  weth_spent: string | null;
  value_usd: string | null;
  robotmoney_received: string | null;
  provenance: string;
}

function toIsoDay(d: Date | string | null): string {
  if (d == null) return "";
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

function num(v: string | null): number {
  return v == null ? 0 : Number(v);
}

async function readRows(): Promise<DbRow[]> {
  // Newest-first: live rows (with a block number) precede the null-block seeds;
  // among same-day rows, higher block/log index is more recent; id ASC is the
  // final tiebreak so the seed set keeps its inserted (contract-golden) order.
  return sql<DbRow[]>`
    SELECT tx_hash, occurred_on, weth_spent, value_usd, robotmoney_received, provenance
      FROM buyback_swaps
     ORDER BY occurred_on DESC NULLS LAST,
              block_number DESC NULLS LAST,
              log_index DESC NULLS LAST,
              id ASC
  `;
}

const CACHE_TTL_MS = 30_000;

async function computeBuybacks(): Promise<Buybacks> {
  const now = Date.now();

  // Resolved per call (not module load) so provenance always tracks the current
  // env and tests can flip BASE_RPC_SOURCE per case.
  const source = resolveBaseRpcSource();

  let dbRows: DbRow[];
  try {
    dbRows = await readRows();
  } catch (err) {
    console.error("buyback-logs: buyback_swaps read failed, serving empty degraded payload:", err);
    dbRows = [];
  }

  const rows: BuybackRow[] = dbRows.map((r) => ({
    date: toIsoDay(r.occurred_on),
    txHash: r.tx_hash,
    wethSpent: num(r.weth_spent),
    valueUsd: num(r.value_usd),
    robotmoneyReceived: num(r.robotmoney_received),
    provenance: (["live", "stub", "stale", "seed"].includes(r.provenance) ? r.provenance : "seed") as Provenance,
  }));

  // Honest staleness: only meaningful for a LIVE source. If we claim 'live' but
  // no row was actually indexed live (only seed/stale persisted rows exist), the
  // feed is degraded. In stub mode the seeded rows ARE the intended fixture, so
  // it is not "stale". An empty table is degraded under a live source.
  const stale =
    source === "live" && !rows.some((r) => r.provenance === "live");

  const totals = rows.reduce(
    (t, r) => {
      t.wethSpent += r.wethSpent;
      t.valueUsd += r.valueUsd;
      t.robotmoneyReceived += r.robotmoneyReceived;
      return t;
    },
    { wethSpent: 0, valueUsd: 0, robotmoneyReceived: 0 },
  );
  // Round the accumulated WETH/USD totals to their natural precision (float sums
  // drift a few ULPs); token counts stay integral.
  totals.wethSpent = Math.round(totals.wethSpent * 1e6) / 1e6;
  totals.valueUsd = Math.round(totals.valueUsd * 100) / 100;

  return { asOf: new Date(now).toISOString(), source, stale, rows, totals };
}

export const getBuybacks = ttlCached(computeBuybacks, CACHE_TTL_MS);

export function _resetBuybackCacheForTests(): void {
  getBuybacks._resetForTests();
}

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
 * other, so they are exactly the independent axis §6.5.5 says to batch.
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

export interface IndexResult {
  indexed: number;
  skipped: string | null;
  scannedToBlock: number | null;
}

export async function indexBuybacks(): Promise<IndexResult> {
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
  // The chunk/maxChunks constants are the committed scan-window bounds; 9000 sits
  // under the common 10k eth_getLogs provider cap (see config.ts).
  const chunk = BUYBACK_LOG_CHUNK;
  const maxChunks = BUYBACK_MAX_CHUNKS;
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
    const [cursorRow, maxRow] = await Promise.all([
      sql<{ b: string | null }[]>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`,
      sql<{ mx: string | null }[]>`SELECT MAX(block_number)::text AS mx FROM buyback_swaps`,
    ]);
    const cursor = cursorRow[0]?.b == null ? null : Number(cursorRow[0].b);
    const persistedMax = maxRow[0]?.mx == null ? null : Number(maxRow[0].mx);
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
    for (let c = 0; c < maxChunks && from <= latest; c++) {
      const to = Math.min(from + chunk - 1, latest);
      const logs: EthLog[] = await ethGetLogs(
        {
          address: cfg.robotmoneyToken,
          topics: [TRANSFER_TOPIC, null, topicAddress(cfg.primaryWallet)],
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        },
        rpcOpts(),
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

      for (const log of logs) {
        const blockNumber = parseInt(log.blockNumber, 16);
        const logIndex = parseInt(log.logIndex, 16);
        const robotmoneyReceived = Number(decodeUint256(log.data)) / WEI_18;
        // An unpaired transfer still yields no row — the WETH input amount is not
        // recoverable and would have to be invented.
        const wethSpent = await wethSpentForTx(cfg.wethToken, cfg.primaryWallet, blockNumber, log.transactionHash);
        if (wethSpent == null) continue;
        const at = await blockTime(blockNumber);
        const occurredOn = at.day;
        // Priced at THIS swap's block time, not the run's. An unavailable candle
        // gives NULL: the swap itself is real and fully attested (hash, block,
        // amounts), so dropping it would lose a true row, while writing a
        // stand-in USD number would be exactly the fabrication migration 0015
        // forbids. NULL says "this row's USD value is unknown".
        const wethPriceUsd = await wethPriceUsdAt(cfg.wethToken, at.ts);
        const valueUsd = wethPriceUsd == null ? null : Math.round(wethSpent * wethPriceUsd * 100) / 100;
        // Idempotent on the tx_hash natural key: a re-scan (overlap/reorg) never
        // duplicates a swap. NOTE: a single tx emitting multiple ROBOTMONEY-in
        // legs records only the first (robotmoney_received slightly undercounts
        // such txs); acceptable for the buyback pattern, tracked as a follow-up.
        const res = await sql`
          INSERT INTO buyback_swaps
            (block_number, tx_hash, log_index, occurred_on, weth_spent, value_usd, robotmoney_received, provenance)
          VALUES
            (${blockNumber}, ${log.transactionHash.toLowerCase()}, ${logIndex}, ${occurredOn}, ${wethSpent}, ${valueUsd}, ${robotmoneyReceived}, 'live')
          ON CONFLICT (tx_hash) DO NOTHING
        `;
        indexed += res.count;
      }
      // Advance + persist the scan cursor for THIS window regardless of hits, so
      // the next run resumes past it. scannedToBlock reflects real coverage.
      scannedToBlock = to;
      await sql`
        INSERT INTO buyback_scan_state (id, last_scanned_block, updated_at)
        VALUES (1, ${to}, now())
        ON CONFLICT (id) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()
      `;
      from = to + 1;
    }
  } catch (err) {
    console.error("buyback-logs: live index failed, leaving persisted rows in place:", err);
  }
  if (indexed > 0) getBuybacks.invalidate(); // invalidate the read cache so the new rows surface
  return { indexed, skipped: null, scannedToBlock };
}

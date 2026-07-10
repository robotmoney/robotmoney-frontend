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
import { config, resolveBuybackConfig, resolveBaseRpcSource, type BaseRpcSource } from "../config.ts";
import { sql } from "../db/client.ts";
import {
  decodeUint256,
  encodeAddressArg,
  ethBlockNumber,
  ethGetBlockByNumber,
  ethGetLogs,
  type EthLog,
  type RpcCallOptions,
} from "./base-rpc-client.ts";
import { fetchGeckoTokenPriceUsd } from "./token-prices.ts";

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
let cache: { at: number; value: Buybacks } | null = null;

export function _resetBuybackCacheForTests(): void {
  cache = null;
}

export async function getBuybacks(): Promise<Buybacks> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

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

  const value: Buybacks = { asOf: new Date(now).toISOString(), source, stale, rows, totals };
  cache = { at: now, value };
  return value;
}

// --- Live indexer (worker/handlers/buybacks.ts) ------------------------------
// Refreshes buyback_swaps from Base via eth_getLogs: ROBOTMONEY Transfer events
// INTO the primary prop wallet, joined to the paired WETH-out leg for the input
// amount, priced via GeckoTerminal for the USD value. Only persists a row when
// the FULL picture is known (WETH spent, USD value, ROBOTMONEY received, block
// date) — an unpaired transfer is skipped, never back-filled with an invented
// number. Skips entirely under a non-live source (hermetic demo/CI never reaches
// a live log indexer). Bounded per run so a single refresh never scans an
// unbounded block range on a rate-limited public RPC.
function topicAddress(address: string): string {
  return "0x" + encodeAddressArg(address);
}

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

// eth_blockNumber / eth_getBlockByNumber go through the shared base-rpc-client
// transport (no private JSON-RPC client here — one transport for the whole app).
const blockDateCache = new Map<number, string>();
async function blockDate(blockNumber: number): Promise<string> {
  const hit = blockDateCache.get(blockNumber);
  if (hit) return hit;
  const block = await ethGetBlockByNumber(blockNumber, rpcOpts());
  const day = new Date(parseInt(block.timestamp, 16) * 1000).toISOString().slice(0, 10);
  blockDateCache.set(blockNumber, day);
  return day;
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
  const blockHex = "0x" + blockNumber.toString(16);
  const logs = await ethGetLogs(
    {
      address: wethToken,
      topics: [TRANSFER_TOPIC, topicAddress(primaryWallet), null],
      fromBlock: blockHex,
      toBlock: blockHex,
    },
    rpcOpts(),
  );
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
    // Hermetic demo / CI: never reach a live log indexer; the seeded rows stand.
    return { indexed: 0, skipped: `source-${cfg.source}`, scannedToBlock: null };
  }

  const chunk = Number(process.env.BUYBACK_LOG_CHUNK ?? "9000");
  const maxChunks = Number(process.env.BUYBACK_MAX_CHUNKS ?? "25");
  const floor = Number(process.env.BUYBACK_FROM_BLOCK ?? "0");
  if (floor <= 0) {
    // Scanning from genesis on Base (tens of millions of blocks) at a bounded
    // maxChunks*chunk per run would take hundreds of runs to crawl to the buyback
    // era. The cursor below still guarantees eventual progress, but a realistic
    // floor near the ROBOTMONEY deployment is required for the live feed to catch
    // up in reasonable time — say so loudly rather than silently crawling.
    console.warn(
      "buyback-logs: BUYBACK_FROM_BLOCK is unset/0 — the live indexer will crawl from block 0 and may take many runs to reach the buyback era; set BUYBACK_FROM_BLOCK to a block near ROBOTMONEY deployment.",
    );
  }

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

    // Price the WETH input leg once per run (best-available spot; a just-executed
    // swap is recent so current WETH price ≈ swap price). A price failure aborts
    // the run's persistence — no live row is written without a USD value.
    const wethPriceUsd = await fetchGeckoTokenPriceUsd(cfg.wethToken);

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
      for (const log of logs) {
        const blockNumber = parseInt(log.blockNumber, 16);
        const logIndex = parseInt(log.logIndex, 16);
        const robotmoneyReceived = Number(decodeUint256(log.data)) / WEI_18;
        // Only persist a fully-determined buyback: paired WETH-out + USD + date.
        const wethSpent = await wethSpentForTx(cfg.wethToken, cfg.primaryWallet, blockNumber, log.transactionHash);
        if (wethSpent == null) continue;
        const occurredOn = await blockDate(blockNumber);
        const valueUsd = Math.round(wethSpent * wethPriceUsd * 100) / 100;
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
  if (indexed > 0) cache = null; // invalidate the read cache so the new rows surface
  return { indexed, skipped: null, scannedToBlock };
}

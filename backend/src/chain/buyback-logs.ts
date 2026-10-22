// Token-buyback dashboard feed for GET /api/dashboards/buybacks (live-data
// contract §1). Replaces the baked buyback table in the frontend
// (allocation.html:383-403). A buyback is a WETH -> ROBOTMONEY swap: a ROBOTMONEY
// Transfer event INTO the primary prop wallet (source of truth: robotmoney-site
// wallet.ts::fetchBuybackTransactions).
//
// Read path (getBuybacks): serves the durable buyback_swaps table (migration
// 0015) — the 10 real historical rows are the 'seed' provenance backfill, and
// the pipeline worker's indexer (chain/buyback-indexer.ts indexBuybacks)
// adds any NEW live swaps keyed on tx_hash. On a table/read failure it degrades
// honestly rather than fabricating rows. Per #50: 'stub'/'stale'/'seed' are
// never presented as live chain data.
import { resolveBaseRpcSource, type BaseRpcSource } from "../config.ts";
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import { ttlCached } from "./ttl-cache.ts";

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

// A registered query (smoke-production-spec.md §7.1). The read serves GET
// /api/dashboards/buybacks on the api's pool (rm_app). The live indexer is the
// pipeline worker's (chain/buyback-indexer.ts); its cursor and swap writes run
// in the api (pipeline/stores/buybacks.ts, issue 1034).
const DASHBOARDS = "src/api/routes/dashboards";

const swapRows = registerQuery({
  role: "rm_app",
  object: "buyback_swaps",
  privileges: ["SELECT"],
  site: "src/chain/buyback-logs:readRows",
  purpose: "Read every persisted buyback swap, newest first, for the buybacks payload.",
  callers: [DASHBOARDS],
  probe: {
    statement: `SELECT tx_hash, occurred_on, weth_spent, value_usd, robotmoney_received, provenance FROM buyback_swaps
      ORDER BY occurred_on DESC NULLS LAST, block_number DESC NULLS LAST, log_index DESC NULLS LAST, id ASC`,
  },
});

async function readRows(): Promise<DbRow[]> {
  // Newest-first: live rows (with a block number) precede the null-block seeds;
  // among same-day rows, higher block/log index is more recent; id ASC is the
  // final tiebreak so the seed set keeps its inserted (contract-golden) order.
  return on(sql, swapRows)<DbRow>`
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


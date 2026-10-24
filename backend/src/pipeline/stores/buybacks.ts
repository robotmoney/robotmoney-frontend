// The buyback indexer's cursor and swap writes, run by the api for the pipeline
// worker (issue 1034, decision D75). chain/buyback-indexer.ts scans the chain
// and sends each window; these are the statements it used to run on the
// worker's own pool.
import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";
import type { BuybackSwapRow } from "../../chain/buyback-indexer.ts";

const scanCursor = registerQuery({
  role: "rm_app",
  object: "buyback_scan_state",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/buybacks:buybackScanState.cursor",
  purpose: "Read the indexer's durable last-scanned block so a scan resumes where the previous one stopped.",
  callers: ["src/api/routes/pipeline"],
  probe: { statement: "SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1" },
});

const maxIndexedBlock = registerQuery({
  role: "rm_app",
  object: "buyback_swaps",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/buybacks:buybackScanState.maxBlock",
  purpose: "Read the highest already-indexed live block, below which a scan never resumes.",
  callers: ["src/api/routes/pipeline"],
  probe: { statement: "SELECT MAX(block_number)::text AS mx FROM buyback_swaps" },
});

const insertSwap = registerQuery({
  role: "rm_app",
  object: "buyback_swaps",
  // SELECT because ON CONFLICT (tx_hash) reads the arbiter column.
  privileges: ["INSERT", "SELECT"],
  site: "src/pipeline/stores/buybacks:recordBuybackWindow.insert",
  purpose: "Insert one decoded live buyback swap, idempotent on its transaction hash.",
  callers: ["src/api/routes/pipeline"],
  probe: {
    statement: `INSERT INTO buyback_swaps
        (block_number, tx_hash, log_index, occurred_on, weth_spent, value_usd, robotmoney_received, provenance)
      VALUES ($1::bigint, $2, $3::integer, $4::date, $5::numeric, $6::numeric, $7::numeric, 'live')
      ON CONFLICT (tx_hash) DO NOTHING`,
    params: [1, "0xprobe", 0, "2026-01-01", "1", "1", "1"],
  },
});

const advanceCursor = registerQuery({
  role: "rm_app",
  object: "buyback_scan_state",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target and
  // EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/buybacks:recordBuybackWindow.advance",
  purpose: "Advance the indexer's durable cursor after each scanned chunk.",
  callers: ["src/api/routes/pipeline"],
  probe: {
    statement: `INSERT INTO buyback_scan_state (id, last_scanned_block, updated_at) VALUES (1, $1::bigint, now())
      ON CONFLICT (id) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()`,
    params: [1],
  },
});

/** The durable last-scanned block, and the highest already-indexed live block (`buybacks.scan_state`). */
export async function buybackScanState(db: RegistryDb): Promise<{ cursor: number | null; persistedMax: number | null }> {
  const [cursorRow, maxRow] = await Promise.all([
    on(db, scanCursor)<{ b: string | null }>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`,
    on(db, maxIndexedBlock)<{ mx: string | null }>`SELECT MAX(block_number)::text AS mx FROM buyback_swaps`,
  ]);
  return {
    cursor: cursorRow[0]?.b == null ? null : Number(cursorRow[0].b),
    persistedMax: maxRow[0]?.mx == null ? null : Number(maxRow[0].mx),
  };
}

/**
 * Insert a scanned window's swaps and, when `scannedTo` is given, advance the
 * cursor to it, in `tx` (`buybacks.record_window`). Returns how many swaps were
 * new.
 *
 * Idempotent on the tx_hash natural key: a re-scan (overlap/reorg) never
 * duplicates a swap. NOTE: a single tx emitting multiple ROBOTMONEY-in legs
 * records only the first (robotmoney_received slightly undercounts such txs);
 * acceptable for the buyback pattern, tracked as a follow-up.
 */
export async function recordBuybackWindow(tx: RegistryDb, swaps: readonly BuybackSwapRow[], scannedTo: number | null): Promise<number> {
  let inserted = 0;
  for (const s of swaps) {
    const res = await on(tx, insertSwap)`
      INSERT INTO buyback_swaps
        (block_number, tx_hash, log_index, occurred_on, weth_spent, value_usd, robotmoney_received, provenance)
      VALUES
        (${s.blockNumber}, ${s.txHash}, ${s.logIndex}, ${s.occurredOn}, ${s.wethSpent}, ${s.valueUsd}, ${s.robotmoneyReceived}, 'live')
      ON CONFLICT (tx_hash) DO NOTHING
    `;
    inserted += res.count;
  }
  if (scannedTo !== null) {
    await on(tx, advanceCursor)`
      INSERT INTO buyback_scan_state (id, last_scanned_block, updated_at)
      VALUES (1, ${scannedTo}, now())
      ON CONFLICT (id) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()
    `;
  }
  return inserted;
}

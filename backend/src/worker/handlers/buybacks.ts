// Periodic refresh of buyback_swaps (issue: live-data contract §1). Calls the
// chain/buyback-logs.ts eth_getLogs indexer to discover NEW WETH -> ROBOTMONEY
// buyback swaps into the primary prop wallet and upsert them (keyed on tx_hash,
// so a re-run never duplicates a swap). Under a non-live source (hermetic
// smoke/CI) the indexer no-ops, leaving the seeded historical rows in place — it
// never reaches a live log indexer. Idempotent and degrade-safe: an RPC failure
// leaves the persisted rows untouched rather than 5xx-ing the worker.
import { indexBuybacks } from "../../chain/buyback-logs.ts";

export async function refreshBuybacks(_payload: Record<string, unknown>): Promise<unknown> {
  return indexBuybacks();
}

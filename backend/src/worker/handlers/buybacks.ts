// Periodic refresh of buyback_swaps (issue: live-data contract §1). Calls the
// chain/buyback-logs.ts eth_getLogs indexer to discover NEW WETH -> ROBOTMONEY
// buyback swaps into the primary prop wallet and upsert them (keyed on tx_hash,
// so a re-run never duplicates a swap). Under a non-live source (hermetic
// smoke/CI) the indexer no-ops, leaving the seeded historical rows in place — it
// never reaches a live log indexer. Idempotent and degrade-safe: an RPC failure
// leaves the persisted rows untouched rather than 5xx-ing the worker.
import { indexBuybacks } from "../../chain/buyback-logs.ts";
import { sql } from "../../db/worker-client.ts";

// On the WORKER's pool (rm_worker, spec §3): the indexer's four sites declare
// rm_worker and grants.sql allows its writes (B11, issue #1150). Handing it
// db/client.ts's pool here would be rm_worker on a 0.6 stack anyway, with no
// grant behind it: that is how every sweep on the 2026-10-01 twin was refused.
export async function refreshBuybacks(_payload: Record<string, unknown>): Promise<unknown> {
  return indexBuybacks(sql);
}

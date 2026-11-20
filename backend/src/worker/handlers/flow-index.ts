import { indexFlowQueue } from "../../chain/flow-indexer-runtime.ts";
import { resolveAddressFloors } from "../../chain/address-floor-resolver.ts";
import { config } from "../../config.ts";
import { pipelineIngest, pipelineRead } from "../pipeline-client.ts";

/**
 * Blocks one run may scan. A window costs about five RPC calls whatever its
 * length (chain/flow-indexer.ts), so a caught-up index scans only the ~30
 * blocks Base adds a minute and a lagging one (a cold boot, a stalled worker)
 * clears about an hour of chain per run (issue 1614).
 */
export const FLOW_MAX_BLOCKS_PER_RUN = 2000;

let idleLogged = false;

/** Test seam: forget that the idle line was logged. */
export function resetFlowIdleLog(): void { idleLogged = false; }

export async function refreshFlowIndex(): Promise<unknown> {
  // Dormant (issue 1693): both contract settings empty means the feature is off. No RPC, no database write, one log line per process.
  if (!process.env.FLOW_QUEUE_ADDRESS?.trim() && !process.env.FLOW_FUND_ADDRESS?.trim()) {
    if (!idleLogged) { idleLogged = true; console.log("[flow.index] idle: FLOW_QUEUE_ADDRESS and FLOW_FUND_ADDRESS are not set"); }
    return { idle: true, reason: "flow index is not configured" };
  }
  const address = process.env.FLOW_QUEUE_ADDRESS ?? "";
  const fundAddress = process.env.FLOW_FUND_ADDRESS ?? "";
  const explorerAddresses = (process.env.FLOW_EXPLORER_ADDRESSES ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (![address, fundAddress, ...explorerAddresses].every((value) => /^0x[0-9a-fA-F]{40}$/.test(value))) throw new Error("FLOW_QUEUE_ADDRESS, FLOW_FUND_ADDRESS and explorer addresses must name deployed contracts");
  const rawBlock = process.env.FLOW_INDEX_DEPLOY_BLOCK;
  let deployBlock: number;
  if (rawBlock) {
    deployBlock = Number(rawBlock);
    if (!Number.isSafeInteger(deployBlock) || deployBlock < 0) throw new Error("invalid FLOW_INDEX_DEPLOY_BLOCK");
  } else {
    const floors = await resolveAddressFloors([address, fundAddress, ...explorerAddresses], { rpcUrl: config.baseRpcUrl }, {
      get: (key) => pipelineRead<number | null>("wallet_backfill.address_floor_get", key),
      set: async (key, floor) => { await pipelineIngest("wallet_backfill.address_floor_set", key, floor); },
    });
    deployBlock = Math.min(...Array.from(floors.values(), (floor) => floor.floorBlock));
  }
  return { indexedThrough: await indexFlowQueue({ address, fundAddress, explorerAddresses, deployBlock, confirmations: 12, maxBlocks: FLOW_MAX_BLOCKS_PER_RUN }) };
}

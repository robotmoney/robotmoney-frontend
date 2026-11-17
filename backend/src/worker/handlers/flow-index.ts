import { indexFlowQueue } from "../../chain/flow-indexer-runtime.ts";
import { resolveAddressFloors } from "../../chain/address-floor-resolver.ts";
import { config } from "../../config.ts";
import { pipelineIngest, pipelineRead } from "../pipeline-client.ts";

export async function refreshFlowIndex(): Promise<unknown> {
  const address = process.env.FLOW_QUEUE_ADDRESS ?? "";
  const fundAddress = process.env.FLOW_FUND_ADDRESS ?? "";
  if (![address, fundAddress].every((value) => /^0x[0-9a-fA-F]{40}$/.test(value))) throw new Error("FLOW_QUEUE_ADDRESS and FLOW_FUND_ADDRESS must name deployed contracts");
  const rawBlock = process.env.FLOW_INDEX_DEPLOY_BLOCK;
  let deployBlock: number;
  if (rawBlock) {
    deployBlock = Number(rawBlock);
    if (!Number.isSafeInteger(deployBlock) || deployBlock < 0) throw new Error("invalid FLOW_INDEX_DEPLOY_BLOCK");
  } else {
    const floors = await resolveAddressFloors([address, fundAddress], { rpcUrl: config.baseRpcUrl }, {
      get: (key) => pipelineRead<number | null>("wallet_backfill.address_floor_get", key),
      set: async (key, floor) => { await pipelineIngest("wallet_backfill.address_floor_set", key, floor); },
    });
    deployBlock = Math.min(...Array.from(floors.values(), (floor) => floor.floorBlock));
  }
  return { indexedThrough: await indexFlowQueue({ address, fundAddress, deployBlock, confirmations: 12, maxBlocks: 40 }) };
}

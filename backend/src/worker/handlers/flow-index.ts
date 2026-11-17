import { indexFlowQueue } from "../../chain/flow-indexer-runtime.ts";

export async function refreshFlowIndex(): Promise<unknown> {
  const address = process.env.FLOW_QUEUE_ADDRESS ?? "";
  const deployBlock = Number(process.env.FLOW_QUEUE_DEPLOY_BLOCK);
  if (!process.env.FLOW_QUEUE_DEPLOY_BLOCK || !Number.isSafeInteger(deployBlock) || deployBlock < 0) {
    throw new Error("FLOW_QUEUE_DEPLOY_BLOCK must name the queue deployment block");
  }
  return { indexedThrough: await indexFlowQueue({ address, deployBlock, confirmations: 12, maxBlocks: 40 }) };
}

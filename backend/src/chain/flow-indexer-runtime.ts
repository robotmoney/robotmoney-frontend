import { config } from "../config.ts";
import { pipelineIngest, pipelineRead } from "../worker/pipeline-client.ts";
import { ethBlockNumber, ethGetBlockByNumber, ethGetLogs } from "./base-rpc-client.ts";
import { scanFlowWindow, type FlowHeader, type FlowLog } from "./flow-indexer.ts";

/** Execute a bounded scan using the shared Base client and API-owned database. */
export async function indexFlowQueue(input: { address: string; deployBlock: number; confirmations: number; maxBlocks: number }): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new Error("invalid FlowQueue address");
  const opts = { rpcUrl: config.baseRpcUrl };
  const chainId = 8453;
  return scanFlowWindow({
    head: () => ethBlockNumber(opts),
    header: async (number) => {
      const block = await ethGetBlockByNumber(number, opts);
      if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new Error(`missing block hash ${number}`);
      return { number, hash: block.hash, timestamp: parseInt(block.timestamp, 16) };
    },
    logs: async (from, to) => (await ethGetLogs({ address: input.address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }, opts)).map((log): FlowLog => {
      if (typeof log.blockHash !== "string") throw new Error("log has no block hash");
      return { blockNumber: parseInt(log.blockNumber, 16), blockHash: log.blockHash, logIndex: parseInt(log.logIndex, 16), transactionHash: log.transactionHash, address: log.address, topics: log.topics, data: log.data };
    }),
  }, {
    checkpoints: () => pipelineRead<FlowHeader[]>("flow.checkpoints", chainId),
    rewind: async (after) => { await pipelineIngest("flow.rewind", chainId, after); },
    record: async (headers, logs) => { await pipelineIngest("flow.record", chainId, headers, logs); },
  }, input);
}

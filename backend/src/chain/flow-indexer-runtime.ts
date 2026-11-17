import { config } from "../config.ts";
import { pipelineIngest, pipelineRead } from "../worker/pipeline-client.ts";
import { ethBlockNumber, ethGetBlockByNumber, ethGetBlockByNumberBatch, ethGetLogs, type EthBlock } from "./base-rpc-client.ts";
import { scanFlowWindow, type FlowHeader, type FlowLog } from "./flow-indexer.ts";

/** Execute a bounded scan using the shared Base client and API-owned database. */
export async function indexFlowQueue(input: { address: string; fundAddress: string; deployBlock: number; confirmations: number; maxBlocks: number }): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new Error("invalid FlowQueue address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.fundAddress)) throw new Error("invalid fund address");
  const opts = { rpcUrl: config.baseRpcUrl };
  const chainId = 8453;
  await pipelineIngest("flow.bind_deployment", chainId, input.address, input.fundAddress);
  const parseHeader = (block: EthBlock, number: number): FlowHeader => {
    if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new Error(`missing block hash ${number}`);
    if (typeof block.parentHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.parentHash)) throw new Error(`missing parent block hash ${number}`);
    if (parseInt(block.number, 16) !== number) throw new Error(`wrong block number ${number}`);
    return { number, hash: block.hash, parentHash: block.parentHash, timestamp: parseInt(block.timestamp, 16) };
  };
  return scanFlowWindow({
    head: () => ethBlockNumber(opts),
    header: async (number) => parseHeader(await ethGetBlockByNumber(number, opts), number),
    headers: async (numbers) => (await ethGetBlockByNumberBatch(numbers, opts)).map((result, i) => {
      if (!result.ok) throw new Error(`failed to read block ${numbers[i]}`);
      return parseHeader(result.result, numbers[i]!);
    }),
    logs: async (from, to) => (await ethGetLogs({ address: [input.address, input.fundAddress], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }, opts)).map((log): FlowLog => {
      if (typeof log.blockHash !== "string") throw new Error("log has no block hash");
      return { blockNumber: parseInt(log.blockNumber, 16), blockHash: log.blockHash, logIndex: parseInt(log.logIndex, 16), transactionHash: log.transactionHash, address: log.address, topics: log.topics, data: log.data };
    }),
  }, {
    checkpoints: () => pipelineRead<FlowHeader[]>("flow.checkpoints", chainId),
    rewind: async (after) => { await pipelineIngest("flow.rewind", chainId, after); },
    record: async (headers, logs) => { await pipelineIngest("flow.record", chainId, headers, logs); },
  }, input);
}

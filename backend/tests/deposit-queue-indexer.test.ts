import { expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { indexFlowQueue } from "../src/chain/flow-indexer-runtime.ts";
import { sql } from "../src/db/client.ts";
import { flowCheckpoints } from "../src/pipeline/stores/flow-index.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);
test("indexes Base logs through the pipeline and replays a reorg in Postgres", async () => {
  const queue = `0x${"1".repeat(40)}`, fund = `0x${"2".repeat(40)}`;
  const hash = (n: number, fork: boolean) => `0x${(BigInt(n + (fork && n >= 2 ? 100 : 0))).toString(16).padStart(64, "0")}`;
  let fork = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const input = await req.json();
    const answer = (call: { id: number; method: string; params: unknown[] }) => {
      let result: unknown;
      if (call.method === "eth_blockNumber") result = "0x4";
      else if (call.method === "eth_getBlockByNumber") {
        const n = parseInt(String(call.params[0]), 16);
        result = { number: `0x${n.toString(16)}`, timestamp: `0x${(100 + n).toString(16)}`, hash: hash(n, fork), parentHash: hash(n - 1, fork) };
      } else if (call.method === "eth_getLogs") {
        const filter = call.params[0] as { fromBlock: string; toBlock: string };
        result = parseInt(filter.fromBlock, 16) <= 2 && parseInt(filter.toBlock, 16) >= 2 ? [{ address: queue, topics: ["0xunknown"], data: "0x", blockNumber: "0x2", blockHash: hash(2, fork), logIndex: "0x0", transactionHash: `0x${"3".repeat(64)}` }] : [];
      } else throw new Error(`unexpected RPC ${call.method}`);
      return { jsonrpc: "2.0", id: call.id, result };
    };
    return Response.json(Array.isArray(input) ? input.map(answer) : answer(input));
  } });
  const oldUrl = config.baseRpcUrl, oldRate = process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  config.baseRpcUrl = `http://127.0.0.1:${server.port}`; process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  try {
    const opts = { address: queue, fundAddress: fund, deployBlock: 1, confirmations: 1, maxBlocks: 4 };
    expect(await indexFlowQueue(opts)).toBe(3);
    expect((await flowCheckpoints(sql, 8453)).map((x) => x.hash)).toEqual([hash(3, false), hash(2, false), hash(1, false)]);
    fork = true;
    expect(await indexFlowQueue(opts)).toBe(3);
    expect((await flowCheckpoints(sql, 8453)).map((x) => x.hash)).toEqual([hash(3, true), hash(2, true), hash(1, true)]);
    const rows = await sql`SELECT block_hash, canonical, topics FROM flow_index_logs ORDER BY block_hash`;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.canonical).map((row) => row.block_hash)).toEqual([hash(2, true)]);
    expect(rows[0]!.topics).toEqual(["0xunknown"]);
  } finally {
    config.baseRpcUrl = oldUrl;
    if (oldRate === undefined) delete process.env.BASE_RPC_MAX_CALLS_PER_SEC; else process.env.BASE_RPC_MAX_CALLS_PER_SEC = oldRate;
    server.stop(true);
  }
});

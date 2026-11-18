// The deposit queue indexer, end to end through the worker job handler, the
// shared Base RPC client and the API-owned pipeline store in Postgres. A fake
// Base node serves headers, logs and contract code; nothing here is mocked
// below the RPC boundary.
//
//   deploy-block discovery  no FLOW_INDEX_DEPLOY_BLOCK: the scan starts at the
//                           first block with code at any configured address,
//                           and the floor is cached (no second probe)
//   bounded backfill        each run scans at most 40 blocks and never past
//                           head - 12 confirmations
//   idempotent replay       a rewound window rescanned on the same chain
//                           restores the same rows and adds none
//   reorg rollback/replay   a changed hash below the watermark rewinds the
//                           persisted index and replays the new branch
import { expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { flowCheckpoints, flowRewind } from "../src/pipeline/stores/flow-index.ts";
import { refreshFlowIndex } from "../src/worker/handlers/flow-index.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const QUEUE = `0x${"1".repeat(40)}`;
const FUND = `0x${"2".repeat(40)}`;
const LEGACY = `0x${"4".repeat(40)}`;
const HEAD = 100;
const DEPLOYED: Record<string, number> = { [QUEUE]: 30, [FUND]: 35, [LEGACY]: 32 };

test("discovers the deploy block, backfills bounded confirmed windows, replays idempotently and recovers a reorg", async () => {
  let forkFrom = Infinity;
  const hash = (n: number) => `0x${(BigInt(n) + (n >= forkFrom ? 1000n : 0n)).toString(16).padStart(64, "0")}`;
  const logAt = (n: number, index: number) => ({ address: QUEUE, topics: [`0x${"ab".repeat(32)}`], data: "0x", blockNumber: `0x${n.toString(16)}`, blockHash: hash(n), logIndex: `0x${index.toString(16)}`, transactionHash: `0x${n.toString(16).padStart(64, "0")}` });
  const calls: Record<string, number> = {};
  const windows: [number, number][] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const input = await req.json();
    const answer = (call: { id: number; method: string; params: unknown[] }) => {
      calls[call.method] = (calls[call.method] ?? 0) + 1;
      let result: unknown;
      if (call.method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
      else if (call.method === "eth_getCode") {
        const [address, tag] = call.params as [string, string];
        result = parseInt(tag, 16) >= (DEPLOYED[address.toLowerCase()] ?? Infinity) ? "0x6080" : "0x";
      } else if (call.method === "eth_getBlockByNumber") {
        const n = parseInt(String(call.params[0]), 16);
        result = { number: `0x${n.toString(16)}`, timestamp: `0x${(1_700_000_000 + n * 2).toString(16)}`, hash: hash(n), parentHash: hash(n - 1) };
      } else if (call.method === "eth_getLogs") {
        const filter = call.params[0] as { address: string[]; fromBlock: string; toBlock: string };
        const from = parseInt(filter.fromBlock, 16), to = parseInt(filter.toBlock, 16);
        expect(filter.address.sort()).toEqual([QUEUE, FUND, LEGACY].sort());
        windows.push([from, to]);
        result = [40, 82].filter((n) => n >= from && n <= to).map((n) => logAt(n, 0));
      } else throw new Error(`unexpected RPC ${call.method}`);
      return { jsonrpc: "2.0", id: call.id, result };
    };
    return Response.json(Array.isArray(input) ? input.map(answer) : answer(input));
  } });
  const saved = { url: config.baseRpcUrl, rate: process.env.BASE_RPC_MAX_CALLS_PER_SEC, queue: process.env.FLOW_QUEUE_ADDRESS, fund: process.env.FLOW_FUND_ADDRESS, explorer: process.env.FLOW_EXPLORER_ADDRESSES, block: process.env.FLOW_INDEX_DEPLOY_BLOCK };
  config.baseRpcUrl = `http://127.0.0.1:${server.port}`;
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  process.env.FLOW_QUEUE_ADDRESS = QUEUE;
  process.env.FLOW_FUND_ADDRESS = FUND;
  process.env.FLOW_EXPLORER_ADDRESSES = LEGACY;
  delete process.env.FLOW_INDEX_DEPLOY_BLOCK;
  const logs = () => sql<{ block_number: string; block_hash: string; canonical: boolean }[]>`SELECT block_number, block_hash, canonical FROM flow_index_logs ORDER BY block_number, block_hash`;
  try {
    // Deploy-block discovery and the first bounded window: blocks 30..69.
    expect(await refreshFlowIndex()).toEqual({ indexedThrough: 69 });
    expect(windows).toEqual([[30, 69]]);
    const probes = calls.eth_getCode!;
    expect(probes).toBeGreaterThan(0);
    // The next window stops at the confirmed head, 100 - 12.
    expect(await refreshFlowIndex()).toEqual({ indexedThrough: 88 });
    expect(windows.at(-1)).toEqual([70, 88]);
    expect(calls.eth_getCode).toBe(probes); // the discovered floors are cached
    // Nothing new is confirmed: no scan, the watermark holds.
    expect(await refreshFlowIndex()).toEqual({ indexedThrough: 88 });
    expect(windows).toHaveLength(2);
    const checkpoints = await flowCheckpoints(sql, 8453);
    expect(checkpoints).toHaveLength(59);
    expect(checkpoints[0]).toMatchObject({ number: 88, hash: hash(88) });
    expect(checkpoints.at(-1)).toMatchObject({ number: 30, hash: hash(30) });
    expect((await logs()).map((row) => [Number(row.block_number), row.canonical])).toEqual([[40, true], [82, true]]);

    // Idempotent replay: rewind the persisted index and rescan the same chain.
    await sql.begin(async (tx) => { await flowRewind(tx, 8453, 50); });
    expect((await flowCheckpoints(sql, 8453))[0]!.number).toBe(50);
    expect(await refreshFlowIndex()).toEqual({ indexedThrough: 88 });
    expect(windows.at(-1)).toEqual([51, 88]);
    expect((await logs()).map((row) => [Number(row.block_number), row.block_hash, row.canonical])).toEqual([[40, hash(40), true], [82, hash(82), true]]);
    const [blockRows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM flow_index_blocks`;
    expect(blockRows!.n).toBe(59);

    // Reorg from block 80: the persisted branch is rolled back and replayed.
    const orphan = hash(82);
    forkFrom = 80;
    expect(await refreshFlowIndex()).toEqual({ indexedThrough: 88 });
    expect(windows.at(-1)).toEqual([80, 88]);
    const after = await flowCheckpoints(sql, 8453);
    expect(after).toHaveLength(59);
    expect(after[0]).toMatchObject({ number: 88, hash: hash(88) });
    expect(after.find((h) => h.number === 79)!.hash).toBe(`0x${(79).toString(16).padStart(64, "0")}`);
    expect((await logs()).map((row) => [Number(row.block_number), row.block_hash, row.canonical])).toEqual([[40, hash(40), true], [82, orphan, false], [82, hash(82), true]]);
    const [orphanBlocks] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM flow_index_blocks WHERE NOT canonical`;
    expect(orphanBlocks!.n).toBe(9);
  } finally {
    config.baseRpcUrl = saved.url;
    for (const [key, value] of [["BASE_RPC_MAX_CALLS_PER_SEC", saved.rate], ["FLOW_QUEUE_ADDRESS", saved.queue], ["FLOW_FUND_ADDRESS", saved.fund], ["FLOW_EXPLORER_ADDRESSES", saved.explorer], ["FLOW_INDEX_DEPLOY_BLOCK", saved.block]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.stop(true);
  }
});

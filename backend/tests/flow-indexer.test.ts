import { expect, test } from "bun:test";
import { scanFlowWindow, type FlowHeader, type FlowIndexSource, type FlowIndexStore, type FlowLog } from "../src/chain/flow-indexer.ts";

test("backfills confirmed blocks, resumes, and rewinds a reorg", async () => {
  let chain = new Map(Array.from({ length: 8 }, (_, i) => [i, { number: i, hash: `h${i}`, timestamp: i }]));
  let saved: FlowHeader[] = [];
  let events: FlowLog[] = [];
  const source: FlowIndexSource = {
    head: async () => 7,
    header: async (n) => chain.get(n)!,
    logs: async (from, to) => Array.from({ length: to - from + 1 }, (_, i) => {
      const blockNumber = from + i;
      return { blockNumber, blockHash: chain.get(blockNumber)!.hash, logIndex: 0, transactionHash: `tx${blockNumber}`, address: "a", topics: [], data: "0x" };
    }),
  };
  const store: FlowIndexStore = {
    checkpoints: async () => [...saved],
    rewind: async (n) => { saved = saved.filter((h) => h.number <= n); events = events.filter((e) => e.blockNumber <= n); },
    record: async (headers, logs) => { saved.push(...headers); events.push(...logs); },
  };
  const options = { deployBlock: 2, confirmations: 1, maxBlocks: 2 };
  expect(await scanFlowWindow(source, store, options)).toBe(3);
  expect(await scanFlowWindow(source, store, options)).toBe(5);
  chain = new Map([...chain].map(([n, h]) => [n, n >= 4 ? { ...h, hash: `new${n}` } : h]));
  expect(await scanFlowWindow(source, store, options)).toBe(5);
  expect(saved.map((h) => h.hash)).toEqual(["h2", "h3", "new4", "new5"]);
  expect(events.map((e) => e.blockHash)).toEqual(["h2", "h3", "new4", "new5"]);
  expect(await scanFlowWindow(source, store, options)).toBe(6);
  expect(await scanFlowWindow(source, store, options)).toBe(6);
  expect(saved).toHaveLength(5);
});

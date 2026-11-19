import { expect, test } from "bun:test";
import { MAX_LOGS_PER_WINDOW, scanFlowWindow, type FlowHeader, type FlowIndexSource, type FlowIndexStore, type FlowLog } from "../src/chain/flow-indexer.ts";

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

test("walks bounded checkpoint pages for a deep reorg", async () => {
  const saved = Array.from({ length: 300 }, (_, number) => ({ number, hash: `old${number}`, timestamp: number }));
  let rewound = -2;
  const store: FlowIndexStore = {
    checkpoints: async (before = Infinity) => saved.filter((h) => h.number < before).slice(-256).reverse(),
    rewind: async (n) => { rewound = n; },
    record: async () => {},
  };
  const source: FlowIndexSource = {
    head: async () => 300,
    header: async (number) => ({ number, hash: number <= 10 ? `old${number}` : `new${number}`, timestamp: number }),
    logs: async () => [],
  };
  expect(await scanFlowWindow(source, store, { deployBlock: 0, confirmations: 0, maxBlocks: 1 })).toBe(11);
  expect(rewound).toBe(10);
});

test("a window with more logs than one write may hold ends before the block that overflows it", async () => {
  const recorded: { headers: FlowHeader[]; logs: FlowLog[] }[] = [];
  const header = (number: number) => ({ number, hash: `h${number}`, timestamp: number });
  const source: FlowIndexSource = {
    head: async () => 100,
    header: async (n) => header(n),
    // 10 logs in every block from 1 to 100.
    logs: async (from, to) => Array.from({ length: (to - from + 1) * 10 }, (_, i) => ({ blockNumber: from + Math.floor(i / 10), blockHash: `h${from + Math.floor(i / 10)}`, logIndex: i % 10, transactionHash: `t${i}`, address: "a", topics: [], data: "0x" })),
  };
  const store: FlowIndexStore = { checkpoints: async () => [], rewind: async () => {}, record: async (headers, logs) => { recorded.push({ headers, logs }); } };
  expect(await scanFlowWindow(source, store, { deployBlock: 1, confirmations: 0, maxBlocks: 100 })).toBe(40);
  expect(recorded[0]!.logs).toHaveLength(MAX_LOGS_PER_WINDOW);
  expect(recorded[0]!.headers.map((h) => h.number)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
});

test("a tip that changes while logs are read refuses the window", async () => {
  let reads = 0;
  const source: FlowIndexSource = {
    head: async () => 10,
    header: async (n) => ({ number: n, hash: n === 10 && reads++ > 0 ? "moved" : `h${n}`, timestamp: n }),
    logs: async () => [],
  };
  const store: FlowIndexStore = { checkpoints: async () => [], rewind: async () => {}, record: async () => { throw new Error("must not record"); } };
  await expect(scanFlowWindow(source, store, { deployBlock: 1, confirmations: 0, maxBlocks: 10 })).rejects.toThrow("chain changed during scan");
});

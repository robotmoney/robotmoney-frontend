// The buyback scan's batched prefetch (chain/buyback-logs.ts).
//
// WHY THIS FILE EXISTS. `indexBuybacks` had no direct test at all — the only
// coverage touching `buyback_swaps` was the dashboard READ path — and it was
// about to be refactored from "two round trips per swap, serially" to "ten
// reads per POST". Refactoring an unread money-adjacent indexer with no test is
// how a silent miscount ships, so the test comes with the change.
//
// THE ASSERTION THAT MATTERS is not the request count, it is that the rows are
// the same. A scan that indexes fewer swaps, or pairs a swap with the wrong
// block's WETH leg, is worse than a slow one. So the first test pins the
// persisted rows exactly; the request count is checked second, and the
// degradation path third.
//
// fetch is mocked only at the process boundary; the real transport and the real
// scan execute. Offline, no skips.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { indexBuybacks, _resetBuybackScanCachesForTests } from "../src/chain/buyback-logs.ts";
import { _resetRpcConcurrencyForTests, _resetRpcRateLimiterForTests } from "../src/chain/base-rpc-client.ts";
import { _resetRateLimitStateForTests } from "../src/chain/gecko-rate-limit.ts";

const realFetch = globalThis.fetch;
const KNOBS = [
  "BASE_RPC_SOURCE",
  "PRICE_SOURCE",
  "BASE_RPC_MAX_CALLS_PER_SEC",
  "BASE_RPC_MAX_RETRIES",
  "ROBOTMONEY_ADDRESS",
  "WETH_ADDRESS",
  "PROP_WALLET_ADDRESSES",
] as const;

const WALLET = "0x" + "11".repeat(20);
const RM_TOKEN = "0x" + "22".repeat(20);
const WETH = "0x" + "33".repeat(20);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");
const hex = (n: number): string => "0x" + n.toString(16);

/** Three swaps, deliberately two of them in the SAME block: the block-keyed
 *  caches must serve both from one read, and the pairing must still be per-tx. */
const SWAPS = [
  { block: 43_741_700, tx: "0x" + "a1".repeat(32), rmIn: 10n, wethOut: 2n },
  { block: 43_741_700, tx: "0x" + "b2".repeat(32), rmIn: 20n, wethOut: 3n },
  { block: 43_741_850, tx: "0x" + "c3".repeat(32), rmIn: 30n, wethOut: 4n },
];
const BLOCK_TS: Record<number, number> = {
  43_741_700: Math.floor(Date.parse("2026-04-02T10:00:00Z") / 1000),
  43_741_850: Math.floor(Date.parse("2026-04-03T11:00:00Z") / 1000),
};

let posts: { method: string; batched: boolean }[] = [];

/** A node that answers the scan's three method shapes, single or batched. */
function serve(opts: { dropBatchEntries?: boolean } = {}): void {
  const answerOne = (method: string, params: unknown[]): unknown => {
    if (method === "eth_blockNumber") return hex(43_742_000);
    if (method === "eth_getBlockByNumber") {
      const n = parseInt(String(params[0]), 16);
      const ts = BLOCK_TS[n];
      return ts === undefined ? null : { number: hex(n), timestamp: hex(ts) };
    }
    if (method === "eth_getLogs") {
      const f = params[0] as { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string };
      const from = parseInt(f.fromBlock, 16);
      const to = parseInt(f.toBlock, 16);
      // The ROBOTMONEY-in scan (topic[2] = wallet) vs the WETH-out pairing read
      // (topic[1] = wallet). Distinguished by which topic slot is filled.
      if (f.topics[2]) {
        return SWAPS.filter((s) => s.block >= from && s.block <= to).map((s, i) => ({
          address: RM_TOKEN,
          topics: [TRANSFER_TOPIC, word(0n), word(BigInt(WALLET))],
          data: word(s.rmIn * 10n ** 18n),
          blockNumber: hex(s.block),
          transactionHash: s.tx,
          logIndex: hex(i),
        }));
      }
      return SWAPS.filter((s) => s.block >= from && s.block <= to).map((s, i) => ({
        address: WETH,
        topics: [TRANSFER_TOPIC, word(BigInt(WALLET)), word(0n)],
        data: word(s.wethOut * 10n ** 18n),
        blockNumber: hex(s.block),
        transactionHash: s.tx,
        logIndex: hex(i),
      }));
    }
    throw new Error(`unexpected method ${method}`);
  };

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (!String(url).includes("base.org") && !String(url).startsWith("http://127")) {
      // The WETH price feed (GeckoTerminal) — not the RPC. No candle: the scan
      // must still index the swap and persist a NULL value_usd.
      return new Response("nope", { status: 404 });
    }
    const body = JSON.parse(String(init.body));
    const batched = Array.isArray(body);
    const entries = batched ? body : [body];
    posts.push({ method: entries[0].method, batched });
    const out = entries.map((e: { id: number; method: string; params: unknown[] }, i: number) => {
      // Simulate a node that answers only part of a batch, to prove the caller
      // falls back per item rather than silently losing a swap.
      if (batched && opts.dropBatchEntries && i > 0) {
        return { jsonrpc: "2.0", id: e.id, error: { code: -32000, message: "dropped" } };
      }
      return { jsonrpc: "2.0", id: e.id, result: answerOne(e.method, e.params) };
    });
    return new Response(JSON.stringify(batched ? out : out[0]), { status: 200 });
  }) as unknown as typeof fetch;
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM buyback_swaps WHERE tx_hash = ANY(${SWAPS.map((s) => s.tx.toLowerCase())}::text[])`;
  await sql`DELETE FROM buyback_scan_state WHERE id = 1`;
}

beforeEach(async () => {
  posts = [];
  _resetBuybackScanCachesForTests();
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0"; // pacing is not what this file measures
  process.env.BASE_RPC_MAX_RETRIES = "0";
  process.env.GECKO_MIN_INTERVAL_MS = "0";
  process.env.ROBOTMONEY_ADDRESS = RM_TOKEN;
  process.env.WETH_ADDRESS = WETH;
  process.env.PROP_WALLET_ADDRESSES = WALLET;
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
  _resetRateLimitStateForTests();
  await cleanup();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of KNOBS) delete process.env[k];
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
  _resetRateLimitStateForTests();
  await cleanup();
});

test("the batched scan indexes every swap, paired to its OWN tx and dated by its OWN block", async () => {
  serve();
  const res = await indexBuybacks();
  expect(res.skipped).toBeNull();

  const rows = await sql<
    { tx_hash: string; block_number: string; occurred_on: Date; weth_spent: string; robotmoney_received: string; value_usd: string | null }[]
  >`
    SELECT tx_hash, block_number::text, occurred_on, weth_spent::text, robotmoney_received::text, value_usd::text
      FROM buyback_swaps WHERE tx_hash = ANY(${SWAPS.map((s) => s.tx.toLowerCase())}::text[])
     ORDER BY block_number, tx_hash
  `;
  expect(rows.length).toBe(3);

  for (const row of rows) {
    const swap = SWAPS.find((s) => s.tx.toLowerCase() === row.tx_hash)!;
    // Its own tx's WETH leg — NOT the block's total, which is what a careless
    // shared-per-block cache would produce for the two same-block swaps.
    expect(Number(row.weth_spent)).toBe(Number(swap.wethOut));
    expect(Number(row.robotmoney_received)).toBe(Number(swap.rmIn));
    expect(Number(row.block_number)).toBe(swap.block);
    // Dated from its own block's timestamp.
    expect(row.occurred_on.toISOString().slice(0, 10)).toBe(
      new Date(BLOCK_TS[swap.block]! * 1000).toISOString().slice(0, 10),
    );
    // No candle was served, so the honest value is NULL, never a stand-in.
    expect(row.value_usd).toBeNull();
  }
});

test("a chunk's block reads go out BATCHED — not two round trips per swap", async () => {
  serve();
  await indexBuybacks();

  const blockHeaderPosts = posts.filter((p) => p.method === "eth_getBlockByNumber");
  const logPosts = posts.filter((p) => p.method === "eth_getLogs");

  // Two distinct blocks across three swaps: ONE batched header POST, not three.
  expect(blockHeaderPosts.length).toBe(1);
  expect(blockHeaderPosts[0]!.batched).toBe(true);

  // The scan's own range query is unbatched; the per-block WETH pairing reads
  // ride one batched POST rather than one per swap.
  expect(logPosts.some((p) => p.batched)).toBe(true);
  expect(logPosts.filter((p) => !p.batched).length).toBeLessThanOrEqual(2);
});

test("when a batch answers only part of a window, the missing blocks are re-read — no swap is lost", async () => {
  // The degradation that matters: priming is an optimisation, so a partial batch
  // must cost extra round trips, never rows.
  serve({ dropBatchEntries: true });
  const res = await indexBuybacks();
  expect(res.skipped).toBeNull();

  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM buyback_swaps WHERE tx_hash = ANY(${SWAPS.map((s) => s.tx.toLowerCase())}::text[])
  `;
  expect(row!.n).toBe(3); // all three still indexed
});

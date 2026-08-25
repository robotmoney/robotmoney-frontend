// MULTI-BLOCK chain reads (readChainAmountsAtBlocks) — N days' worth of
// valuation in one POST instead of one POST per day.
//
// THIS FILE WAS WRITTEN BEFORE THE IMPLEMENTATION, on purpose. markets §7 says this
// is the one call site in the batching sweep where a mistake produces a
// plausible wrong NAV rather than a loud failure: round 2 (`convertToAssets`)
// consumes round 1's share balances, so a batched version that crosses the
// wires between two blocks would compute a real-looking total out of one day's
// shares and another day's exchange rate. Nothing about that would throw.
//
// So the central test is EQUIVALENCE against the path already in production:
// read each block one at a time with readChainAmountsBatched, read them all at
// once with readChainAmountsAtBlocks, and demand identical maps. The fixture
// deliberately answers every sub-call with a value derived from ITS OWN BLOCK
// TAG, so a batched implementation that reused one block's results for another
// cannot pass — with a block-independent fixture it would pass trivially and
// prove nothing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveTrackedAssets } from "../src/config.ts";
import {
  decodeAggregate3Calls,
  encodeAggregate3Result,
  _resetRpcConcurrencyForTests,
  _resetRpcRateLimiterForTests,
  type Aggregate3Result,
} from "../src/chain/base-rpc-client.ts";
import {
  readChainAmountsAtBlocks,
  readChainAmountsBatched,
  type ChainAmount,
  type KeyedAssetRead,
} from "../src/chain/wallet-valuation.ts";

const realFetch = globalThis.fetch;
const WALLET = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";
const TAGS = ["0x2a0000", "0x2a2a2a", "0x2b5555"];

const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

/** How many POSTs the mock saw, and the block tag each carried. */
let posts: { tags: string[]; batched: boolean }[] = [];

/**
 * A node whose answer depends on (block tag, sub-call index). The block-tag
 * dependence is the whole point: it is what makes "the batched path returns the
 * same thing" a real claim rather than a tautology.
 *
 * `failTag` makes ONE block's eth_call fail, to check per-block isolation.
 */
function stub(opts: { failTag?: string } = {}): void {
  const answerCall = (tag: string, data: string): { error?: true; result?: string } => {
    if (opts.failTag && tag === opts.failTag) return { error: true };
    const seed = BigInt(parseInt(tag, 16));
    const decoded = decodeAggregate3Calls(data);
    const results: Aggregate3Result[] = decoded.map((_c, i) => ({
      success: true,
      // Non-zero everywhere so the strategy legs carry vault shares and round 2
      // genuinely fires; distinct per (block, index) so any cross-wiring shows.
      returnData: word(seed * 1000n + BigInt(i + 1)),
    }));
    return { result: encodeAggregate3Result(results) };
  };

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const batched = Array.isArray(body);
    const entries = batched ? body : [body];
    const tags = entries.map((e: { params: unknown[] }) => String(e.params[1]));
    posts.push({ tags, batched });

    const answers = entries.map((e: { id: number; params: unknown[] }) => {
      const tag = String(e.params[1]);
      const data = (e.params[0] as { data: string }).data;
      const a = answerCall(tag, data);
      return a.error
        ? { jsonrpc: "2.0", id: e.id ?? 1, error: { code: -32000, message: `block ${tag} unavailable` } }
        : { jsonrpc: "2.0", id: e.id ?? 1, result: a.result };
    });
    return new Response(JSON.stringify(batched ? answers : answers[0]), { status: 200 });
  }) as unknown as typeof fetch;
}

/** erc20 + native + STRATEGY legs, so BOTH multicall rounds run. A strategy key
 *  is what exercises round 2's dependence on round 1. */
function reads(): KeyedAssetRead[] {
  const assets = resolveTrackedAssets();
  const pick = (s: string) => assets.find((a) => a.symbol === s)!;
  const out: KeyedAssetRead[] = [
    { key: "USDC", asset: pick("USDC"), wallets: [WALLET] },
    { key: "ETH", asset: pick("ETH"), wallets: [WALLET] },
  ];
  const strategy = assets.find((a) => a.valuationKind === "strategy");
  if (strategy) out.push({ key: strategy.symbol, asset: strategy, wallets: [WALLET] });
  return out;
}

function plain(m: Map<string, ChainAmount>): Record<string, ChainAmount> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

beforeEach(() => {
  posts = [];
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});

test("EQUIVALENCE: reading N blocks at once returns exactly what reading them one at a time returns", async () => {
  stub();
  const oneAtATime: Record<string, Record<string, ChainAmount>> = {};
  for (const tag of TAGS) {
    oneAtATime[tag] = plain(await readChainAmountsBatched(reads(), "single", { blockTag: tag }));
  }
  const singlePosts = posts.length;

  posts = [];
  const together = await readChainAmountsAtBlocks(reads(), "multi", TAGS, {});
  const batchedOut = Object.fromEntries(TAGS.map((t) => [t, plain(together.get(t)!)]));

  expect(batchedOut).toEqual(oneAtATime);
  // Sanity: the fixture really did vary by block, so the equality above is a
  // claim about the implementation and not about a constant.
  expect(oneAtATime[TAGS[0]!]).not.toEqual(oneAtATime[TAGS[1]!]);
  // And it cost strictly fewer round trips.
  expect(posts.length).toBeLessThan(singlePosts);
});

test("EQUIVALENCE holds with the silent-zero rail armed", async () => {
  stub();
  const oneAtATime: Record<string, Record<string, ChainAmount>> = {};
  for (const tag of TAGS) {
    oneAtATime[tag] = plain(await readChainAmountsBatched(reads(), "single", { blockTag: tag, strictEmptyReturn: true }));
  }
  posts = [];
  const together = await readChainAmountsAtBlocks(reads(), "multi", TAGS, { strictEmptyReturn: true });
  expect(Object.fromEntries(TAGS.map((t) => [t, plain(together.get(t)!)]))).toEqual(oneAtATime);
});

test("round 2 stays inside its own block — a strategy NAV never mixes two blocks' reads", async () => {
  // The specific cross-wiring this refactor could introduce. A strategy amount
  // is idle + convertToAssets(shares); if the batched path paired one block's
  // shares with another block's rate, the number would still look real.
  stub();
  const together = await readChainAmountsAtBlocks(reads(), "multi", TAGS, {});
  const strategyKey = reads().find((r) => r.asset.valuationKind === "strategy")?.key;
  if (!strategyKey) return; // no strategy asset configured in this deployment

  const perBlock = TAGS.map((t) => together.get(t)!.get(strategyKey)!);
  for (const a of perBlock) expect(a.ok).toBe(true);
  // Every block's strategy NAV differs, because every block's inputs did.
  const amounts = perBlock.map((a) => (a.ok ? a.amount : null));
  expect(new Set(amounts).size).toBe(TAGS.length);

  // And each equals what the single-block path computes for that block.
  for (let i = 0; i < TAGS.length; i++) {
    const solo = await readChainAmountsBatched(reads(), "single", { blockTag: TAGS[i]! });
    expect(solo.get(strategyKey)).toEqual(perBlock[i]!);
  }
});

test("the batched read is ONE POST for N blocks per round, not N", async () => {
  stub();
  await readChainAmountsAtBlocks(reads(), "multi", TAGS, {});
  // Round 1 for all three blocks, then round 2 for all three: two POSTs, each
  // carrying one aggregate3 per block.
  expect(posts.length).toBeLessThanOrEqual(2);
  expect(posts[0]!.batched).toBe(true);
  expect(posts[0]!.tags.sort()).toEqual([...TAGS].sort());
});

test("a block whose read fails degrades ONLY that block's keys", async () => {
  stub({ failTag: TAGS[1] });
  const together = await readChainAmountsAtBlocks(reads(), "multi", TAGS, {});

  const failed = together.get(TAGS[1]!)!;
  expect([...failed.values()].every((v) => !v.ok)).toBe(true);
  for (const tag of [TAGS[0]!, TAGS[2]!]) {
    const good = together.get(tag)!;
    expect([...good.values()].every((v) => v.ok)).toBe(true);
  }
});

test("an empty block list, and an empty read list, are no-ops", async () => {
  stub();
  expect((await readChainAmountsAtBlocks(reads(), "multi", [], {})).size).toBe(0);
  const emptyReads = await readChainAmountsAtBlocks([], "multi", TAGS, {});
  expect([...emptyReads.values()].every((m) => m.size === 0)).toBe(true);
  expect(posts.length).toBe(0);
});

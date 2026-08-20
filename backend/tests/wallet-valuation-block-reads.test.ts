// THE SILENT-ZERO RAIL, at the level that actually decides it (issue #709,
// §6.5.1 / §10). Offline: `globalThis.fetch` is stubbed and the real
// Multicall3 encode/decode path executes.
//
// The defect this pins is not hypothetical arithmetic. `decodeUint256` maps an
// empty `0x` to `0n` BY DESIGN — every live caller depends on that, and it is
// correct for a `latest` read of a deployed contract. For a read at a HISTORICAL
// block it is a fabrication: `success:true` with zero return bytes means there
// was no contract at that address at that block, and decoding it to 0 does not
// read a balance, it invents one. Inside a summed AUM total, an invented zero is
// indistinguishable from a real drawdown once written.
//
// So both directions are asserted here: strict mode FAILS the key, and the live
// path is byte-for-byte unchanged.
import { afterEach, expect, test } from "bun:test";
import { resolveTrackedAssets } from "../src/config.ts";
import {
  decodeAggregate3Calls,
  encodeAggregate3Result,
  _resetRpcConcurrencyForTests,
  _resetRpcRateLimiterForTests,
  type Aggregate3Result,
} from "../src/chain/base-rpc-client.ts";
import { readChainAmountsBatched, type KeyedAssetRead } from "../src/chain/wallet-valuation.ts";

const realFetch = globalThis.fetch;
const WALLET = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";
const ZERO_WORD = "0x" + "0".repeat(64);

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});

/** Answer every aggregate3 sub-call with `returnData`, and record the block tag
 *  each eth_call was issued at. */
function stubMulticall(returnDataFor: (index: number) => string): { blockTags: unknown[] } {
  const blockTags: unknown[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    blockTags.push(body.params[1]);
    const decoded = decodeAggregate3Calls((body.params[0] as { data: string }).data);
    const results: Aggregate3Result[] = decoded.map((_c, i) => ({ success: true, returnData: returnDataFor(i) }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { blockTags };
}

function erc20Reads(): KeyedAssetRead[] {
  const usdc = resolveTrackedAssets().find((a) => a.symbol === "USDC")!;
  const robotmoney = resolveTrackedAssets().find((a) => a.symbol === "ROBOTMONEY")!;
  return [
    { key: "USDC", asset: usdc, wallets: [WALLET] },
    { key: "ROBOTMONEY", asset: robotmoney, wallets: [WALLET] },
  ];
}

test("LIVE PATH UNCHANGED: an empty return still decodes to 0 when strict mode is off", async () => {
  stubMulticall((i) => (i === 0 ? "0x" : ZERO_WORD));
  const out = await readChainAmountsBatched(erc20Reads(), "test");
  const usdc = out.get("USDC")!;
  expect(usdc.ok).toBe(true);
  expect(usdc.ok && usdc.amount).toBe(0);
});

test("STRICT: an empty return FAILS its key — never a zero", async () => {
  stubMulticall((i) => (i === 0 ? "0x" : ZERO_WORD));
  const out = await readChainAmountsBatched(erc20Reads(), "test", { strictEmptyReturn: true });
  expect(out.get("USDC")!.ok).toBe(false);
  // ...and only its key. A neighbouring leg that answered honestly is untouched.
  const other = out.get("ROBOTMONEY")!;
  expect(other.ok).toBe(true);
  expect(other.ok && other.amount).toBe(0);
});

test("STRICT: a GENUINE zero (32 zero bytes) is still a real, usable zero", async () => {
  // The distinction that makes strict mode safe rather than merely paranoid: a
  // wallet that really held nothing that day reads 0 and the day still repairs.
  stubMulticall(() => ZERO_WORD);
  const out = await readChainAmountsBatched(erc20Reads(), "test", { strictEmptyReturn: true });
  for (const key of ["USDC", "ROBOTMONEY"]) {
    const amount = out.get(key)!;
    expect(amount.ok).toBe(true);
    expect(amount.ok && amount.amount).toBe(0);
  }
});

test("the blockTag reaches the wire through the batched reader", async () => {
  const stub = stubMulticall(() => ZERO_WORD);
  await readChainAmountsBatched(erc20Reads(), "test", { blockTag: "0x12d687" });
  expect(stub.blockTags).toContain("0x12d687");
});

test("no blockTag → 'latest', exactly as before", async () => {
  const stub = stubMulticall(() => ZERO_WORD);
  await readChainAmountsBatched(erc20Reads(), "test");
  expect(stub.blockTags.every((t) => t === "latest")).toBe(true);
});

// Base RPC client (backend/src/chain/base-rpc-client.ts): ABI encode/decode
// byte-exact fixtures + `eth_call` transport behavior against a mocked
// `fetch`. No network — every case here is fully offline (test-coverage
// policy: this suite must never depend on a reachable RPC).
import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeAddressArg,
  encodeTotalAssetsCall,
  encodeTotalSupplyCall,
  encodeBalanceOfCall,
  decodeUint256,
  ethCall,
} from "../src/chain/base-rpc-client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("selector encoding (well-known 4-byte selectors, byte-exact)", () => {
  test("totalAssets() selector", () => {
    expect(encodeTotalAssetsCall()).toBe("0x01e1d114");
  });

  test("totalSupply() selector", () => {
    expect(encodeTotalSupplyCall()).toBe("0x18160ddd");
  });

  test("balanceOf(address) selector + left-padded 32-byte address arg", () => {
    const holder = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";
    expect(encodeBalanceOfCall(holder)).toBe(
      "0x70a08231" + "0000000000000000000000004f835c9f54bcf17daf9040f60cb72951ccbb49dd",
    );
  });

  test("encodeAddressArg left-pads to 64 hex chars and lowercases", () => {
    expect(encodeAddressArg("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(
      "000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    );
    expect(encodeAddressArg("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").length).toBe(64);
  });

  test("encodeAddressArg rejects malformed addresses", () => {
    expect(() => encodeAddressArg("0xnotanaddress")).toThrow();
    expect(() => encodeAddressArg("0x1234")).toThrow();
  });
});

describe("decodeUint256 (byte-exact fixtures)", () => {
  test("decodes a 32-byte word to a bigint", () => {
    // 84320120000 raw units (6-decimal USDC: $84,320.12)
    const word = "0x" + (84320120000n).toString(16).padStart(64, "0");
    expect(word.length).toBe(66); // "0x" + 64 hex chars
    expect(decodeUint256(word)).toBe(84320120000n);
  });

  test("decodes zero", () => {
    expect(decodeUint256("0x0000000000000000000000000000000000000000000000000000000000000000")).toBe(0n);
  });

  test("decodes an empty result (`0x`, e.g. a call to a non-contract address) as 0n", () => {
    expect(decodeUint256("0x")).toBe(0n);
  });
});

describe("ethCall transport", () => {
  test("returns the JSON-RPC result on success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }), { status: 200 })) as unknown as typeof fetch;
    const result = await ethCall("0xabc", "0x18160ddd", { rpcUrl: "https://example.invalid" });
    expect(result).toBe("0x2a");
  });

  test("throws on a non-2xx HTTP status", async () => {
    globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    await expect(ethCall("0xabc", "0x18160ddd", { rpcUrl: "https://example.invalid" })).rejects.toThrow(/502/);
  });

  test("throws on a JSON-RPC error field", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(ethCall("0xabc", "0x18160ddd", { rpcUrl: "https://example.invalid" })).rejects.toThrow(/execution reverted/);
  });

  test("throws on a transport failure (network unreachable)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed: getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(ethCall("0xabc", "0x18160ddd", { rpcUrl: "https://example.invalid" })).rejects.toThrow();
  });

  test("throws when the response carries no result", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 })) as unknown as typeof fetch;
    await expect(ethCall("0xabc", "0x18160ddd", { rpcUrl: "https://example.invalid" })).rejects.toThrow(/missing result/);
  });
});

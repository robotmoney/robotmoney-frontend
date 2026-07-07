// Minimal Base JSON-RPC client: `eth_call` only, with just enough hand-rolled
// ABI encode/decode for the three read-only selectors this feature needs
// (ERC-4626 totalAssets(), ERC-20 totalSupply(), ERC-20 balanceOf(address)).
// No external chain SDK (ethers/viem) — plain `fetch` + well-known 4-byte
// selectors, matching this repo's buildless-backend philosophy (no dependency
// pulled in just to encode a static function selector + a single address arg).
//
// Selectors are the first 4 bytes of keccak256(signature) — standard, widely
// published values for these exact ERC-20/ERC-4626 signatures (not computed
// here, just hardcoded — there is no other selector for the same signature).
const SELECTORS = {
  totalAssets: "0x01e1d114", // totalAssets()
  totalSupply: "0x18160ddd", // totalSupply()
  balanceOf: "0x70a08231", // balanceOf(address)
} as const;

// Left-pad a 20-byte address into a 32-byte (64 hex char) ABI word.
export function encodeAddressArg(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid address: ${address}`);
  return hex.padStart(64, "0");
}

function encodeCall(selector: string, args: string[] = []): string {
  return selector + args.join("");
}

export const encodeTotalAssetsCall = (): string => encodeCall(SELECTORS.totalAssets);
export const encodeTotalSupplyCall = (): string => encodeCall(SELECTORS.totalSupply);
export const encodeBalanceOfCall = (holder: string): string => encodeCall(SELECTORS.balanceOf, [encodeAddressArg(holder)]);

// Decode a 32-byte (0x-prefixed hex) eth_call result word to a bigint. An empty
// `0x` (e.g. a call to an address with no code) decodes to 0n rather than
// throwing — callers decide from context whether 0n means "really zero" or
// "unreachable"; this function only decodes what it is given.
export function decodeUint256(hex: string): bigint {
  const clean = hex.replace(/^0x/, "");
  if (clean.length === 0) return 0n;
  return BigInt("0x" + clean);
}

export interface RpcCallOptions {
  rpcUrl: string;
  timeoutMs?: number;
}

// A single `eth_call`. Throws on transport failure, a non-2xx HTTP status, or a
// JSON-RPC `error` field — callers (chain/vault-economics.ts) catch this and
// degrade the response rather than propagate a 5xx or fabricate a number.
export async function ethCall(to: string, data: string, opts: RpcCallOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(opts.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(`Base RPC error: ${body.error.message ?? "unknown"}`);
    if (typeof body.result !== "string") throw new Error("Base RPC: missing result");
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callTotalAssets(contractAddress: string, opts: RpcCallOptions): Promise<bigint> {
  return decodeUint256(await ethCall(contractAddress, encodeTotalAssetsCall(), opts));
}

export async function callTotalSupply(contractAddress: string, opts: RpcCallOptions): Promise<bigint> {
  return decodeUint256(await ethCall(contractAddress, encodeTotalSupplyCall(), opts));
}

export async function callBalanceOf(tokenAddress: string, holder: string, opts: RpcCallOptions): Promise<bigint> {
  return decodeUint256(await ethCall(tokenAddress, encodeBalanceOfCall(holder), opts));
}

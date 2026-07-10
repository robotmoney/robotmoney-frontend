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
  convertToAssets: "0x07a2d13a", // convertToAssets(uint256) — ERC-4626 share→assets NAV
} as const;

// Left-pad a 20-byte address into a 32-byte (64 hex char) ABI word.
export function encodeAddressArg(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid address: ${address}`);
  return hex.padStart(64, "0");
}

// Left-pad a uint256 into a 32-byte (64 hex char) ABI word.
export function encodeUint256Arg(value: bigint): string {
  if (value < 0n) throw new Error(`invalid uint256: ${value}`);
  return value.toString(16).padStart(64, "0");
}

function encodeCall(selector: string, args: string[] = []): string {
  return selector + args.join("");
}

export const encodeTotalAssetsCall = (): string => encodeCall(SELECTORS.totalAssets);
export const encodeTotalSupplyCall = (): string => encodeCall(SELECTORS.totalSupply);
export const encodeBalanceOfCall = (holder: string): string => encodeCall(SELECTORS.balanceOf, [encodeAddressArg(holder)]);
export const encodeConvertToAssetsCall = (shares: bigint): string => encodeCall(SELECTORS.convertToAssets, [encodeUint256Arg(shares)]);

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

// The SINGLE JSON-RPC transport for every Base read in the app. Throws on
// transport failure, a non-2xx HTTP status, a JSON-RPC `error` field, or a
// missing `result` — callers (chain/*.ts) catch this and degrade the response
// rather than propagate a 5xx or fabricate a value. Every method below (and
// every chain module) issues its RPC through here so there is exactly one place
// that speaks JSON-RPC to Base; do NOT hand-roll a `fetch` to the RPC elsewhere.
export async function rpcRequest<T>(method: string, params: unknown[], opts: RpcCallOptions): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(opts.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`Base RPC error: ${body.error.message ?? "unknown"}`);
    if (body.result === undefined) throw new Error(`Base RPC: missing result for ${method}`);
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

// A single `eth_call`. Throws on transport failure, a non-2xx HTTP status, or a
// JSON-RPC `error` field — callers (chain/vault-economics.ts) catch this and
// degrade the response rather than propagate a 5xx or fabricate a number.
export async function ethCall(to: string, data: string, opts: RpcCallOptions): Promise<string> {
  const result = await rpcRequest<string>("eth_call", [{ to, data }, "latest"], opts);
  if (typeof result !== "string") throw new Error("Base RPC: missing result");
  return result;
}

// A single `eth_getLogs`. Same transport/error-handling contract as ethCall /
// ethGetBalance (throws on transport/HTTP/JSON-RPC error so callers degrade a
// single leg rather than propagate a 5xx or fabricate rows). Used by
// chain/buyback-logs.ts to read ROBOTMONEY Transfer events into the primary
// prop wallet. `params` is the raw eth_getLogs filter object (address, topics,
// fromBlock/toBlock as 0x-hex or a tag); the result is the raw log array which
// the caller decodes.
export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string; // 0x-hex
  transactionHash: string;
  logIndex: string; // 0x-hex
  [k: string]: unknown;
}
export interface EthGetLogsParams {
  address?: string | string[];
  topics?: (string | string[] | null)[];
  fromBlock?: string; // 0x-hex block number or tag ('earliest' | 'latest')
  toBlock?: string; // 0x-hex block number or tag
  blockHash?: string;
}
export async function ethGetLogs(params: EthGetLogsParams, opts: RpcCallOptions): Promise<EthLog[]> {
  const result = await rpcRequest<EthLog[]>("eth_getLogs", [params], opts);
  if (!Array.isArray(result)) throw new Error("Base RPC: missing result");
  return result;
}

// Latest block height (`eth_blockNumber`), decoded to a number. Same transport
// as every other read (chain/buyback-logs.ts uses it to bound a log scan).
export async function ethBlockNumber(opts: RpcCallOptions): Promise<number> {
  const result = await rpcRequest<string>("eth_blockNumber", [], opts);
  if (typeof result !== "string") throw new Error("Base RPC: missing result");
  return parseInt(result, 16);
}

export interface EthBlock {
  number: string; // 0x-hex
  timestamp: string; // 0x-hex unix seconds
  [k: string]: unknown;
}
// A single block header (`eth_getBlockByNumber`, no full tx bodies). Used to map
// a log's block number to its calendar day. Throws on a missing block.
export async function ethGetBlockByNumber(blockNumber: number, opts: RpcCallOptions): Promise<EthBlock> {
  const result = await rpcRequest<EthBlock | null>("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false], opts);
  if (!result?.timestamp) throw new Error(`Base RPC: no block ${blockNumber}`);
  return result;
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

// ERC-4626 NAV: how many underlying assets a given share count is worth right
// now. Used to value the yield-bearing strategy positions (ZYFAI-SS1/GIZA-SS1)
// at NAV rather than a $1-pegged share (issue #84).
export async function callConvertToAssets(strategyAddress: string, shares: bigint, opts: RpcCallOptions): Promise<bigint> {
  if (shares === 0n) return 0n;
  return decodeUint256(await ethCall(strategyAddress, encodeConvertToAssetsCall(shares), opts));
}

// A single `eth_getBalance` (native ETH balance in wei). Separate JSON-RPC
// method from eth_call — same transport/error-handling contract (throws on
// transport/HTTP/JSON-RPC error so callers can degrade a single leg).
export async function ethGetBalance(address: string, opts: RpcCallOptions): Promise<bigint> {
  const result = await rpcRequest<string>("eth_getBalance", [address, "latest"], opts);
  if (typeof result !== "string") throw new Error("Base RPC: missing result");
  return decodeUint256(result);
}

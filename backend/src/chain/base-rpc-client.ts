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
  asset: "0x38d52e0f", // asset() — ERC-4626 underlying token address
  decimals: "0x313ce567", // decimals() — ERC-20 token decimals
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
export const encodeAssetCall = (): string => encodeCall(SELECTORS.asset);
export const encodeDecimalsCall = (): string => encodeCall(SELECTORS.decimals);

// Decode a 32-byte (0x-prefixed hex) eth_call result word to a bigint. An empty
// `0x` (e.g. a call to an address with no code) decodes to 0n rather than
// throwing — callers decide from context whether 0n means "really zero" or
// "unreachable"; this function only decodes what it is given.
export function decodeUint256(hex: string): bigint {
  const clean = hex.replace(/^0x/, "");
  if (clean.length === 0) return 0n;
  return BigInt("0x" + clean);
}

// --- Multicall3 batch reads (rate-limit mitigation) --------------------------
// The public Base node 429s under the wallet-balances burst (every prop wallet ×
// every asset = ~two-dozen simultaneous eth_calls). Multicall3 — deployed at the
// SAME canonical address on Base as every other EVM chain — collapses that whole
// burst into ONE eth_call via aggregate3, which returns each sub-call's result
// with a per-call success flag (allowFailure) so one bad leg never reverts the
// batch. These are pure, hand-rolled ABI (encode/decode) helpers matching this
// file's no-SDK philosophy; multicall3Aggregate3() (below) is the one transport
// call. The single-call helpers (callBalanceOf etc.) remain for vault-economics/
// buyback which read one contract at a time.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_SELECTORS = {
  aggregate3: "0x82ad56cb", // aggregate3((address target,bool allowFailure,bytes callData)[])
  getEthBalance: "0x4d2301cc", // getEthBalance(address) — native ETH balance via Multicall3
} as const;

export interface Call3 {
  target: string;
  allowFailure: boolean;
  callData: string; // 0x-prefixed encoded calldata for the sub-call
}
export interface Aggregate3Result {
  success: boolean;
  returnData: string; // 0x-prefixed raw return bytes of the sub-call
}

// One 32-byte ABI word from a number/bigint.
const abiWord = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, "0");
// Right-pad a hex byte-string to a whole number of 32-byte words.
function rightPadWords(hexNo0x: string): string {
  const rem = hexNo0x.length % 64;
  return rem === 0 ? hexNo0x : hexNo0x + "0".repeat(64 - rem);
}

// Multicall3 getEthBalance(address) sub-call calldata (native ETH read).
export const encodeGetEthBalanceCall = (address: string): string =>
  MULTICALL3_SELECTORS.getEthBalance + encodeAddressArg(address);

// Encode `aggregate3(Call3[])` calldata. Call3[] is a dynamic array of dynamic
// tuples (address,bool,bytes): outer offset word (0x20), array length N, N
// element-offsets (relative to the start of the element region, i.e. right after
// the length word), then each element = target + allowFailure + inner-bytes
// offset (0x60) + byteLen + right-padded callData.
export function encodeAggregate3(calls: Call3[]): string {
  const n = calls.length;
  const elements = calls.map((c) => {
    const cd = c.callData.replace(/^0x/, "").toLowerCase();
    if (cd.length % 2 !== 0) throw new Error("aggregate3: callData must be whole bytes");
    const head = encodeAddressArg(c.target) + abiWord(c.allowFailure ? 1 : 0) + abiWord(0x60);
    const tail = abiWord(cd.length / 2) + rightPadWords(cd);
    return head + tail;
  });
  const offsets: string[] = [];
  let cursor = n * 32; // element region begins after the N offset words
  for (const el of elements) {
    offsets.push(abiWord(cursor));
    cursor += el.length / 2;
  }
  const array = abiWord(n) + offsets.join("") + elements.join("");
  return MULTICALL3_SELECTORS.aggregate3 + abiWord(0x20) + array;
}

// Inverse of encodeAggregate3: decode `aggregate3(Call3[])` CALLDATA back to the
// Call3[] it carries. Used by the hermetic stub + endpoint mock to answer a batch
// sub-call by sub-call. Tolerates the leading selector being present or absent.
export function decodeAggregate3Calls(calldata: string): Call3[] {
  let hex = calldata.replace(/^0x/, "").toLowerCase();
  if (hex.startsWith("82ad56cb")) hex = hex.slice(8);
  const wordAt = (b: number): string => hex.slice(b * 2, b * 2 + 64);
  const numAt = (b: number): number => Number(BigInt("0x" + (wordAt(b) || "0")));
  const arrStart = numAt(0); // outer offset (0x20)
  const n = numAt(arrStart);
  const elemsBase = arrStart + 32;
  const calls: Call3[] = [];
  for (let i = 0; i < n; i++) {
    const elemStart = elemsBase + numAt(elemsBase + i * 32);
    const target = "0x" + wordAt(elemStart).slice(24); // low 20 bytes of the word
    const allowFailure = numAt(elemStart + 32) !== 0;
    const dataStart = elemStart + numAt(elemStart + 64); // + inner offset-to-bytes
    const byteLen = numAt(dataStart);
    const callData = "0x" + hex.slice((dataStart + 32) * 2, (dataStart + 32) * 2 + byteLen * 2);
    calls.push({ target, allowFailure, callData });
  }
  return calls;
}

// Encode an `aggregate3` RETURN value: `(bool success,bytes returnData)[]`. Used
// by the stub/mock to synthesize a batch response. Symmetric to decodeAggregate3.
export function encodeAggregate3Result(results: Aggregate3Result[]): string {
  const n = results.length;
  const elements = results.map((r) => {
    const rd = r.returnData.replace(/^0x/, "").toLowerCase();
    if (rd.length % 2 !== 0) throw new Error("aggregate3 result: returnData must be whole bytes");
    const head = abiWord(r.success ? 1 : 0) + abiWord(0x40); // success + offset-to-bytes (2 words in)
    const tail = abiWord(rd.length / 2) + rightPadWords(rd);
    return head + tail;
  });
  const offsets: string[] = [];
  let cursor = n * 32;
  for (const el of elements) {
    offsets.push(abiWord(cursor));
    cursor += el.length / 2;
  }
  const array = abiWord(n) + offsets.join("") + elements.join("");
  return "0x" + abiWord(0x20) + array;
}

// Decode an `aggregate3` RETURN value `(bool success,bytes returnData)[]`: skip
// the outer offset word, read N, read N element-offsets, each element = success
// word + inner bytes-offset (0x40) + byteLen + data.
export function decodeAggregate3(resultHex: string): Aggregate3Result[] {
  const hex = resultHex.replace(/^0x/, "").toLowerCase();
  if (hex.length === 0) return [];
  const wordAt = (b: number): string => hex.slice(b * 2, b * 2 + 64);
  const numAt = (b: number): number => Number(BigInt("0x" + (wordAt(b) || "0")));
  const arrStart = numAt(0);
  const n = numAt(arrStart);
  const elemsBase = arrStart + 32;
  const out: Aggregate3Result[] = [];
  for (let i = 0; i < n; i++) {
    const elemStart = elemsBase + numAt(elemsBase + i * 32);
    const success = numAt(elemStart) !== 0;
    const dataStart = elemStart + numAt(elemStart + 32);
    const byteLen = numAt(dataStart);
    const returnData = "0x" + hex.slice((dataStart + 32) * 2, (dataStart + 32) * 2 + byteLen * 2);
    out.push({ success, returnData });
  }
  return out;
}

export interface RpcCallOptions {
  rpcUrl: string;
  timeoutMs?: number;
}

// --- Rate-limit hardening (issue: public-Base-RPC 429 storm) ------------------
// The free public Base RPC (https://mainnet.base.org) 429s under the concurrent
// burst that a single dashboard read fans out (every holding leg × every prop
// wallet, dozens of simultaneous eth_calls). Two complementary controls, BOTH
// applied inside this one transport so every caller inherits them without
// touching its fan-out:
//
//   1. A module-level concurrency GATE that serializes the burst into small
//      waves (this is what actually prevents the 429 storm), and
//   2. Bounded RETRY-with-backoff on transient statuses (429/502/503/504),
//      honoring Retry-After, so a momentary rate-limit blip self-heals.
//
// HONESTY CONTRACT (unchanged): retry masks a transient blip, NEVER a genuine
// outage. After retries are exhausted rpcRequest STILL THROWS so callers degrade
// that single leg to its last-persisted `stale` sample — it never fabricates a
// value nor falsely reports `live`. Non-transient failures (JSON-RPC `error`,
// missing `result`, a non-transient non-2xx like 400/500) throw IMMEDIATELY with
// no retry. The AbortController timeout still bounds total work: if the signal
// aborts mid-fetch or mid-backoff we stop retrying and throw.

// Transient HTTP statuses worth a retry: 429 (rate limited) plus the 502/503/504
// gateway/overload family. A 500/400/401/etc. is a hard error — no retry.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
// Hard ceiling on any single backoff wait so a hostile/huge Retry-After can't
// stall a request longer than the AbortController timeout would anyway.
const MAX_BACKOFF_MS = 30_000;

// Env knobs, read at CALL time (not module load) so tests/deployments can flip
// them. Fall back to the documented default on unset/empty/garbage.
function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}
function maxConcurrency(): number {
  return intEnv("BASE_RPC_MAX_CONCURRENCY", 4, 1);
}
function maxRetries(): number {
  return intEnv("BASE_RPC_MAX_RETRIES", 3, 0);
}
function retryBaseMs(): number {
  return intEnv("BASE_RPC_RETRY_BASE_MS", 250, 1);
}

// Hand-rolled async semaphore (no dependency — this repo is buildless). A slot
// is transferred directly to the next waiter on release so `inFlight` is always
// exactly the number of running-or-about-to-run requests, bounding peak
// simultaneous fetches at the configured cap.
let inFlight = 0;
const waiters: Array<() => void> = [];
function acquireSlot(): Promise<void> {
  if (inFlight < maxConcurrency()) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot straight to the next waiter; inFlight unchanged
  else inFlight--;
}

// Test-only hygiene hook: reset the gate between suites. Not used in prod.
export function _resetRpcConcurrencyForTests(): void {
  inFlight = 0;
  waiters.length = 0;
}

// Parse a Retry-After header (RFC 7231): either delta-seconds or an HTTP-date.
// Returns the wait in ms, or null when absent/unparseable.
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

// Backoff for the Nth retry (1-based). Honor Retry-After when present; otherwise
// exponential (base × 2^(n-1)) plus full-base jitter, capped at MAX_BACKOFF_MS.
function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = parseRetryAfterMs(retryAfterHeader);
  if (retryAfter !== null) return Math.min(retryAfter, MAX_BACKOFF_MS);
  const base = retryBaseMs();
  const exp = base * Math.pow(2, attempt - 1);
  const jitter = Math.random() * base;
  return Math.min(exp + jitter, MAX_BACKOFF_MS);
}

// Sleep that rejects the moment the request's AbortController fires (timeout), so
// a retry loop can never outlive the request's overall deadline.
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Base RPC aborted before retry"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Base RPC aborted (timeout) during retry backoff"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// The SINGLE JSON-RPC transport for every Base read in the app. Throws on
// transport failure, a non-2xx HTTP status (after exhausting bounded retries on
// transient statuses), a JSON-RPC `error` field, or a missing `result` — callers
// (chain/*.ts) catch this and degrade the response rather than propagate a 5xx or
// fabricate a value. Every method below (and every chain module) issues its RPC
// through here so there is exactly one place that speaks JSON-RPC to Base; do NOT
// hand-roll a `fetch` to the RPC elsewhere.
export async function rpcRequest<T>(method: string, params: unknown[], opts: RpcCallOptions): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const retries = maxRetries();
  try {
    for (let attempt = 0; ; attempt++) {
      // Acquire a concurrency slot per network attempt (and release it during any
      // backoff sleep, so a waiting request is never blocked by one that is just
      // sitting out its backoff).
      await acquireSlot();
      let res: Response;
      try {
        res = await fetch(opts.rpcUrl, {
          method: "POST",
          // A User-Agent is a small robustness win: the public Base node 403s a
          // header-less POST. Content-Type stays required for JSON-RPC.
          headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
          body,
          signal: controller.signal,
        });
      } finally {
        releaseSlot();
      }

      if (res.ok) {
        const parsed = (await res.json()) as { result?: T; error?: { message?: string } };
        if (parsed.error) throw new Error(`Base RPC error: ${parsed.error.message ?? "unknown"}`);
        if (parsed.result === undefined) throw new Error(`Base RPC: missing result for ${method}`);
        return parsed.result;
      }

      // Non-2xx. Retry only transient statuses, only while retries remain, and
      // only if the request hasn't already been aborted by its timeout.
      if (TRANSIENT_STATUSES.has(res.status) && attempt < retries && !controller.signal.aborted) {
        await sleepOrAbort(backoffMs(attempt + 1, res.headers.get("retry-after")), controller.signal);
        continue;
      }
      // Exhausted / non-transient: THROW so the caller degrades to stale. Never
      // fabricate, never report live off a dead endpoint.
      throw new Error(`Base RPC HTTP ${res.status}`);
    }
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

// ERC-4626 asset(): the vault's underlying token, decoded from the low 20 bytes
// of the returned word to a 0x-prefixed address. An empty `0x` return (a call to
// an address with no code) THROWS rather than fabricating the zero address —
// callers (projects/access/live-source.ts) catch this and degrade the whole
// vault read to its last-persisted row.
export async function callAsset(vaultAddress: string, opts: RpcCallOptions): Promise<string> {
  const raw = (await ethCall(vaultAddress, encodeAssetCall(), opts)).replace(/^0x/, "");
  if (raw.length < 40) throw new Error(`Base RPC: empty asset() result from ${vaultAddress}`);
  return "0x" + raw.slice(-40);
}

// ERC-20 decimals(), decoded to a plain number. An empty `0x` decodes to 0 (see
// decodeUint256) — callers decide the fallback from context (live-source falls
// back to 18 on a 0/garbage decode, matching the legacy edge function).
export async function callDecimals(tokenAddress: string, opts: RpcCallOptions): Promise<number> {
  return Number(decodeUint256(await ethCall(tokenAddress, encodeDecimalsCall(), opts)));
}

// Batch many reads into ONE eth_call via Multicall3 aggregate3. Returns one
// {success,returnData} per input call, IN ORDER. Throws (like every read here)
// only on a transport/HTTP/JSON-RPC failure of the batch itself — an individual
// sub-call that reverts comes back as {success:false} (allowFailure), NOT a
// throw, so the caller degrades just that leg. This is the single-eth_call path
// wallet-balances uses to avoid the 429 storm.
export async function multicall3Aggregate3(calls: Call3[], opts: RpcCallOptions): Promise<Aggregate3Result[]> {
  if (calls.length === 0) return [];
  const result = await ethCall(MULTICALL3_ADDRESS, encodeAggregate3(calls), opts);
  return decodeAggregate3(result);
}

// A single `eth_getBalance` (native ETH balance in wei). Separate JSON-RPC
// method from eth_call — same transport/error-handling contract (throws on
// transport/HTTP/JSON-RPC error so callers can degrade a single leg).
export async function ethGetBalance(address: string, opts: RpcCallOptions): Promise<bigint> {
  const result = await rpcRequest<string>("eth_getBalance", [address, "latest"], opts);
  if (typeof result !== "string") throw new Error("Base RPC: missing result");
  return decodeUint256(result);
}

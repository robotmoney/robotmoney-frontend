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
  /**
   * BLOCK-ADDRESSED READS (issue #709 / docs/technical/data-self-healing.md
   * §6.5.1). The block tag every `eth_call` / `eth_getBalance` issued through
   * this transport is evaluated at. Omitted — which is every live caller —
   * resolves to `"latest"` at the two call sites below, byte-for-byte the
   * behaviour that existed before this field.
   *
   * This is NOT the archive indexer D16 rejected: it is a parameter on reads
   * the app already makes, against the node it already reads (the default
   * `https://mainnet.base.org` answers archive state queries). No new vendor,
   * no new host, no persisted chain-event store. #709 carries the argument and
   * the scope fence.
   *
   * D17 makes this module the SINGLE shared transport for every live chain
   * feed, so this field is inherited by thirteen exported functions with zero
   * signature changes — which is exactly why the default must stay
   * `?? "latest"` and why a change here is reviewed as a transport change.
   *
   * Accepts a 0x-hex block number (see `toBlockTag`) or a tag
   * ("latest" | "earliest" | "safe" | "finalized" | "pending").
   */
  blockTag?: string;
}

/** 0x-hex block-number form of `blockNumber`, for `RpcCallOptions.blockTag`. */
export function toBlockTag(blockNumber: number): string {
  if (!Number.isInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`invalid block number: ${blockNumber}`);
  }
  return "0x" + blockNumber.toString(16);
}

/**
 * True when an `eth_call` (or an aggregate3 sub-call) returned ZERO BYTES.
 *
 * THE SILENT-ZERO SEAM (§10's chain rail). `0x` means "there is no contract at
 * this address AT THIS BLOCK" — for a block-addressed read that is the normal
 * answer for a day before the target was deployed. `decodeUint256` maps it to
 * `0n` deliberately (see its comment) and every live caller depends on that,
 * so this predicate exists for callers that must tell the two apart BEFORE
 * decoding. A backfill that decodes `0x` to `0` does not read a balance of
 * zero; it fabricates one.
 *
 * Live-path semantics are unchanged: nothing on the live path calls this.
 */
export function isEmptyReturnData(returnData: string): boolean {
  return returnData.replace(/^0x/, "").length === 0;
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
// value nor falsely reports `live`. Non-transient failures (a contract-revert
// JSON-RPC `error`, missing `result`, a non-transient non-2xx like 400/500) throw
// IMMEDIATELY with no retry. The AbortController timeout still bounds total work:
// if the signal aborts mid-fetch or mid-backoff we stop retrying and throw.

// Transient HTTP statuses worth a retry: 429 (rate limited) plus the 502/503/504
// gateway/overload family. A 500/400/401/etc. is a hard error — no retry.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
// Base's public RPC also reports throttling as HTTP 200 with JSON-RPC code
// -32016 (`over rate limit`). Treat that exact provider-declared condition like
// HTTP 429. Do not message-match generic errors: execution reverts and other
// hard JSON-RPC failures must remain immediate so retry cannot hide bad calls.
const TRANSIENT_RPC_ERROR_CODES = new Set([-32016]);
// Hard ceiling on any single backoff wait so a hostile/huge Retry-After can't
// stall a request longer than the AbortController timeout would anyway.
const MAX_BACKOFF_MS = 30_000;

/** How long a caller may wait for a RATE token before giving up. Not a network
 *  timeout — see acquireRateToken(). Generous by default: at the 0.25 calls/s
 *  default this allows a queue of ~15 callers ahead of you. */
const DEFAULT_BUDGET_WAIT_MS = 60_000;
function budgetWaitMs(): number {
  return intEnv("BASE_RPC_BUDGET_WAIT_MS", DEFAULT_BUDGET_WAIT_MS, 1);
}

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

// --- The shared RPC RATE budget (token bucket) -------------------------------
// CONCURRENCY IS NOT RATE. The gate above bounds how many requests are in
// flight; it paces nothing. On the worker's analytics lane in-flight never
// exceeds 1 anyway (worker/loop.ts claims LIMIT 1 serially), so the gate is
// INERT there — which is why production saw a real HTTP 429 storm from the
// public Base RPC on 2026-08-10 (issue #651). This is the missing control: a
// token bucket that meters CALLS PER SECOND.
//
// IT IS ONE BUCKET, ON PURPOSE. The provider meters PER-IP, so in-process
// isolation cannot create budget — a backfill with its own limiter running
// beside the live sampler sums to 2x against one per-IP bucket and guarantees
// 429s, i.e. it would CAUSE new gaps while repairing old ones. Every read in
// the app goes through rpcRequest, so every read — live sampler, request path,
// and the wallet backfill (ops/wallet-backfill.ts) alike — draws from this one
// bucket. Do not add a second limiter anywhere.
//
// PACED BY DEFAULT, since v0.3.0. This used to read "UNSET = DISABLED,
// byte-for-byte today's behaviour", and it deliberately did: §6.5.3 asked for
// the bucket's parameters to be configuration rather than a constant, because
// the only measurements anyone had were taken from a developer IP and PD6
// required them re-derived from the production droplet first.
//
// That is still true of the *measurement*, and it is now handled differently.
// The provider publishes NO rate limit at all — docs.base.org says only that
// the public endpoints "are rate-limited and not suitable for production
// traffic", with no number — so waiting for an authoritative figure waits
// forever, and waiting for an operator to measure one meant the gap repair
// (#709) shipped inert and stayed inert. A conservative constant that is
// WRONG-BUT-SAFE beats an unset knob that is unpaced-and-off:
//
//   * The default is well under the measured refill, not at it, so being
//     wrong about production's real limit costs throughput and not 429s.
//   * It is self-correcting downward: noteRateLimitExhaustion() drains the
//     bucket on every 429/-32016, so a limit LOWER than we guessed is absorbed
//     by the limiter instead of storming (which is exactly what the unpaced
//     transport could not do on 2026-08-10).
//   * It is overridable upward or off by env, so a deployment that DOES measure
//     its own budget still owns the number.
//
// WHERE THE DEFAULT COMES FROM (docs/technical/data-self-healing.md §6.3,
// §6.5.3 — measured from a developer IP against https://mainnet.base.org):
// a ~5-token bucket refilling at ~0.55 calls/s, metered PER-IP and per
// sub-call, no Retry-After header. The sustained rate validated with zero
// errors was ~0.5 calls/s (540 logical reads in 38.2s via Multicall3). The live
// per-minute wallet samplers draw ~0.033 calls/s of that.
//
// 0.25 calls/s is that measurement halved: it leaves ~55% of the measured
// budget unused as margin for the production droplet's IP being strictly worse
// (shared NAT — §6.3's closing note), while still being ~7.5x what the live
// samplers consume, so pacing is invisible to them. The backfill spends the
// remainder and converges over successive hourly runs, which is what its
// per-run cap already assumes.
//
// IT IS ONE BUCKET AND ONE DEFAULT FOR THE WHOLE APP. There is no per-caller
// rate, and the backfill does not get its own — see the note above. A sweep in
// progress therefore paces the request path too; that contention is PD6's open
// question, and the answer to it is a keyed provider on its own bucket, not a
// second limiter here.
const RATE_PER_SEC_ENV = "BASE_RPC_MAX_CALLS_PER_SEC";
const RATE_BURST_ENV = "BASE_RPC_RATE_BURST";

/** Conservative shared default: half the measured ~0.55 calls/s refill. */
export const DEFAULT_RATE_PER_SEC = 0.25;
/** Default bucket capacity = the measured provider bucket depth (~5 tokens).
 *  NOT ceil(rate), which would be 1 here and would serialize even a single
 *  wallet sample (2 eth_calls) across two refill intervals. */
export const DEFAULT_RATE_BURST = 5;

interface RateBudget {
  ratePerSec: number;
  burst: number;
}

/**
 * The budget in force, or null ONLY when pacing has been explicitly turned off.
 * Read at CALL time like every other knob in this file.
 *
 *   unset / blank / unparseable → the conservative default above.
 *     Unparseable falls back to the default rather than to null on purpose: a
 *     typo'd value must not silently restore the unpaced transport.
 *   <= 0                        → null. The explicit opt-out, and the one way
 *     back to pre-#709 behaviour: no pacing anywhere, and ops.repair_gaps
 *     refuses to dispatch (ops/wallet-backfill.ts::assertRpcBudgetConfigured).
 *   > 0                         → that rate.
 */
export function resolveRpcRateBudget(env: Record<string, string | undefined> = process.env): RateBudget | null {
  const raw = env[RATE_PER_SEC_ENV];
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  // Explicitly zero/negative is a decision to disable; anything unreadable is
  // not, and falls back to the safe default.
  if (Number.isFinite(parsed) && parsed <= 0) return null;
  const ratePerSec = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_PER_SEC;
  const rawBurst = env[RATE_BURST_ENV];
  const parsedBurst = rawBurst === undefined || rawBurst === "" ? NaN : Number(rawBurst);
  const burst =
    Number.isFinite(parsedBurst) && parsedBurst >= 1
      ? Math.floor(parsedBurst)
      : Math.max(DEFAULT_RATE_BURST, Math.ceil(ratePerSec));
  return { ratePerSec, burst };
}

let bucketTokens = 0;
let bucketLastRefillMs = 0;
let bucketPrimed = false;

function refillBucket(budget: RateBudget, now: number): void {
  if (!bucketPrimed) {
    // Start FULL: a cold process is not owed a penalty, and the burst is what
    // absorbs an ordinary same-tick fan-out (one wallet sample = 2 eth_calls).
    bucketTokens = budget.burst;
    bucketLastRefillMs = now;
    bucketPrimed = true;
    return;
  }
  const elapsedMs = now - bucketLastRefillMs;
  if (elapsedMs <= 0) return;
  bucketTokens = Math.min(budget.burst, bucketTokens + (elapsedMs / 1000) * budget.ratePerSec);
  bucketLastRefillMs = now;
}

// Wait until one token is available, then spend it. Waiters re-check after each
// sleep rather than assuming their turn, so a herd waking together still spends
// exactly one token each.
//
// ⚠ THIS WAIT IS NOT INSIDE A REQUEST DEADLINE, AND MUST NOT BE. An earlier
// revision acquired the token inside the AbortController armed for the request
// and claimed "pacing can never outlive the AbortController timeout" — true in
// the trivial sense that the sleep aborts, and badly wrong as a safety property.
// At the shipped default of 0.25 calls/s a drained bucket costs 4000 ms per
// token against an 8000 ms deadline, so HALF the request's budget was spent
// queueing before a byte moved; noteRateLimitExhaustion() then drains the bucket
// on every 429, so each retry paid a fresh 4s toll and BASE_RPC_MAX_RETRIES=3
// was really 2. Worse, one deadline spanning a multi-chunk batch made >1 chunk
// abort unconditionally — reachable just by raising
// WALLET_BACKFILL_MAX_DAYS_PER_RUN above the batch size. Observed in the field
// as `Base RPC aborted (timeout) during retry backoff` on a run that was only
// ever being paced.
//
// Callers now arm their deadline around the NETWORK attempt only. Waiting for
// budget is not a request timing out; it is the limiter working.
async function acquireRateToken(): Promise<void> {
  const budget = resolveRpcRateBudget();
  if (!budget) return;
  // BOUNDED, even though the bucket always eventually refills. Taking the token
  // wait out of the request deadline fixed paced requests being reported as
  // timeouts, but it must not replace a wrong bound with none: waiters serialize,
  // so the k-th caller behind a sweep waits roughly k/ratePerSec seconds, and the
  // request path shares this bucket with the backfill by design (PD6). An
  // unbounded wait there turns "slow dashboard" into "hung dashboard".
  //
  // This ceiling is deliberately far above any single wait — one token at the
  // 0.25/s default is 4s — so reaching it means a QUEUE, not a slow refill. The
  // error says so, because the failure it replaces was misread for exactly this
  // reason: `Base RPC aborted (timeout) during retry backoff` on a run that was
  // only ever being paced.
  const deadline = Date.now() + budgetWaitMs();
  for (;;) {
    refillBucket(budget, Date.now());
    if (bucketTokens >= 1) {
      bucketTokens -= 1;
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Base RPC: still waiting for rate budget after ${Math.round(budgetWaitMs() / 1000)}s ` +
          `(BASE_RPC_MAX_CALLS_PER_SEC=${budget.ratePerSec}/s, burst ${budget.burst}) — ` +
          "the shared bucket is queued, not the endpoint slow. Raise the rate or reduce concurrent chain work.",
      );
    }
    const waitMs = Math.ceil(((1 - bucketTokens) / budget.ratePerSec) * 1000);
    await sleep(Math.min(Math.max(waitMs, 1), MAX_BACKOFF_MS, Math.max(deadline - Date.now(), 1)));
  }
}

// Provider-declared exhaustion (HTTP 429, or JSON-RPC -32016 — the same
// condition on this provider) feeds BACK into the bucket rather than only into
// the retry backoff: the bucket is drained, so the next call — this request's
// retry or any OTHER caller's first attempt — waits out a full refill interval
// instead of walking straight into the same wall. Without this the limiter
// learns nothing from being told it is over budget.
function noteRateLimitExhaustion(): void {
  if (!resolveRpcRateBudget()) return;
  bucketTokens = 0;
  bucketLastRefillMs = Date.now();
  bucketPrimed = true;
}

/** Test-only hygiene hook: forget the bucket between suites. Not used in prod. */
export function _resetRpcRateLimiterForTests(): void {
  bucketTokens = 0;
  bucketLastRefillMs = 0;
  bucketPrimed = false;
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

// Plain sleep, for waits that are NOT part of a network attempt: pacing and
// retry backoff. Both are bounded on their own — the bucket by its refill rate,
// backoff by MAX_BACKOFF_MS and a finite retry count — so neither needs, or
// should be cut short by, a request deadline. See acquireRateToken().
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}


// The SINGLE JSON-RPC transport for every Base read in the app. Throws on
// transport failure, a non-2xx HTTP status (after exhausting bounded retries on
// transient statuses), a JSON-RPC `error` field, or a missing `result` — callers
// (chain/*.ts) catch this and degrade the response rather than propagate a 5xx or
// fabricate a value. Every method below (and every chain module) issues its RPC
// through here so there is exactly one place that speaks JSON-RPC to Base; do NOT
// hand-roll a `fetch` to the RPC elsewhere.
export async function rpcRequest<T>(method: string, params: unknown[], opts: RpcCallOptions): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const retries = maxRetries();
  const timeoutMs = opts.timeoutMs ?? 8000;
  {
    for (let attempt = 0; ; attempt++) {
      // Spend a RATE token before taking a concurrency slot — a request that is
      // only waiting for budget must not hold a slot while it waits. No-op when
      // the budget is unconfigured (see resolveRpcRateBudget). Deliberately
      // OUTSIDE the deadline armed below: see acquireRateToken().
      await acquireRateToken();
      // Acquire a concurrency slot per network attempt (and release it during any
      // backoff sleep, so a waiting request is never blocked by one that is just
      // sitting out its backoff).
      await acquireSlot();
      // ONE DEADLINE PER NETWORK ATTEMPT. `timeoutMs` means "how long this POST
      // may take", which is the only thing it can honestly bound — a single
      // deadline stretched across pacing, backoff and every retry made a paced
      // request indistinguishable from a hung one.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        clearTimeout(timeout);
        releaseSlot();
      }

      if (res.ok) {
        const parsed = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
        if (parsed.error) {
          if (parsed.error.code != null && TRANSIENT_RPC_ERROR_CODES.has(parsed.error.code)) {
            // Told we are over budget: drain the shared bucket whether or not
            // this particular request has retries left, so the NEXT caller pays
            // for it too. (No-op when no budget is configured.)
            noteRateLimitExhaustion();
          }
          if (
            parsed.error.code != null &&
            TRANSIENT_RPC_ERROR_CODES.has(parsed.error.code) &&
            attempt < retries
          ) {
            await sleep(backoffMs(attempt + 1, null));
            continue;
          }
          throw new Error(
            `Base RPC error${parsed.error.code == null ? "" : ` ${parsed.error.code}`}: ${parsed.error.message ?? "unknown"}`,
          );
        }
        if (parsed.result === undefined) throw new Error(`Base RPC: missing result for ${method}`);
        return parsed.result;
      }

      // Non-2xx. Retry only transient statuses, while retries remain. Retry-After
      // is now honorable: the wait is no longer competing with the request's own
      // deadline, so a header above ~7s stops guaranteeing an abort instead of
      // compliance.
      if (res.status === 429) noteRateLimitExhaustion(); // same feedback as -32016 above
      if (TRANSIENT_STATUSES.has(res.status) && attempt < retries) {
        await sleep(backoffMs(attempt + 1, res.headers.get("retry-after")));
        continue;
      }
      // Exhausted / non-transient: THROW so the caller degrades to stale. Never
      // fabricate, never report live off a dead endpoint.
      throw new Error(`Base RPC HTTP ${res.status}`);
    }
  }
}

// ── JSON-RPC array batching (the per-HIT optimisation) ───────────────────────
//
// WHY THIS EXISTS, AND WHY MULTICALL3 IS NOT ENOUGH. The provider meters
// REQUEST FREQUENCY, not bytes: one POST carrying fifty calls costs the same
// budget as one POST carrying one. Multicall3 (above) already exploits that for
// reads that share a block — 27 balanceOf reads collapse into ONE eth_call. But
// `aggregate3` executes at a SINGLE block, so it cannot span block tags, and it
// cannot carry node methods (`eth_getBlockByNumber`, `eth_blockNumber`) at all
// because those are not contract calls.
//
// That is exactly the shape of the backfill's cost. A repaired day needs its own
// block tag, so N days are N eth_calls that no aggregate3 can merge; and locating
// those blocks is ~80% of the spend, entirely in node methods. JSON-RPC array
// batching is the only mechanism that merges either one — many request objects in
// one HTTP POST — and it is what this function adds.
//
// ONE POST = ONE TOKEN. `acquireRateToken` is spent per POST here exactly as in
// rpcRequest, so a 50-call batch draws 1 token instead of 50. The saving is not
// incidental to the limiter; it IS the optimisation, and it needs no change to
// the bucket.
//
// A SIBLING OF rpcRequest, NOT A REPLACEMENT. The single-call path is left
// byte-for-byte as it was: every live caller (the request path, the sampler)
// still issues exactly the request it issued before, with the same error
// messages. Sharing a retry loop between the two would have made a change to
// the batch path a change to the live read path, which is not a trade worth
// taking on a release branch that just shipped the pacing this sits under.
//
// PARTIAL FAILURE IS A VALUE, NOT A THROW — the same contract multicall3
// aggregate3 already establishes with `allowFailure`. One reverted or throttled
// sub-call must not discard the other forty-nine, so per-entry errors come back
// in the result array and the CALLER decides. Only a failure of the BATCH
// itself (transport, HTTP, unparseable envelope) throws.

/** One call in a JSON-RPC batch: the same (method, params) pair rpcRequest takes. */
export interface BatchCall {
  method: string;
  params: unknown[];
}

/** Per-entry outcome, positionally aligned with the input array. */
export type BatchResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code?: number; message: string } };

/** Default cap on calls per POST — MEASURED, not guessed.
 *
 *  The public Base node enforces a STRUCTURAL cap of 10 and answers an oversized
 *  batch with HTTP **200** carrying a single object, not a partial array:
 *
 *    {"jsonrpc":"2.0","error":{"code":-32014,"message":"maximum 10 calls in 1 batch"},"id":null}
 *
 *  Re-measured 2026-08-22 against mainnet.base.org, confirming the figure
 *  docs/technical/data-self-healing.md §6.5.3 recorded. The 200 status is the
 *  trap: a caller that checks only the HTTP code reads a wholesale rejection as
 *  a success, which is exactly how an early draft of this change measured a
 *  batch of 100 as "working". The transport treats a non-array body as a
 *  batch-level failure and THROWS for that reason.
 *
 *  Chunking at the cap is what keeps the -32014 path unreachable in normal
 *  operation; override via BASE_RPC_MAX_BATCH_SIZE for a provider that allows
 *  more. */
export const DEFAULT_MAX_BATCH_SIZE = 10;
function maxBatchSize(): number {
  return intEnv("BASE_RPC_MAX_BATCH_SIZE", DEFAULT_MAX_BATCH_SIZE, 1);
}

/** A JSON-RPC error entry, normalised. Missing/garbage shapes still produce a
 *  message so a caller never has to read `undefined` to learn it failed. */
function toBatchError(e: { code?: number; message?: string } | undefined): { code?: number; message: string } {
  return { ...(e?.code == null ? {} : { code: e.code }), message: e?.message ?? "unknown" };
}

/**
 * Issue `calls` as JSON-RPC array batches and return one outcome per call, IN
 * INPUT ORDER.
 *
 * Chunked at `maxBatchSize()`; each chunk is one POST costing one rate token.
 * Responses are matched by `id`, never by position — JSON-RPC 2.0 explicitly
 * permits a server to answer a batch in any order, and trusting position would
 * silently attribute one day's balance to another day.
 *
 * RETRY IS TWO-LEVEL, because the two failures are different failures:
 *   * the POST failed (transport, 429, 5xx) → retry the WHOLE chunk, with the
 *     same bounded backoff rpcRequest uses.
 *   * individual entries came back throttled (-32016) inside an otherwise fine
 *     200 → retry ONLY those entries. Re-sending the whole chunk to rescue one
 *     poisoned entry would spend the budget this function exists to save.
 * A hard per-entry error (a revert, a bad param) is NOT retried: it is returned,
 * exactly as `allowFailure` returns `{success:false}`.
 */
export async function rpcBatchRequest<T>(
  calls: readonly BatchCall[],
  opts: RpcCallOptions,
): Promise<BatchResult<T>[]> {
  if (calls.length === 0) return [];
  const retries = maxRetries();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const out = new Array<BatchResult<T>>(calls.length);
  const size = maxBatchSize();

  // ONE DEADLINE PER POST, not one per invocation. A single deadline spanning
  // the chunk loop below made any batch larger than `size` abort by
  // construction: each chunk costs at least one rate token, and at the shipped
  // 0.25 calls/s that is 4s of the 8s budget apiece. `calls.length` here is
  // one-per-day for the backfill, so raising WALLET_BACKFILL_MAX_DAYS_PER_RUN
  // past BASE_RPC_MAX_BATCH_SIZE — two independent knobs, no relationship
  // documented between them — silently guaranteed every resolver round failed.
  {
    for (let start = 0; start < calls.length; start += size) {
      const chunk = calls.slice(start, start + size);
      // Indices INTO `calls` that this pass must still answer. Shrinks to just
      // the throttled entries on a per-entry retry.
      let pending = chunk.map((_, i) => start + i);

      for (let attempt = 0; ; attempt++) {
        const body = JSON.stringify(
          pending.map((idx, i) => ({ jsonrpc: "2.0", id: i, method: calls[idx]!.method, params: calls[idx]!.params })),
        );

        // Same ordering as rpcRequest: budget first, then a concurrency slot, so
        // a request only waiting on the bucket never holds a slot. Both sit
        // OUTSIDE the per-POST deadline armed immediately below.
        await acquireRateToken();
        await acquireSlot();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let res: Response;
        try {
          res = await fetch(opts.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          releaseSlot();
        }

        if (!res.ok) {
          if (res.status === 429) noteRateLimitExhaustion();
          if (TRANSIENT_STATUSES.has(res.status) && attempt < retries) {
            await sleep(backoffMs(attempt + 1, res.headers.get("retry-after")));
            continue;
          }
          throw new Error(`Base RPC batch HTTP ${res.status}`);
        }

        const parsed = (await res.json()) as
          | { id?: number; result?: T; error?: { code?: number; message?: string } }[]
          | { error?: { code?: number; message?: string } };

        // A single envelope object instead of an array is how endpoints report a
        // batch-level refusal (oversized batch, malformed body). That is a failure
        // of the BATCH, so it throws rather than being spread over the entries.
        if (!Array.isArray(parsed)) {
          const err = toBatchError(parsed?.error);
          if (err.code != null && TRANSIENT_RPC_ERROR_CODES.has(err.code)) noteRateLimitExhaustion();
          throw new Error(`Base RPC batch error${err.code == null ? "" : ` ${err.code}`}: ${err.message}`);
        }

        const byId = new Map<number, { result?: T; error?: { code?: number; message?: string } }>();
        for (const entry of parsed) if (typeof entry?.id === "number") byId.set(entry.id, entry);

        const throttled: number[] = [];
        for (let i = 0; i < pending.length; i++) {
          const idx = pending[i]!;
          const entry = byId.get(i);
          if (entry === undefined) {
            // Answered nothing for this id. Not retried as throttling — a server
            // that drops entries is not a server that is over budget.
            out[idx] = { ok: false, error: { message: `Base RPC batch: no response for ${calls[idx]!.method}` } };
            continue;
          }
          if (entry.error) {
            const err = toBatchError(entry.error);
            if (err.code != null && TRANSIENT_RPC_ERROR_CODES.has(err.code)) {
              noteRateLimitExhaustion();
              throttled.push(idx);
              continue;
            }
            out[idx] = { ok: false, error: err };
            continue;
          }
          if (entry.result === undefined) {
            out[idx] = { ok: false, error: { message: `Base RPC batch: missing result for ${calls[idx]!.method}` } };
            continue;
          }
          out[idx] = { ok: true, result: entry.result };
        }

        if (throttled.length > 0 && attempt < retries) {
          pending = throttled;
          await sleep(backoffMs(attempt + 1, res.headers.get("retry-after")));
          continue;
        }
        // Out of retries with entries still throttled: report them as failed
        // rather than looping. An unread day must keep LOOKING unread.
        for (const idx of throttled) {
          out[idx] = { ok: false, error: { code: -32016, message: "Base RPC batch: over rate limit (retries exhausted)" } };
        }
        break;
      }
    }
    return out;
  }
}

// A single `eth_call`. Throws on transport failure, a non-2xx HTTP status, or a
// JSON-RPC `error` field — callers (chain/vault-economics.ts) catch this and
// degrade the response rather than propagate a 5xx or fabricate a number.
export async function ethCall(to: string, data: string, opts: RpcCallOptions): Promise<string> {
  // `?? "latest"` is the load-bearing default: a caller that passes no blockTag
  // (every live caller) issues exactly the request it issued before #709.
  const result = await rpcRequest<string>("eth_call", [{ to, data }, opts.blockTag ?? "latest"], opts);
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

// MANY block headers in ONE POST. The batched twin of ethGetBlockByNumber, and
// the reason rpcBatchRequest exists: block resolution is a node method, so it
// can never ride inside an aggregate3, and it is the dominant RPC cost of a
// backfill (§6.5.1 — ≤8 probes per day against a per-IP-metered provider).
//
// Positional, and per-entry: a block that is missing or errored comes back as
// `{ok:false}` beside its siblings rather than discarding the batch. The
// `!result?.timestamp` check mirrors the single-call version — a header without
// a timestamp is not a block we can date, whatever else it contains.
export async function ethGetBlockByNumberBatch(
  blockNumbers: readonly number[],
  opts: RpcCallOptions,
): Promise<BatchResult<EthBlock>[]> {
  const raw = await rpcBatchRequest<EthBlock | null>(
    blockNumbers.map((n) => ({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), false] })),
    opts,
  );
  return raw.map((r, i) =>
    !r.ok
      ? r
      : r.result?.timestamp
        ? ({ ok: true, result: r.result } as const)
        : ({ ok: false, error: { message: `Base RPC: no block ${blockNumbers[i]}` } } as const),
  );
}

/** One `eth_call` in a batch, carrying its OWN block tag — which is the whole
 *  point: aggregate3 cannot span blocks, so N days need N of these. */
export interface BatchEthCall {
  to: string;
  data: string;
  /** Omitted resolves to "latest", matching ethCall's load-bearing default. */
  blockTag?: string;
}

// MANY eth_calls in ONE POST, each at its own block. Composes with Multicall3
// rather than replacing it: the right shape for a multi-day read is N aggregate3
// payloads (one per day, each collapsing that day's ~27 reads) sent as ONE
// batched POST — the two batchings multiply, 27×N reads for a single token.
export async function ethCallBatch(
  calls: readonly BatchEthCall[],
  opts: RpcCallOptions,
): Promise<BatchResult<string>[]> {
  return await rpcBatchRequest<string>(
    calls.map((c) => ({ method: "eth_call", params: [{ to: c.to, data: c.data }, c.blockTag ?? opts.blockTag ?? "latest"] })),
    opts,
  );
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
  // Same `?? "latest"` default as ethCall — the second and last hardcoded block
  // tag in the backend before #709.
  const result = await rpcRequest<string>("eth_getBalance", [address, opts.blockTag ?? "latest"], opts);
  if (typeof result !== "string") throw new Error("Base RPC: missing result");
  return decodeUint256(result);
}

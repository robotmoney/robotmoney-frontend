// Transport-level coverage for backend/src/chain/base-rpc-client.ts's
// rate-limit hardening (the public-Base-RPC 429 storm fix): the concurrency
// GATE and the bounded RETRY-with-backoff. These are fully offline — every
// assertion mocks `globalThis.fetch` and executes the real transport, matching
// tests/vault-economics.test.ts. They gate every PR (no skips, no network).
//
// HONESTY (CLAUDE.md test-coverage policy): retry masks a transient blip, never a
// genuine outage. The exhausted-retries test proves rpcRequest STILL THROWS so a
// caller degrades a leg to `stale` rather than fabricating a value. Waits are
// forced tiny via BASE_RPC_RETRY_BASE_MS so the suite stays fast.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  rpcRequest,
  _resetRpcConcurrencyForTests,
  encodeAggregate3,
  decodeAggregate3,
  decodeAggregate3Calls,
  encodeAggregate3Result,
  encodeBalanceOfCall,
  encodeGetEthBalanceCall,
  decodeUint256,
  multicall3Aggregate3,
  ethGetTransactionByHash,
  ethGetTransactionReceipt,
  MULTICALL3_ADDRESS,
  type Call3,
  type Aggregate3Result,
} from "../src/chain/base-rpc-client.ts";

const realFetch = globalThis.fetch;
const RPC = "https://mainnet.base.org";
const OK = { rpcUrl: RPC, timeoutMs: 5000 };

const KNOBS = [
  "BASE_RPC_MAX_CONCURRENCY",
  "BASE_RPC_MAX_RETRIES",
  "BASE_RPC_RETRY_BASE_MS",
  "BASE_RPC_MAX_CALLS_PER_SEC",
  "BASE_RPC_RETRY_TOTAL_MS",
] as const;

function okResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}
function status(code: number, headers?: Record<string, string>): Response {
  return new Response("rate limited", { status: code, headers });
}
function rpcError(code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status: 200 });
}

beforeEach(() => {
  // Keep retries plentiful but each backoff ~instant so the suite is quick.
  process.env.BASE_RPC_RETRY_BASE_MS = "1";
  // Pacing OFF for this file. The transport now paces by default (0.25 calls/s
  // — chain/base-rpc-client.ts::DEFAULT_RATE_PER_SEC), and a 429 deliberately
  // DRAINS that bucket, so every retry assertion below would otherwise measure
  // a 4-second refill instead of the backoff it is about. The token bucket's
  // own behaviour is covered in tests/base-rpc-block-addressing.test.ts.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  _resetRpcConcurrencyForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KNOBS) delete process.env[k];
  _resetRpcConcurrencyForTests();
});

test("a 429-then-200 sequence retries and ultimately returns the result", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? status(429) : okResult("0xabc");
  }) as unknown as typeof fetch;

  const out = await rpcRequest<string>("eth_call", [{}, "latest"], OK);
  expect(out).toBe("0xabc");
  expect(calls).toBe(2); // one 429, then success
});

test("all three transient statuses (429/502/503/504) recover before returning", async () => {
  for (const code of [429, 502, 503, 504]) {
    _resetRpcConcurrencyForTests();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? status(code) : okResult("0x1");
    }) as unknown as typeof fetch;
    const out = await rpcRequest<string>("eth_blockNumber", [], OK);
    expect(out).toBe("0x1");
    expect(calls).toBe(2);
  }
});

test("Retry-After header (delta-seconds) is honored: the retry waits ~that long", async () => {
  // 0 seconds keeps the test fast while still proving the header path drives the
  // wait (parseRetryAfterMs returns 0ms → an immediate retry that still succeeds).
  let calls = 0;
  const started = Date.now();
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? status(429, { "Retry-After": "0" }) : okResult("0xfeed");
  }) as unknown as typeof fetch;

  const out = await rpcRequest<string>("eth_call", [{}, "latest"], OK);
  expect(out).toBe("0xfeed");
  expect(calls).toBe(2);
  // Sanity: honoring "0" must not stall for a whole exponential backoff window.
  expect(Date.now() - started).toBeLessThan(1000);
});

test("Retry-After as an HTTP-date in the past yields an immediate (0ms) retry", async () => {
  let calls = 0;
  const past = new Date(Date.now() - 60_000).toUTCString();
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? status(429, { "Retry-After": past }) : okResult("0x2");
  }) as unknown as typeof fetch;
  const out = await rpcRequest<string>("eth_call", [{}, "latest"], OK);
  expect(out).toBe("0x2");
  expect(calls).toBe(2);
});

test("persistent 429 with retries EXHAUSTED still THROWS (caller degrades to stale)", async () => {
  process.env.BASE_RPC_MAX_RETRIES = "2";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return status(429);
  }) as unknown as typeof fetch;

  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/Base RPC HTTP 429/);
  expect(calls).toBe(3); // initial attempt + 2 retries, then throw
});

test("BASE_RPC_MAX_RETRIES=0 disables retry: a single 429 throws immediately", async () => {
  process.env.BASE_RPC_MAX_RETRIES = "0";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return status(429);
  }) as unknown as typeof fetch;
  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/Base RPC HTTP 429/);
  expect(calls).toBe(1);
});

test("Base JSON-RPC -32016 over-rate-limit then success retries and returns the result", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? rpcError(-32016, "over rate limit") : okResult("0xabc");
  }) as unknown as typeof fetch;

  const out = await rpcRequest<string>("eth_call", [{}, "latest"], OK);
  expect(out).toBe("0xabc");
  expect(calls).toBe(2);
});

test("persistent Base JSON-RPC -32016 exhausts retries and still throws", async () => {
  process.env.BASE_RPC_MAX_RETRIES = "2";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return rpcError(-32016, "over rate limit");
  }) as unknown as typeof fetch;

  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/-32016.*over rate limit/);
  expect(calls).toBe(3);
});

test("a non-transient HTTP status (400) throws IMMEDIATELY with no retry", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return status(400);
  }) as unknown as typeof fetch;
  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/Base RPC HTTP 400/);
  expect(calls).toBe(1); // no retry on a hard error
});

test("HTTP 500 is treated as non-transient: throws immediately, no retry", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return status(500);
  }) as unknown as typeof fetch;
  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/Base RPC HTTP 500/);
  expect(calls).toBe(1);
});

test("a hard JSON-RPC contract error throws IMMEDIATELY with no retry", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return rpcError(3, "execution reverted");
  }) as unknown as typeof fetch;
  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/execution reverted/);
  expect(calls).toBe(1);
});

test("a 200 with a missing `result` throws IMMEDIATELY with no retry", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  await expect(rpcRequest<string>("eth_call", [{}, "latest"], OK)).rejects.toThrow(/missing result/);
  expect(calls).toBe(1);
});

test("the concurrency cap bounds simultaneous in-flight fetches", async () => {
  process.env.BASE_RPC_MAX_CONCURRENCY = "4";
  _resetRpcConcurrencyForTests();

  let live = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    live++;
    peak = Math.max(peak, live);
    // Hold the slot briefly so a burst genuinely overlaps.
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return okResult("0x0");
  }) as unknown as typeof fetch;

  // Launch far more requests than the cap all at once.
  await Promise.all(Array.from({ length: 24 }, () => rpcRequest<string>("eth_call", [{}, "latest"], OK)));
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(4);
});

test("a lower concurrency cap is respected too (serialization proof, cap=1)", async () => {
  process.env.BASE_RPC_MAX_CONCURRENCY = "1";
  _resetRpcConcurrencyForTests();
  let live = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
    return okResult("0x0");
  }) as unknown as typeof fetch;
  await Promise.all(Array.from({ length: 8 }, () => rpcRequest<string>("eth_call", [{}, "latest"], OK)));
  expect(peak).toBe(1);
});

test("a never-satisfied retry loop is bounded by its own ceiling, not by timeoutMs", async () => {
  // WHAT BOUNDS THIS, AND WHY IT IS NOT `timeoutMs`. The AbortController is armed
  // per NETWORK ATTEMPT, so it bounds one POST and says nothing about how long
  // retrying runs. With a high retry count and nothing watching the clock, this
  // loop ran for HOURS — retries × MAX_BACKOFF_MS — which is what hung this file
  // and, through it, killed backend CI at GitHub's 6h job ceiling. The bound is
  // BASE_RPC_RETRY_TOTAL_MS, set tiny here so the assertion is about the property
  // rather than about waiting.
  process.env.BASE_RPC_MAX_RETRIES = "1000";
  process.env.BASE_RPC_RETRY_BASE_MS = "50";
  process.env.BASE_RPC_RETRY_TOTAL_MS = "150";
  let calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    // Respect the abort signal like real fetch: reject if already aborted.
    if (init?.signal?.aborted) throw new Error("aborted");
    return status(429);
  }) as unknown as typeof fetch;
  const started = Date.now();
  await expect(
    rpcRequest<string>("eth_call", [{}, "latest"], { rpcUrl: RPC, timeoutMs: 60 }),
  ).rejects.toThrow(/retry loop hit its .*ceiling/);
  // Bounded in WALL CLOCK, which is the property that regressed — a retry count
  // alone would have let this run for hours while still "passing".
  expect(Date.now() - started).toBeLessThan(5_000);
  // And it genuinely retried rather than giving up on the first 429.
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThan(1000);
});

// ── Multicall3 aggregate3 ABI (the 429-storm fix: collapse the wallet-balances
// burst into ONE eth_call). Pure encode/decode round-trips — no network. ───────

const ADDR_A = "0x" + "ab".repeat(20);
const ADDR_B = "0x" + "cd".repeat(20);
const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

test("encodeAggregate3 produces the exact bytes for a known single balanceOf batch", async () => {
  const call: Call3 = { target: ADDR_A, allowFailure: true, callData: encodeBalanceOfCall(ADDR_B) };
  const enc = encodeAggregate3([call]).replace(/^0x/, "");
  // selector | outer offset(0x20) | len(1) | elem-offset(0x20) | target | allowFailure(1) | bytesOff(0x60) | byteLen(0x24=36) | balanceOf calldata (72 hex, right-padded to 128)
  const cd = encodeBalanceOfCall(ADDR_B).replace(/^0x/, ""); // 4-byte selector + 32-byte addr = 36 bytes
  const expected =
    "82ad56cb" +
    "20".padStart(64, "0") + // outer offset
    "1".padStart(64, "0") + // array length
    "20".padStart(64, "0") + // offset to element 0 (one offset word ⇒ 0x20)
    ADDR_A.replace(/^0x/, "").padStart(64, "0") + // target
    "1".padStart(64, "0") + // allowFailure = true
    "60".padStart(64, "0") + // inner offset to bytes
    "24".padStart(64, "0") + // callData byte length (36)
    (cd + "0".repeat(128 - cd.length)); // right-padded to 2 words
  expect(enc).toBe(expected);
});

test("encodeAggregate3 → decodeAggregate3Calls round-trips a mixed balanceOf + getEthBalance batch", async () => {
  const calls: Call3[] = [
    { target: ADDR_A, allowFailure: true, callData: encodeBalanceOfCall(ADDR_B) },
    { target: MULTICALL3_ADDRESS, allowFailure: true, callData: encodeGetEthBalanceCall(ADDR_A) },
    { target: ADDR_B, allowFailure: false, callData: encodeBalanceOfCall(ADDR_A) },
  ];
  const decoded = decodeAggregate3Calls(encodeAggregate3(calls));
  expect(decoded).toHaveLength(3);
  expect(decoded[0]!.target).toBe(ADDR_A.toLowerCase());
  expect(decoded[0]!.allowFailure).toBe(true);
  expect(decoded[0]!.callData).toBe(encodeBalanceOfCall(ADDR_B).toLowerCase());
  expect(decoded[1]!.target).toBe(MULTICALL3_ADDRESS.toLowerCase());
  expect(decoded[1]!.callData).toBe(encodeGetEthBalanceCall(ADDR_A).toLowerCase());
  expect(decoded[2]!.allowFailure).toBe(false); // preserved verbatim
  expect(decoded[2]!.callData).toBe(encodeBalanceOfCall(ADDR_A).toLowerCase());
});

test("encodeAggregate3Result → decodeAggregate3 round-trips per-call values incl. an allowFailure success:false", async () => {
  const results: Aggregate3Result[] = [
    { success: true, returnData: word(1234n) },
    { success: false, returnData: "0x" }, // a reverted allowFailure sub-call (empty return)
    { success: true, returnData: word(5n * 10n ** 18n) },
  ];
  const decoded = decodeAggregate3(encodeAggregate3Result(results));
  expect(decoded).toHaveLength(3);
  expect(decoded[0]!.success).toBe(true);
  expect(decodeUint256(decoded[0]!.returnData)).toBe(1234n);
  expect(decoded[1]!.success).toBe(false); // the failed leg is decoded as success:false
  expect(decoded[1]!.returnData).toBe("0x");
  expect(decoded[2]!.success).toBe(true);
  expect(decodeUint256(decoded[2]!.returnData)).toBe(5n * 10n ** 18n);
});

test("multicall3Aggregate3 issues exactly ONE eth_call for a many-call batch and returns per-call results in order", async () => {
  _resetRpcConcurrencyForTests();
  let ethCalls = 0;
  const calls: Call3[] = Array.from({ length: 12 }, (_, i) => ({
    target: ADDR_A,
    allowFailure: true,
    callData: encodeBalanceOfCall(ADDR_B),
  }));
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    ethCalls++;
    const body = JSON.parse(String(init?.body)) as { method: string; params: any[] };
    expect(body.method).toBe("eth_call");
    const decoded = decodeAggregate3Calls((body.params[0] as { data: string }).data);
    // Answer each sub-call with its index so ordering is verifiable.
    const results: Aggregate3Result[] = decoded.map((_c, i) => ({ success: true, returnData: word(BigInt(i)) }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), { status: 200 });
  }) as unknown as typeof fetch;

  const out = await multicall3Aggregate3(calls, { rpcUrl: RPC, timeoutMs: 5000 });
  expect(ethCalls).toBe(1); // twelve reads → ONE eth_call (the whole point)
  expect(out).toHaveLength(12);
  expect(out.map((r) => Number(decodeUint256(r.returnData)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  globalThis.fetch = realFetch;
});

test("multicall3Aggregate3 with no calls makes zero network requests", async () => {
  let ethCalls = 0;
  globalThis.fetch = (async () => {
    ethCalls++;
    return okResult("0x");
  }) as unknown as typeof fetch;
  const out = await multicall3Aggregate3([], { rpcUrl: RPC });
  expect(out).toEqual([]);
  expect(ethCalls).toBe(0);
  globalThis.fetch = realFetch;
});

// ── Transaction and receipt reads (issue 1358, Linear RM-174) ────────────────
// The referral report reads a deposit's calldata and its receipt logs. Each test
// drives the real transport against a stubbed fetch and asserts the JSON-RPC
// request the node would receive, the parsed result, and the null answer a node
// gives for a hash it does not know.

const TX_HASH = "0x" + "12".repeat(32);

/** Stub fetch with one answer and record every JSON-RPC body sent. */
function captureFetch(result: unknown): { method: string; params: unknown[] }[] {
  const sent: { method: string; params: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return okResult(result);
  }) as unknown as typeof fetch;
  return sent;
}

test("ethGetTransactionByHash sends eth_getTransactionByHash with the hash and returns the parsed input", async () => {
  const input = "0x6e553f65" + "00".repeat(64) + "80218021802180218021802180218021";
  const sent = captureFetch({ hash: TX_HASH, from: ADDR_A, to: ADDR_B, input, blockNumber: "0x10" });
  const tx = await ethGetTransactionByHash(TX_HASH, OK);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe("eth_getTransactionByHash");
  expect(sent[0]!.params).toEqual([TX_HASH]);
  expect(tx?.input).toBe(input);
  expect(tx?.from).toBe(ADDR_A);
  expect(tx?.blockNumber).toBe("0x10");
});

test("ethGetTransactionByHash answers null for a hash the node does not know", async () => {
  captureFetch(null);
  expect(await ethGetTransactionByHash(TX_HASH, OK)).toBeNull();
});

test("ethGetTransactionByHash throws on a transaction with no input, never returning an empty one", async () => {
  captureFetch({ hash: TX_HASH, from: ADDR_A, to: ADDR_B, blockNumber: "0x10" });
  await expect(ethGetTransactionByHash(TX_HASH, OK)).rejects.toThrow(/without input/);
});

test("ethGetTransactionReceipt sends eth_getTransactionReceipt with the hash and returns the parsed logs", async () => {
  const log = {
    address: ADDR_B,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    data: word(5_000_000n),
    blockNumber: "0x10",
    transactionHash: TX_HASH,
    logIndex: "0x0",
  };
  const sent = captureFetch({ transactionHash: TX_HASH, from: ADDR_A, to: ADDR_B, status: "0x1", blockNumber: "0x10", logs: [log] });
  const receipt = await ethGetTransactionReceipt(TX_HASH, OK);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe("eth_getTransactionReceipt");
  expect(sent[0]!.params).toEqual([TX_HASH]);
  expect(receipt?.status).toBe("0x1");
  expect(receipt?.logs).toEqual([log]);
});

test("ethGetTransactionReceipt answers null for a hash the node does not know", async () => {
  captureFetch(null);
  expect(await ethGetTransactionReceipt(TX_HASH, OK)).toBeNull();
});

test("ethGetTransactionReceipt throws on a receipt with no logs, never returning an empty list", async () => {
  captureFetch({ transactionHash: TX_HASH, from: ADDR_A, to: ADDR_B, status: "0x1", blockNumber: "0x10" });
  await expect(ethGetTransactionReceipt(TX_HASH, OK)).rejects.toThrow(/without logs/);
});

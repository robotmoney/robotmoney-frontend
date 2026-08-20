// Block-addressable chain reads and the SHARED RPC rate budget — issue #709,
// docs/technical/data-self-healing.md §6.5.1 and §6.5.3.
//
// Fully offline: every assertion mocks `globalThis.fetch` and executes the real
// transport, matching tests/base-rpc-client.test.ts.
//
// RED CONTROL. Every test here fails against the pre-#709 tree for a structural
// reason, not a cosmetic one: `RpcCallOptions` had no `blockTag`, both call
// sites hardcoded the string "latest", `isEmptyReturnData` did not exist, and
// the transport had no rate control at all (only a concurrency gate, which is
// not a rate — that is the #651 finding this file pins).
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  ethCall,
  ethGetBalance,
  isEmptyReturnData,
  resolveRpcRateBudget,
  rpcRequest,
  toBlockTag,
  _resetRpcConcurrencyForTests,
  _resetRpcRateLimiterForTests,
} from "../src/chain/base-rpc-client.ts";

const realFetch = globalThis.fetch;
const RPC = "https://mainnet.base.org";
const KNOBS = [
  "BASE_RPC_MAX_CONCURRENCY",
  "BASE_RPC_MAX_RETRIES",
  "BASE_RPC_RETRY_BASE_MS",
  "BASE_RPC_MAX_CALLS_PER_SEC",
  "BASE_RPC_RATE_BURST",
] as const;

function okResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}

function captureParams(): { params: unknown[][]; restore(): void } {
  const params: unknown[][] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: unknown[] };
    params.push(body.params);
    return okResult("0x0000000000000000000000000000000000000000000000000000000000000001");
  }) as unknown as typeof fetch;
  return { params, restore: () => { globalThis.fetch = realFetch; } };
}

beforeEach(() => {
  process.env.BASE_RPC_RETRY_BASE_MS = "1";
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KNOBS) delete process.env[k];
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});

// ── The default is byte-for-byte unchanged ───────────────────────────────────

test("a caller that passes no blockTag still issues 'latest' — on BOTH call sites", async () => {
  const cap = captureParams();
  await ethCall("0xdead", "0xbeef", { rpcUrl: RPC });
  await ethGetBalance("0xdead", { rpcUrl: RPC });
  cap.restore();
  expect(cap.params[0]![1]).toBe("latest"); // eth_call's second param
  expect(cap.params[1]![1]).toBe("latest"); // eth_getBalance's second param
});

test("a blockTag is threaded verbatim to both call sites", async () => {
  const cap = captureParams();
  await ethCall("0xdead", "0xbeef", { rpcUrl: RPC, blockTag: "0x1e8480" });
  await ethGetBalance("0xdead", { rpcUrl: RPC, blockTag: "0x1e8480" });
  cap.restore();
  expect(cap.params[0]![1]).toBe("0x1e8480");
  expect(cap.params[1]![1]).toBe("0x1e8480");
});

test("toBlockTag encodes a block number as 0x-hex and refuses nonsense", () => {
  expect(toBlockTag(2_000_000)).toBe("0x1e8480");
  expect(toBlockTag(0)).toBe("0x0");
  expect(() => toBlockTag(-1)).toThrow();
  expect(() => toBlockTag(1.5)).toThrow();
});

// ── The silent-zero seam ─────────────────────────────────────────────────────

test("an empty return is distinguishable from a genuine zero", () => {
  const genuineZero = "0x" + "0".repeat(64);
  expect(isEmptyReturnData("0x")).toBe(true);
  expect(isEmptyReturnData("")).toBe(true);
  // THE WHOLE POINT: a real zero-balance word is 32 bytes of zeroes, and it must
  // NOT read as absent. Both decode to 0 — only this predicate tells them apart.
  expect(isEmptyReturnData(genuineZero)).toBe(false);
});

// ── The shared rate budget ───────────────────────────────────────────────────

test("unset budget = no pacing at all (the pre-#709 transport, unchanged)", async () => {
  expect(resolveRpcRateBudget({})).toBeNull();
  expect(resolveRpcRateBudget({ BASE_RPC_MAX_CALLS_PER_SEC: "" })).toBeNull();
  expect(resolveRpcRateBudget({ BASE_RPC_MAX_CALLS_PER_SEC: "nonsense" })).toBeNull();
  expect(resolveRpcRateBudget({ BASE_RPC_MAX_CALLS_PER_SEC: "0" })).toBeNull();

  globalThis.fetch = (async () => okResult("0x1")) as unknown as typeof fetch;
  const started = Date.now();
  for (let i = 0; i < 8; i++) await rpcRequest("eth_call", [], { rpcUrl: RPC });
  // No budget → no delay. Generous bound: this asserts the ABSENCE of pacing.
  expect(Date.now() - started).toBeLessThan(300);
});

test("the budget PACES: N calls past the burst take at least (N-burst)/rate", async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "20"; // 50ms apart
  process.env.BASE_RPC_RATE_BURST = "2";
  globalThis.fetch = (async () => okResult("0x1")) as unknown as typeof fetch;

  const stamps: number[] = [];
  const started = Date.now();
  for (let i = 0; i < 6; i++) {
    await rpcRequest("eth_call", [], { rpcUrl: RPC });
    stamps.push(Date.now());
  }
  const elapsed = Date.now() - started;
  // (6 - 2) / 20 = 200ms of enforced waiting, minus a timer-granularity margin.
  expect(elapsed).toBeGreaterThanOrEqual(180);
  // The burst really is a burst: the first two are not spaced.
  expect(stamps[1]! - stamps[0]!).toBeLessThan(40);
});

test("pacing is NOT concurrency: a serialized caller with concurrency 1 is unpaced without a budget", async () => {
  process.env.BASE_RPC_MAX_CONCURRENCY = "1";
  globalThis.fetch = (async () => okResult("0x1")) as unknown as typeof fetch;

  // This is the #651 finding, pinned: the existing gate bounds IN-FLIGHT, and on
  // a lane that claims LIMIT 1 serially in-flight never exceeds 1 anyway — so
  // the gate paces nothing and a backlog replay walks straight into a 429 storm.
  const unpacedStart = Date.now();
  for (let i = 0; i < 6; i++) await rpcRequest("eth_call", [], { rpcUrl: RPC });
  const unpaced = Date.now() - unpacedStart;

  _resetRpcRateLimiterForTests();
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "20";
  process.env.BASE_RPC_RATE_BURST = "1";
  const pacedStart = Date.now();
  for (let i = 0; i < 6; i++) await rpcRequest("eth_call", [], { rpcUrl: RPC });
  const paced = Date.now() - pacedStart;

  expect(unpaced).toBeLessThan(150);
  expect(paced).toBeGreaterThanOrEqual(200); // (6-1)/20 = 250ms, margin for timers
});

test("HTTP 429 drains the shared bucket, so the NEXT independent call waits", async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "5"; // 200ms per token
  process.env.BASE_RPC_RATE_BURST = "5";
  process.env.BASE_RPC_MAX_RETRIES = "0"; // isolate the bucket feedback from retry backoff

  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  await expect(rpcRequest("eth_call", [], { rpcUrl: RPC })).rejects.toThrow(/429/);

  // A full bucket would have served this instantly; a drained one cannot.
  globalThis.fetch = (async () => okResult("0x1")) as unknown as typeof fetch;
  const started = Date.now();
  await rpcRequest("eth_call", [], { rpcUrl: RPC });
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
});

test("JSON-RPC -32016 ('over rate limit') feeds back exactly like a 429", async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "5";
  process.env.BASE_RPC_RATE_BURST = "5";
  process.env.BASE_RPC_MAX_RETRIES = "0";

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32016, message: "over rate limit" } }), {
      status: 200,
    })) as unknown as typeof fetch;
  await expect(rpcRequest("eth_call", [], { rpcUrl: RPC })).rejects.toThrow(/-32016/);

  globalThis.fetch = (async () => okResult("0x1")) as unknown as typeof fetch;
  const started = Date.now();
  await rpcRequest("eth_call", [], { rpcUrl: RPC });
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
});

test("one bucket, not one per caller: concurrent callers share the same budget", async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "20";
  process.env.BASE_RPC_RATE_BURST = "1";
  process.env.BASE_RPC_MAX_CONCURRENCY = "8"; // plenty of slots — rate is the only bound
  globalThis.fetch = (async () => okResult("0x1")) as unknown as typeof fetch;

  // This is the constraint that makes a backfill safe to run beside the live
  // sampler: the provider meters per-IP, so two in-process callers must NOT get
  // a budget each.
  const started = Date.now();
  await Promise.all(Array.from({ length: 6 }, () => rpcRequest("eth_call", [], { rpcUrl: RPC })));
  expect(Date.now() - started).toBeGreaterThanOrEqual(200); // (6-1)/20
});

// Transport-level coverage for JSON-RPC ARRAY BATCHING
// (backend/src/chain/base-rpc-client.ts::rpcBatchRequest and its two typed
// helpers).
//
// WHAT THIS IS FOR. The provider meters REQUEST FREQUENCY, not payload size, so
// the cost of a backfill is the number of HTTP hits it makes. Multicall3 already
// collapses reads that share a block, but it executes at ONE block and cannot
// carry node methods, so it cannot merge either of the backfill's two real costs:
// N days at N block tags, and the `eth_getBlockByNumber` probes that locate them.
// Array batching is the only mechanism that merges those, and these tests pin the
// properties that make it safe to rely on.
//
// HONESTY (test-coverage policy). Batching must never turn a failure into a
// success. Three assertions below exist specifically to prove it does not:
// exhausted retries still report the throttled entries as FAILED, a batch-level
// refusal still THROWS, and a dropped entry is reported rather than silently
// omitted. An unread day must keep LOOKING unread.
//
// Fully offline — every assertion mocks `globalThis.fetch` and executes the real
// transport, matching tests/base-rpc-client.test.ts. No network, no skips.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  rpcBatchRequest,
  ethGetBlockByNumberBatch,
  ethCallBatch,
  _resetRpcConcurrencyForTests,
  _resetRpcRateLimiterForTests,
  type BatchCall,
} from "../src/chain/base-rpc-client.ts";

const realFetch = globalThis.fetch;
const RPC = "https://mainnet.base.org";
const OK = { rpcUrl: RPC, timeoutMs: 5000 };

const KNOBS = [
  "BASE_RPC_MAX_CONCURRENCY",
  "BASE_RPC_MAX_RETRIES",
  "BASE_RPC_RETRY_BASE_MS",
  "BASE_RPC_MAX_CALLS_PER_SEC",
  "BASE_RPC_RATE_BURST",
  "BASE_RPC_MAX_BATCH_SIZE",
] as const;

/** Every request body the mock saw, parsed. One entry per HTTP POST — which is
 *  the unit the provider meters, and therefore the unit these tests count. */
let posts: { id?: number; method: string; params: unknown[] }[][] = [];

/** Mock a server that answers each batch entry via `answer(entry, i)`. Returning
 *  `null` from `answer` omits that entry from the response entirely. */
function serve(answer: (entry: { id: number; method: string; params: unknown[] }, i: number) => unknown | null): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push(body);
    const out = (body as { id: number; method: string; params: unknown[] }[])
      .map((e, i) => answer(e, i))
      .filter((r) => r !== null);
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
}

const calls = (n: number, method = "eth_blockNumber"): BatchCall[] =>
  Array.from({ length: n }, (_, i) => ({ method, params: [i] }));

beforeEach(() => {
  posts = [];
  process.env.BASE_RPC_RETRY_BASE_MS = "1";
  // Pacing OFF by default here: a 429 deliberately DRAINS the shared bucket, so
  // the retry assertions would otherwise measure a multi-second refill instead
  // of the behaviour under test. The one test that IS about pacing turns it back
  // on explicitly.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KNOBS) delete process.env[k];
  _resetRpcConcurrencyForTests();
  _resetRpcRateLimiterForTests();
});

// ── The core claim ───────────────────────────────────────────────────────────

test("N calls cost exactly ONE HTTP POST — the whole point of batching", async () => {
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const out = await rpcBatchRequest<string>(calls(40), OK);

  expect(posts.length).toBe(1); // 40 calls, 1 metered hit
  expect(posts[0]!.length).toBe(40);
  expect(out.length).toBe(40);
  expect(out.every((r) => r.ok)).toBe(true);
  expect(out.map((r) => (r.ok ? r.result : null))).toEqual(calls(40).map((_, i) => `r${i}`));
});

test("an empty batch issues NO request at all", async () => {
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: "x" }));
  expect(await rpcBatchRequest([], OK)).toEqual([]);
  expect(posts.length).toBe(0);
});

test("results are matched by id, NOT by position — a server may answer a batch in any order", async () => {
  // JSON-RPC 2.0 explicitly permits reordering. Trusting position here would
  // attribute one day's balance to another day, under a right-looking date.
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number }[];
    posts.push(body as never);
    const out = body.map((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` })).reverse();
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;

  const out = await rpcBatchRequest<string>(calls(5), OK);
  expect(out.map((r) => (r.ok ? r.result : null))).toEqual(["r0", "r1", "r2", "r3", "r4"]);
});

test("batches are CHUNKED at BASE_RPC_MAX_BATCH_SIZE so an oversized batch is never sent whole", async () => {
  process.env.BASE_RPC_MAX_BATCH_SIZE = "50";
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const out = await rpcBatchRequest<string>(calls(120), OK);

  expect(posts.map((p) => p.length)).toEqual([50, 50, 20]);
  expect(out.length).toBe(120);
  expect(out.every((r) => r.ok)).toBe(true);
  // Chunk boundaries must not scramble the caller's ordering.
  expect(out.map((r) => (r.ok ? r.result : null))).toEqual(calls(120).map((_, i) => `r${i % 50}`));
});

// ── Partial failure is a VALUE, not a throw (the allowFailure contract) ───────

test("a hard per-entry error is RETURNED beside its siblings, never discarding the batch", async () => {
  serve((e) =>
    e.id === 2
      ? { jsonrpc: "2.0", id: e.id, error: { code: 3, message: "execution reverted" } }
      : { jsonrpc: "2.0", id: e.id, result: `r${e.id}` },
  );

  const out = await rpcBatchRequest<string>(calls(4), OK);

  expect(posts.length).toBe(1); // a revert is NOT retried
  expect(out[0]).toEqual({ ok: true, result: "r0" });
  expect(out[2]).toEqual({ ok: false, error: { code: 3, message: "execution reverted" } });
  expect(out[3]).toEqual({ ok: true, result: "r3" });
});

test("an entry the server never answered is REPORTED as failed, not silently dropped", async () => {
  serve((e) => (e.id === 1 ? null : { jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const out = await rpcBatchRequest<string>(calls(3), OK);

  expect(out.length).toBe(3); // positional alignment survives a dropped entry
  expect(out[1]!.ok).toBe(false);
  expect(out[1]!.ok === false && out[1]!.error.message).toContain("no response");
  expect(out[2]).toEqual({ ok: true, result: "r2" });
});

test("a 200 entry with neither result nor error is failed, not read as undefined", async () => {
  serve((e) => (e.id === 0 ? { jsonrpc: "2.0", id: e.id } : { jsonrpc: "2.0", id: e.id, result: "r" }));
  const out = await rpcBatchRequest<string>(calls(2), OK);
  expect(out[0]!.ok).toBe(false);
  expect(out[0]!.ok === false && out[0]!.error.message).toContain("missing result");
});

// ── Retry, at both levels ────────────────────────────────────────────────────

test("a whole-batch HTTP 429 retries the WHOLE chunk, then succeeds", async () => {
  let n = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push(body);
    if (n++ === 0) return new Response("rate limited", { status: 429 });
    return new Response(
      JSON.stringify((body as { id: number }[]).map((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }))),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const out = await rpcBatchRequest<string>(calls(3), OK);
  expect(posts.length).toBe(2);
  expect(posts[1]!.length).toBe(3); // the whole chunk, because the POST failed
  expect(out.every((r) => r.ok)).toBe(true);
});

test("per-entry -32016 retries ONLY the throttled entries — not the whole chunk", async () => {
  // Re-sending 40 calls to rescue 2 would spend exactly the budget this
  // function exists to save.
  let round = 0;
  serve((e) => {
    if (round === 0 && (e.id === 1 || e.id === 3)) {
      return { jsonrpc: "2.0", id: e.id, error: { code: -32016, message: "over rate limit" } };
    }
    return { jsonrpc: "2.0", id: e.id, result: `hit${e.id}` };
  });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (u: string, i: RequestInit) => {
    const res = await (inner as typeof fetch)(u as never, i as never);
    round++;
    return res;
  }) as unknown as typeof fetch;

  const out = await rpcBatchRequest<string>(calls(5), OK);

  expect(posts.length).toBe(2);
  expect(posts[0]!.length).toBe(5);
  expect(posts[1]!.length).toBe(2); // ONLY the two throttled entries
  expect(out.every((r) => r.ok)).toBe(true);
  // The retried pair lands back in ITS OWN input slots, not the retry's slots.
  expect(out[1]!.ok && out[1]!.result).toBe("hit0");
  expect(out[3]!.ok && out[3]!.result).toBe("hit1");
});

test("retries EXHAUSTED with entries still throttled: those report FAILED, the rest still succeed", async () => {
  // Honest degrade. The alternative — throwing away the whole batch, or
  // returning the throttled entries as anything other than failed — would make
  // an unrepaired day look repaired.
  process.env.BASE_RPC_MAX_RETRIES = "2";
  serve((e) =>
    e.params[0] === 2 || e.method === "stuck"
      ? { jsonrpc: "2.0", id: e.id, error: { code: -32016, message: "over rate limit" } }
      : { jsonrpc: "2.0", id: e.id, result: `r${e.id}` },
  );

  const out = await rpcBatchRequest<string>(calls(4), OK);

  expect(posts.length).toBe(3); // initial + 2 retries, then it stops
  expect(out[2]!.ok).toBe(false);
  expect(out[2]!.ok === false && out[2]!.error.code).toBe(-32016);
  expect(out[0]!.ok).toBe(true); // siblings unharmed
  expect(out[3]!.ok).toBe(true);
});

test("a batch-level refusal (a single envelope object, not an array) THROWS", async () => {
  // How endpoints answer an oversized or malformed batch. It is a failure of
  // the BATCH, so it must not be spread across the entries as N fake results.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } }), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(rpcBatchRequest(calls(3), OK)).rejects.toThrow(/batch too large/);
});

test("a non-transient HTTP status throws immediately with no retry", async () => {
  globalThis.fetch = (async (_u: string, i: RequestInit) => {
    posts.push(JSON.parse(String(i.body)));
    return new Response("bad", { status: 400 });
  }) as unknown as typeof fetch;

  await expect(rpcBatchRequest(calls(2), OK)).rejects.toThrow(/HTTP 400/);
  expect(posts.length).toBe(1);
});

// ── The pacing claim: one POST draws ONE token ───────────────────────────────

test("PACING: a batch of N draws ONE token where N single calls would draw N", async () => {
  // The saving is not incidental to the limiter, it IS the optimisation — so it
  // is worth pinning behaviourally rather than trusting the call-site reading.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "50";
  process.env.BASE_RPC_RATE_BURST = "1"; // no burst to absorb the fan-out
  _resetRpcRateLimiterForTests();
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const started = Date.now();
  await rpcBatchRequest<string>(calls(20), OK);
  const batched = Date.now() - started;

  // 20 calls through ONE POST spend one token: no refill wait beyond the first.
  // The same 20 as single POSTs would spend 20 tokens at 50/s ≈ 380ms of pure
  // waiting. Asserting the ceiling rather than an exact figure keeps this from
  // being a flaky clock test.
  expect(posts.length).toBe(1);
  expect(batched).toBeLessThan(200);
});

// ── The typed helpers ────────────────────────────────────────────────────────

test("ethGetBlockByNumberBatch: many headers in one POST, and a timestamp-less block is failed not fabricated", async () => {
  serve((e) => {
    const n = (e.params as string[])[0];
    if (n === "0x2") return { jsonrpc: "2.0", id: e.id, result: null }; // pruned/missing
    return { jsonrpc: "2.0", id: e.id, result: { number: n, timestamp: "0x64" } };
  });

  const out = await ethGetBlockByNumberBatch([1, 2, 3], OK);

  expect(posts.length).toBe(1);
  expect(posts[0]!.every((p) => p.method === "eth_getBlockByNumber")).toBe(true);
  expect(out[0]!.ok && out[0]!.result.number).toBe("0x1");
  expect(out[1]!.ok).toBe(false); // never invents a timestamp
  expect(out[1]!.ok === false && out[1]!.error.message).toContain("no block 2");
  expect(out[2]!.ok && out[2]!.result.number).toBe("0x3");
});

test("ethCallBatch: each call carries its OWN block tag — the thing aggregate3 cannot do", async () => {
  // This is the property that makes a multi-DAY read possible in one hit:
  // aggregate3 executes at a single block, so N days need N eth_calls, and only
  // array batching can put them in one POST.
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: "0x1" }));

  await ethCallBatch(
    [
      { to: "0xaa", data: "0xda", blockTag: "0x100" },
      { to: "0xbb", data: "0xdb", blockTag: "0x200" },
      { to: "0xcc", data: "0xdc" }, // omitted → "latest", matching ethCall
    ],
    OK,
  );

  expect(posts.length).toBe(1);
  const tags = posts[0]!.map((p) => (p.params as unknown[])[1]);
  expect(tags).toEqual(["0x100", "0x200", "latest"]);
  const targets = posts[0]!.map((p) => ((p.params as { to: string }[])[0] as { to: string }).to);
  expect(targets).toEqual(["0xaa", "0xbb", "0xcc"]);
});

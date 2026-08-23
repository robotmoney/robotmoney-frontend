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
  DEFAULT_MAX_BATCH_SIZE,
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
  "BASE_RPC_BUDGET_WAIT_MS",
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

test("a full chunk costs exactly ONE HTTP POST", async () => {
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const out = await rpcBatchRequest<string>(calls(10), OK);

  expect(posts.length).toBe(1); // 10 calls, 1 round trip
  expect(posts[0]!.length).toBe(10);
  expect(out.map((r) => (r.ok ? r.result : null))).toEqual(calls(10).map((_, i) => `r${i}`));
});

test("40 calls cost 4 POSTs, not 40 — the saving is bounded by the provider's cap of 10", async () => {
  // Stated as the real ratio rather than an aspirational one. The cap is 10, so
  // batching is a 10:1 saving on ROUND TRIPS and nothing more; anything claiming
  // more than that is measuring something else.
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const out = await rpcBatchRequest<string>(calls(40), OK);

  expect(posts.length).toBe(4);
  expect(out.length).toBe(40);
  expect(out.every((r) => r.ok)).toBe(true);
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

test("the REAL -32014 over-cap response — HTTP 200 with an object body — is a failure, not a success", async () => {
  // The exact wire shape mainnet.base.org returns for an 11-call batch,
  // captured 2026-08-22. The 200 status is the trap: an early draft of this
  // change checked only the HTTP code and recorded a wholesale rejection as a
  // working batch of 100, which made a benchmark report ~400x throughput that
  // was really the speed of being refused. Pinning the shape keeps that
  // particular self-deception from coming back.
  globalThis.fetch = (async (_u: string, i: RequestInit) => {
    posts.push(JSON.parse(String(i.body)));
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32014, message: "maximum 10 calls in 1 batch" }, id: null }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await expect(rpcBatchRequest(calls(11), OK)).rejects.toThrow(/maximum 10 calls in 1 batch/);
});

test("the DEFAULT chunk size is the provider's measured cap, so -32014 is unreachable", async () => {
  // 10, measured — not a round number someone liked. A default above the cap
  // would make every batch of a full window fail wholesale in production while
  // every hermetic test passed.
  expect(DEFAULT_MAX_BATCH_SIZE).toBe(10);
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));
  await rpcBatchRequest<string>(calls(25), OK);
  expect(posts.map((p) => p.length)).toEqual([10, 10, 5]);
  expect(Math.max(...posts.map((p) => p.length))).toBeLessThanOrEqual(DEFAULT_MAX_BATCH_SIZE);
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

test("PACING: our OWN limiter charges per POST, so a chunk of 10 costs one token", async () => {
  // This pins what OUR bucket does, and deliberately claims nothing about what
  // the PROVIDER's bucket does — measurement on 2026-08-22 says the provider
  // meters closer to per sub-call, so the real-world saving here is round trips
  // and retry cycles, not throughput. See DEFAULT_MAX_BATCH_SIZE and
  // docs/technical/data-self-healing.md §6.5.3.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "50";
  process.env.BASE_RPC_RATE_BURST = "1"; // no burst to absorb the fan-out
  _resetRpcRateLimiterForTests();
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const started = Date.now();
  await rpcBatchRequest<string>(calls(10), OK);
  const batched = Date.now() - started;

  // 10 calls through ONE POST spend one local token: no refill wait beyond the
  // first. The same 10 as single POSTs would spend 10 tokens at 50/s ≈ 180ms of
  // pure waiting. Asserting a ceiling rather than an exact figure keeps this
  // from being a flaky clock test.
  expect(posts.length).toBe(1);
  expect(batched).toBeLessThan(150);
});

// ── Pacing must not be mistaken for a hung request ───────────────────────────
//
// The regression: the AbortController was armed BEFORE the rate token was
// acquired, and in rpcBatchRequest a single deadline spanned every chunk. At the
// shipped default of 0.25 calls/s a drained bucket costs 4000ms per token, so
// half of the 8000ms default was spent queueing before a byte moved — and any
// batch needing two chunks aborted by construction. It surfaced in the field as
// `Base RPC aborted (timeout) during retry backoff` on a run that was only ever
// being paced. The deadline now bounds each POST, not the queueing in front of
// it.

test("PACING: a multi-chunk batch survives a drained bucket instead of aborting on its own deadline", async () => {
  // Two chunks at a rate whose refill (500ms/token) exceeds the per-POST
  // deadline below. Under the old single-deadline-per-invocation shape the
  // second chunk could not be reached before the deadline fired.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "2";
  process.env.BASE_RPC_RATE_BURST = "1";
  process.env.BASE_RPC_MAX_BATCH_SIZE = "5";
  _resetRpcRateLimiterForTests();
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  const out = await rpcBatchRequest<string>(calls(10), { ...OK, timeoutMs: 300 });

  expect(posts.length).toBe(2);
  expect(out.length).toBe(10);
  expect(out.every((r) => r.ok)).toBe(true);
});

test("PACING: the per-POST deadline still bounds a genuinely hung POST", async () => {
  // The other half of the contract — moving the token wait out must not make
  // `timeoutMs` toothless where it actually applies.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  _resetRpcRateLimiterForTests();
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const started = Date.now();
  await expect(rpcBatchRequest<string>(calls(1), { ...OK, timeoutMs: 100 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("PACING: a token wait is BOUNDED — a queued bucket errors saying so, not silently hanging", async () => {
  // Moving the token wait out of the request deadline must not leave it
  // unbounded: the request path shares this bucket with the backfill by design,
  // so an unbounded wait turns a slow dashboard into a hung one. The error must
  // name pacing rather than a timeout — misreading one for the other is what
  // sent an earlier investigation after a phantom transport bug.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0.01"; // 100s per token
  process.env.BASE_RPC_RATE_BURST = "1";
  process.env.BASE_RPC_BUDGET_WAIT_MS = "150";
  _resetRpcRateLimiterForTests();
  serve((e) => ({ jsonrpc: "2.0", id: e.id, result: `r${e.id}` }));

  await rpcBatchRequest<string>(calls(1), OK); // spends the one burst token
  const started = Date.now();
  await expect(rpcBatchRequest<string>(calls(1), OK)).rejects.toThrow(/still waiting for rate budget/);
  expect(Date.now() - started).toBeLessThan(3000);
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

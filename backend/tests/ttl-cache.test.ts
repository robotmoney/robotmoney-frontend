// Unit tests for the shared TTL-cache primitives (backend/src/chain/ttl-cache.ts,
// issue #455) extracted from the CACHE_TTL_MS/let cache/_resetForTests pattern
// hand-copied across wallet-balances.ts, wallet-sleeves.ts, buyback-logs.ts,
// token-metrics.ts, allocation-framework.ts, vault-economics.ts, and
// token-prices.ts. Exercises the primitive directly (not through any one
// chain/ module) so the helper's own contract — TTL expiry, the
// _resetForTests/invalidate convention, and cache-hit/cache-miss behavior — is
// covered independently of any single call site.
import { expect, test } from "bun:test";
import { TtlCache, ttlCached } from "../src/chain/ttl-cache.ts";

test("TtlCache: miss on an empty cache, hit within the TTL window, miss again after expiry", () => {
  const cache = new TtlCache<string, number>(30_000);
  const t0 = 1_000_000;

  expect(cache.get("a", t0)).toBeUndefined();

  cache.set("a", 42, t0);
  expect(cache.get("a", t0)).toBe(42);
  expect(cache.get("a", t0 + 29_999)).toBe(42);

  expect(cache.get("a", t0 + 30_000)).toBeUndefined();
});

test("TtlCache: each key has its own independent entry and TTL window", () => {
  const cache = new TtlCache<string, number>(1_000);
  const t0 = 0;

  cache.set("a", 1, t0);
  cache.set("b", 2, t0 + 500);

  // At t0+1400: "a" (age 1400ms) has aged past its 1000ms window, but "b" (set
  // 500ms later, age 900ms at this same check time) has not.
  expect(cache.get("a", t0 + 1_400)).toBeUndefined();
  expect(cache.get("b", t0 + 1_400)).toBe(2);
});

test("TtlCache: reset() clears every entry regardless of key", () => {
  const cache = new TtlCache<string, number>(30_000);
  cache.set("a", 1);
  cache.set("b", 2);

  cache.reset();

  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBeUndefined();
});

test("TtlCache: a function TTL is re-resolved on every read/write (DEMO_MODE-style dynamic window)", () => {
  let ttl = 100;
  const cache = new TtlCache<string, number>(() => ttl);
  const t0 = 0;

  cache.set("a", 1, t0);
  expect(cache.get("a", t0 + 50)).toBe(1); // within the 100ms window

  ttl = 10; // window shrinks (e.g. DEMO_MODE flips off) — re-read at call time
  expect(cache.get("a", t0 + 50)).toBeUndefined(); // now stale under the new window
});

test("ttlCached: caches a producer's resolved value across calls within the TTL", async () => {
  let calls = 0;
  const producer = async () => {
    calls++;
    return { n: calls };
  };
  const cached = ttlCached(producer, 30_000);

  const first = await cached();
  const second = await cached();

  expect(first).toEqual({ n: 1 });
  expect(second).toEqual({ n: 1 }); // cache hit: producer not re-invoked
  expect(calls).toBe(1);
});

test("ttlCached: re-invokes the producer once the TTL expires", async () => {
  let calls = 0;
  const producer = async () => {
    calls++;
    return calls;
  };
  const cached = ttlCached(producer, 10);

  expect(await cached()).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await cached()).toBe(2);
  expect(calls).toBe(2);
});

test("ttlCached: invalidate() forces the next call to recompute (production cache-busting, e.g. after a write)", async () => {
  let calls = 0;
  const producer = async () => {
    calls++;
    return calls;
  };
  const cached = ttlCached(producer, 30_000);

  expect(await cached()).toBe(1);
  cached.invalidate();
  expect(await cached()).toBe(2);
  expect(calls).toBe(2);
});

test("ttlCached: _resetForTests() is the same reset behavior exposed under the test-hygiene name every chain/ module already used", async () => {
  let calls = 0;
  const producer = async () => {
    calls++;
    return calls;
  };
  const cached = ttlCached(producer, 30_000);

  expect(await cached()).toBe(1);
  cached._resetForTests();
  expect(await cached()).toBe(2);
});

test("ttlCached: a throwing producer never poisons the cache — the next call retries", async () => {
  let calls = 0;
  const producer = async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return calls;
  };
  const cached = ttlCached(producer, 30_000);

  await expect(cached()).rejects.toThrow("boom");
  expect(await cached()).toBe(2);
});

test("ttlCached: extra arguments are forwarded to the producer but do not affect the cache slot (matches every pre-existing single-value call site)", async () => {
  const seen: string[] = [];
  const producer = async (label: string) => {
    seen.push(label);
    return label;
  };
  const cached = ttlCached(producer, 30_000);

  expect(await cached("first")).toBe("first");
  // Cache hit: the producer is NOT invoked with "second", and the stale
  // cached value from the "first" call is returned — single-slot, not keyed
  // by argument, exactly like wallet-sleeves.ts's ignored `_readers` override.
  expect(await cached("second")).toBe("first");
  expect(seen).toEqual(["first"]);
});

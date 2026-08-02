// Resilience coverage for the GeckoTerminal new_pools sweep (#135, evidence from
// #101): on the LIVE path api.geckoterminal.com 429s the keyless firehose, and an
// unbounded throttled leg stretches analytics.run past swarm deadlines. These
// tests prove (all with mocked HTTP — no live network, no real waits):
//   1. sustained 429s abort within the bounded budget/attempts, the leg throws
//      (never fabricates a count), fetchAll records the degraded outcome loudly,
//      and the orchestrator's mergeSeries keeps the last-persisted floor;
//   2. Retry-After is honored verbatim up to the sweep budget (and refused —
//      give up, don't sleep — when it would overrun the budget);
//   3. a transient 429 blip self-heals (retry then success).
import { test, expect } from "bun:test";
import {
  fetchGeckoTerminalNewPools,
  throttleWaitMs,
} from "../src/analytics/extract/geckoterminal.ts";
import { fetchAll } from "../src/analytics/extract/sources.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { mergeSeries } from "../src/analytics/transform/math.ts";

const NOW = Date.parse("2026-07-15T12:00:00Z");

function throttled(retryAfter?: string) {
  return {
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    headers: new Headers(retryAfter !== undefined ? { "retry-after": retryAfter } : {}),
    json: async () => ({}),
  } as unknown as Response;
}

// One in-window entry + one stale entry → countNewPools24h stops after page 1
// (window fully covered), so the sweep never proceeds to page 2.
function okLastPage() {
  const entries = [
    { attributes: { pool_created_at: new Date(NOW - 3600_000).toISOString() } },
    { attributes: { pool_created_at: new Date(NOW - 30 * 3600_000).toISOString() } },
  ];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ data: entries }),
  } as unknown as Response;
}

const silent = { warn: () => {} };
const recordSleep = (into: number[]) => async (ms: number) => {
  into.push(ms);
};

test("sustained 429s: the leg aborts within its bounded budget and throws (never a fabricated count)", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return throttled("0"); // server keeps saying "retry immediately" — attempts must still be bounded
  }) as any;
  const sleeps: number[] = [];
  const t0 = Date.now();
  try {
    await expect(
      fetchGeckoTerminalNewPools(NOW, 1000, { budgetMs: 30_000, logger: silent, sleep: recordSleep(sleeps) }),
    ).rejects.toThrow(/throttled|budget/i);
    expect(calls).toBeLessThanOrEqual(5); // MAX_ATTEMPTS_PER_PAGE bounds page 1 — not an unbounded hammer loop
    expect(Date.now() - t0).toBeLessThan(5_000); // wall time nowhere near the 30s budget (no real backoff waits)
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("sustained 429s: fetchAll records a degraded NEW_TOKENS outcome loudly and the persisted floor survives the merge", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => throttled("0")) as any;
  const errors: string[] = [];
  const logs: string[] = [];
  try {
    const inds = INDICATORS.filter((i) => i.source === "geckoterminal_newpools");
    expect(inds.length).toBe(1); // NEW_TOKENS
    const out = await fetchAll({
      indicators: inds,
      logger: { error: (m) => errors.push(m), warn: () => {}, log: (m) => logs.push(m) },
    });
    // Degraded outcome is RECORDED, not silently skipped: the leg is [] (never a
    // fabricated 0-count point), the failure is error-logged, and the fetch
    // summary marks the leg EMPTY.
    expect(out[inds[0]!.id]).toEqual([]);
    expect(errors.some((m) => m.includes("NEW_TOKENS") && m.includes("FAILED"))).toBe(true);
    expect(logs.some((m) => m.includes("EMPTY") && m.includes("NEW_TOKENS"))).toBe(true);
    // Degrades to last-persisted: the orchestrator (analytics/index.ts) merges
    // fetched over the persisted floor — an empty fetch keeps the floor intact.
    const floor = [
      { date: "2026-07-13", value: 812 },
      { date: "2026-07-14", value: 774 },
    ];
    expect(mergeSeries(floor, out[inds[0]!.id]!)).toEqual(floor);
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("Retry-After is honored verbatim: a throttled page waits exactly the advertised delay, then recovers", async () => {
  const orig = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => (call++ === 0 ? throttled("2") : okLastPage())) as any;
  const sleeps: number[] = [];
  try {
    const pts = await fetchGeckoTerminalNewPools(NOW, 1000, {
      budgetMs: 30_000,
      logger: silent,
      sleep: recordSleep(sleeps),
    });
    expect(sleeps).toEqual([2000]); // Retry-After: 2 → exactly 2000ms, not the exponential fallback
    expect(pts).toEqual([{ date: "2026-07-15", value: 1 }]); // transient blip self-healed
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("Retry-After beyond the remaining budget: give up immediately (no sleep past the deadline)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => throttled("60")) as any; // 60s advertised, 500ms budget
  const sleeps: number[] = [];
  const t0 = Date.now();
  try {
    await expect(
      fetchGeckoTerminalNewPools(NOW, 1000, { budgetMs: 500, logger: silent, sleep: recordSleep(sleeps) }),
    ).rejects.toThrow(/throttled|budget/i);
    expect(sleeps).toEqual([]); // never slept — the wait would overrun the budget
    expect(Date.now() - t0).toBeLessThan(5_000);
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("throttleWaitMs: honors Retry-After up to the budget, clamps hostile values, falls back to exponential backoff", () => {
  // Delta-seconds honored verbatim while it fits the remaining budget.
  expect(throttleWaitMs(1, "3", 10_000)).toBe(3000);
  // HTTP-date form honored (second-aligned so toUTCString round-trips exactly).
  const now = Math.floor(Date.now() / 1000) * 1000;
  expect(throttleWaitMs(1, new Date(now + 2000).toUTCString(), 10_000, now)).toBe(2000);
  // A wait that would overrun the remaining budget is refused → caller gives up.
  expect(throttleWaitMs(1, "30", 5_000)).toBe(null);
  // A hostile/huge Retry-After is clamped to the single-wait ceiling (15s).
  expect(throttleWaitMs(1, "60", 100_000)).toBe(15_000);
  // No Retry-After → exponential backoff (1s base, doubling per attempt).
  expect(throttleWaitMs(1, null, 10_000)).toBe(1000);
  expect(throttleWaitMs(2, null, 10_000)).toBe(2000);
  expect(throttleWaitMs(3, null, 10_000)).toBe(4000);
});

test("non-transient status: throws immediately with no retries (no backoff time wasted)", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Response;
  }) as any;
  const sleeps: number[] = [];
  try {
    await expect(
      fetchGeckoTerminalNewPools(NOW, 1000, { budgetMs: 30_000, logger: silent, sleep: recordSleep(sleeps) }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

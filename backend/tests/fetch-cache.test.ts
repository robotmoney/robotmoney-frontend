// Hermetic (no network, no DB) coverage for the fetch cache (issue #13).
// Proves: disabled outside demo mode (no memoization), memoizes within the TTL,
// re-fetches after the TTL expires, and the TTL default is MODE-selected (the
// old FETCH_CACHE_TTL_MS env knob was removed: DEMO_MODE → 1h for per-IP
// provider-quota protection on the shared demo/CI host, everything else → off).
// The "fetcher" is a local counter — the network is never touched — and a temp
// dir + injected clock make the disk/TTL logic deterministic. Runs in per-PR CI
// (offline).
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheTtlMs,
  DEMO_FETCH_CACHE_TTL_MS,
  PROD_FETCH_CACHE_TTL_MS,
  withFetchCache,
} from "../src/analytics/extract/fetch-cache.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rm-fetch-cache-"));
}

test("TTL default is mode-selected: off without DEMO_MODE, 1h with it (no env tuning knob)", () => {
  const saved = process.env.DEMO_MODE;
  try {
    delete process.env.DEMO_MODE;
    expect(cacheTtlMs()).toBe(PROD_FETCH_CACHE_TTL_MS);
    expect(PROD_FETCH_CACHE_TTL_MS).toBe(0); // prod/CI/hermetic: no disk, no staleness
    process.env.DEMO_MODE = "1";
    expect(cacheTtlMs()).toBe(DEMO_FETCH_CACHE_TTL_MS);
    expect(DEMO_FETCH_CACHE_TTL_MS).toBe(3_600_000); // hourly-fresh demo tradeoff
    // An explicit per-call ttlMs (tests, tooling) still beats the mode default.
    expect(cacheTtlMs({ ttlMs: 5 })).toBe(5);
    expect(cacheTtlMs({ ttlMs: 0 })).toBe(0);
  } finally {
    if (saved === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = saved;
  }
});

test("disabled by default (ttl<=0): every call re-runs the fetcher", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const fetcher = async () => ({ n: ++calls });
    const a = await withFetchCache("json", "http://x/a", fetcher, { dir, ttlMs: 0 });
    const b = await withFetchCache("json", "http://x/a", fetcher, { dir, ttlMs: 0 });
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 2 });
    expect(calls).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("within TTL: a second call is served from the cache (fetcher not re-run)", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    let clock = 1_000_000;
    const now = () => clock;
    const fetcher = async () => `body-${++calls}`;
    const a = await withFetchCache("text", "http://x/csv", fetcher, { dir, ttlMs: 60_000, now });
    clock += 30_000; // still within the 60s TTL
    const b = await withFetchCache("text", "http://x/csv", fetcher, { dir, ttlMs: 60_000, now });
    expect(a).toBe("body-1");
    expect(b).toBe("body-1"); // cached — same body
    expect(calls).toBe(1); // fetcher ran exactly once
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after TTL expiry: the fetcher re-runs and the cache refreshes", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    let clock = 5_000_000;
    const now = () => clock;
    const fetcher = async () => `v${++calls}`;
    const a = await withFetchCache("text", "http://x/y", fetcher, { dir, ttlMs: 10_000, now });
    clock += 20_000; // past the 10s TTL
    const b = await withFetchCache("text", "http://x/y", fetcher, { dir, ttlMs: 10_000, now });
    expect(a).toBe("v1");
    expect(b).toBe("v2"); // stale → re-fetched
    expect(calls).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinct (kind,url) keys do not collide", async () => {
  const dir = tmp();
  try {
    const now = () => 1;
    const j = await withFetchCache("json", "http://x/same", async () => ({ k: "json" }), { dir, ttlMs: 60_000, now });
    const t = await withFetchCache("text", "http://x/same", async () => "text-body", { dir, ttlMs: 60_000, now });
    expect(j).toEqual({ k: "json" });
    expect(t).toBe("text-body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

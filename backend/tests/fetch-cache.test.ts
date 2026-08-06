// Hermetic (no network, no DB) coverage for the fetch cache (issue #13).
// Proves: disabled by default, capability configuration, memoization, and expiry.
// The "fetcher" is a local counter — the network is never touched — and a temp
// dir + injected clock make the disk/TTL logic deterministic. Runs in per-PR CI
// (offline).
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheTtlMs,
  HTTP_FETCH_CACHE_TTL_ENV,
  PROD_FETCH_CACHE_TTL_MS,
  resolveHttpFetchCacheTtlMs,
  withFetchCache,
} from "../src/analytics/extract/fetch-cache.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rm-fetch-cache-"));
}

test("TTL defaults off and only explicit capability/per-call values enable caching", () => {
  expect(cacheTtlMs()).toBe(PROD_FETCH_CACHE_TTL_MS);
  expect(PROD_FETCH_CACHE_TTL_MS).toBe(0);
  expect(cacheTtlMs({ ttlMs: 5 })).toBe(5);
  expect(cacheTtlMs({ ttlMs: 0 })).toBe(0);
  expect(resolveHttpFetchCacheTtlMs({ [HTTP_FETCH_CACHE_TTL_ENV]: "3600000" })).toBe(3_600_000);
  for (const invalid of ["-1", "1.5", "nope", "9007199254740992"]) {
    expect(() => resolveHttpFetchCacheTtlMs({ [HTTP_FETCH_CACHE_TTL_ENV]: invalid })).toThrow(/non-negative integer/);
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

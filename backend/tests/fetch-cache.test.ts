// Hermetic (no network, no DB) coverage for the fetch cache (issue #13).
// Proves: disabled by default, capability configuration, memoization, expiry,
// and (issue 1258) that the cache stays bounded: an expired entry is deleted on
// read, every write sweeps entries older than the TTL, a size cap evicts the
// oldest entries first, and a sweep that cannot delete never fails the fetch.
// The "fetcher" is a local counter — the network is never touched — and a temp
// dir + injected clock make the disk/TTL logic deterministic. Runs in per-PR CI
// (offline).
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheTtlMs,
  DEFAULT_FETCH_CACHE_MAX_BYTES,
  HTTP_FETCH_CACHE_MAX_BYTES_ENV,
  HTTP_FETCH_CACHE_TTL_ENV,
  PROD_FETCH_CACHE_TTL_MS,
  resolveHttpFetchCacheMaxBytes,
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

// ── bounded cache (issue 1258) ──────────────────────────────────────────────────

/** The on-disk path of one entry, by the same rule as fetch-cache.ts. */
function entryPath(dir: string, kind: string, key: string): string {
  return join(dir, `${createHash("sha256").update(`${kind}:${key}`).digest("hex")}.json`);
}

function entries(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".json"));
}

function dirBytes(dir: string): number {
  return entries(dir).reduce((n, name) => n + statSync(join(dir, name)).size, 0);
}

test("the size cap resolves from HTTP_FETCH_CACHE_MAX_BYTES with a fixed default", () => {
  expect(resolveHttpFetchCacheMaxBytes({})).toBe(DEFAULT_FETCH_CACHE_MAX_BYTES);
  expect(DEFAULT_FETCH_CACHE_MAX_BYTES).toBeGreaterThan(0);
  expect(resolveHttpFetchCacheMaxBytes({ [HTTP_FETCH_CACHE_MAX_BYTES_ENV]: "1024" })).toBe(1024);
  for (const invalid of ["-1", "1.5", "nope"]) {
    expect(() => resolveHttpFetchCacheMaxBytes({ [HTTP_FETCH_CACHE_MAX_BYTES_ENV]: invalid })).toThrow(/non-negative integer/);
  }
});

test("an entry read after its TTL is deleted from disk", async () => {
  const dir = tmp();
  try {
    let clock = 10_000_000;
    const now = () => clock;
    await withFetchCache("text", "http://x/old", async () => "v1", { dir, ttlMs: 10_000, now });
    const path = entryPath(dir, "text", "http://x/old");
    expect(existsSync(path)).toBe(true);
    clock += 20_000; // past the TTL
    // The read finds it expired and deletes it before the live fetch; the fetcher
    // throws, so no fresh write can put a file back at that path.
    await expect(withFetchCache("text", "http://x/old", async () => { throw new Error("offline"); }, { dir, ttlMs: 10_000, now })).rejects.toThrow("offline");
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after writes, the directory holds no entry older than the TTL", async () => {
  const dir = tmp();
  try {
    let clock = 20_000_000;
    const now = () => clock;
    const ttlMs = 10_000;
    for (let i = 0; i < 6; i++) {
      await withFetchCache("text", `http://x/varying?i=${i}`, async () => `body-${i}`, { dir, ttlMs, now });
      clock += 4_000; // each earlier entry ages past the TTL two or three writes later
    }
    const left = entries(dir);
    expect(left.length).toBeGreaterThan(0);
    for (const name of left) {
      const age = clock - 4_000 - statSync(join(dir, name)).mtimeMs; // the last write's clock
      expect(age).toBeLessThan(ttlMs);
    }
    // only the entries written within the TTL of the last write survive
    expect(left.length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writing past the size cap evicts the oldest entries first and keeps the total under the cap", async () => {
  const dir = tmp();
  try {
    let clock = 30_000_000;
    const now = () => clock;
    const body = "x".repeat(1000); // about 1 KB per entry
    const maxBytes = 3500; // room for three entries
    const o = { dir, ttlMs: 3_600_000, now, maxBytes };
    for (let i = 0; i < 6; i++) {
      await withFetchCache("text", `http://x/big?i=${i}`, async () => body, o);
      clock += 1_000;
      expect(dirBytes(dir)).toBeLessThanOrEqual(maxBytes);
    }
    // oldest first: entries 0..2 are gone, 3..5 remain
    for (let i = 0; i < 3; i++) expect(existsSync(entryPath(dir, "text", `http://x/big?i=${i}`))).toBe(false);
    for (let i = 3; i < 6; i++) expect(existsSync(entryPath(dir, "text", `http://x/big?i=${i}`))).toBe(true);
    // a fresh entry under the cap is still a hit
    const statuses: string[] = [];
    let calls = 0;
    const hit = await withFetchCache("text", "http://x/big?i=5", async () => { calls++; return "refetched"; }, { ...o, onStatus: (s) => statuses.push(s) });
    expect(hit).toBe(body);
    expect(calls).toBe(0);
    expect(statuses).toEqual(["hit"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sweep that cannot delete a file (read-only dir) still returns the fetched body", async () => {
  const dir = tmp();
  try {
    const stale = join(dir, `${"a".repeat(64)}.json`);
    writeFileSync(stale, JSON.stringify({ ts: 1, body: "stale" }));
    chmodSync(dir, 0o555); // nothing in it can be written or deleted (for a non-root user)
    let calls = 0;
    const body = await withFetchCache("text", "http://x/ro", async () => `fresh-${++calls}`, { dir, ttlMs: 10_000, now: () => 50_000_000, maxBytes: 1 });
    expect(body).toBe("fresh-1");
    expect(calls).toBe(1);
    // As a non-root user the delete really failed, so the expired file is still there.
    // Root ignores the mode bits, so there the sweep simply succeeds.
    if (process.getuid?.() !== 0) expect(existsSync(stale)).toBe(true);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Extract stage: on-disk TTL cache for the heavy source fetches (issue #13).
// A full live cold boot pulls from ~8 sources — SEC EDGAR alone is ~200 requests,
// plus the large FRED/Shiller CSVs — so repeated smoke boots re-pay that cost every
// time. When the TTL > 0 this memoizes each GET response body to a cache dir keyed
// by (kind,url); a subsequent boot within the TTL reads from disk instead of the
// network, so a warm smoke restarts fast and is polite to upstreams.
//
// HTTP_FETCH_CACHE_TTL_MS is capability-specific: production defaults to OFF,
// while shared smoke/smoke orchestration supplies one hour. Per-call ttlMs still
// wins for tests and specialized callers. now() and the dir are injectable so
// the TTL/expiry logic is unit-tested hermetically (no network).
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FetchCacheOptions {
  ttlMs?: number; // <=0 disables caching (default: off)
  dir?: string; // cache directory (default from FETCH_CACHE_DIR, else <tmp>/robotmoney-fetch-cache)
  now?: () => number; // injectable clock for tests
}

interface CacheEnvelope<T> {
  ts: number; // epoch ms when written
  body: T;
}

/** Prod/CI/hermetic: cache OFF — behavior identical to an uncached fetch. */
export const PROD_FETCH_CACHE_TTL_MS = 0;
export const HTTP_FETCH_CACHE_TTL_ENV = "HTTP_FETCH_CACHE_TTL_MS";

export function resolveHttpFetchCacheTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[HTTP_FETCH_CACHE_TTL_ENV];
  if (raw === undefined || raw === "") return PROD_FETCH_CACHE_TTL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${HTTP_FETCH_CACHE_TTL_ENV} must be a non-negative integer number of milliseconds`);
  }
  return value;
}

export function cacheTtlMs(opts: FetchCacheOptions = {}): number {
  if (typeof opts.ttlMs === "number") return opts.ttlMs;
  return resolveHttpFetchCacheTtlMs();
}

function cacheDir(opts: FetchCacheOptions): string {
  return opts.dir || process.env.FETCH_CACHE_DIR || join(tmpdir(), "robotmoney-fetch-cache");
}

function cacheFile(dir: string, kind: string, key: string): string {
  const h = createHash("sha256").update(`${kind}:${key}`).digest("hex");
  return join(dir, `${h}.json`);
}

// Memoize `fetcher()` under (kind,key) with a TTL. When caching is disabled (ttl<=0)
// or on any cache-read error, `fetcher()` is called and (best-effort) its result is
// cached for next time. A cache-write failure never fails the fetch.
export async function withFetchCache<T>(
  kind: "json" | "text",
  key: string,
  fetcher: () => Promise<T>,
  opts: FetchCacheOptions = {},
): Promise<T> {
  const ttl = cacheTtlMs(opts);
  if (ttl <= 0) return fetcher();

  const now = opts.now ?? Date.now;
  const dir = cacheDir(opts);
  const path = cacheFile(dir, kind, key);

  try {
    const raw = await readFile(path, "utf8");
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    if (typeof env.ts === "number" && now() - env.ts < ttl) {
      return env.body;
    }
  } catch {
    // miss / expired / unreadable → fall through to a live fetch
  }

  const body = await fetcher();
  try {
    mkdirSync(dir, { recursive: true });
    const env: CacheEnvelope<T> = { ts: now(), body };
    await writeFile(path, JSON.stringify(env));
  } catch {
    // best effort — a cache-write failure must never fail the fetch
  }
  return body;
}

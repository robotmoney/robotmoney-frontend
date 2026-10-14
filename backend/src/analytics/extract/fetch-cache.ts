// Extract stage: on-disk TTL cache for the heavy source fetches (issue #13).
// A full live cold boot pulls from ~8 sources — SEC EDGAR alone is ~200 requests,
// plus the large FRED/Shiller CSVs — so repeated smoke boots re-pay that cost every
// time. When the TTL > 0 this memoizes each GET response body to a cache dir keyed
// by (kind,url); a subsequent boot within the TTL reads from disk instead of the
// network, so a warm smoke restarts fast and is polite to upstreams.
//
// HTTP_FETCH_CACHE_TTL_MS is capability-specific: production defaults to OFF,
// and only a local non-standing, non-prod smoke boot supplies one hour
// (scripts/lib/smoke-env.ts). Per-call ttlMs still wins for tests and
// specialized callers. now(), the dir and the size cap are injectable so the
// TTL/expiry/eviction logic is unit-tested hermetically (no network).
//
// BOUNDED (issue 1258). Most keyed URLs vary, so a cache that only checked age
// on read grew without bound: prod held 20 GB in one container's writable layer
// and filled the host disk. Now an expired entry is deleted when a read finds
// it, and every write is followed by a sweep that deletes every entry older
// than the TTL and then the oldest entries until the directory total is at or
// under HTTP_FETCH_CACHE_MAX_BYTES. Each entry's mtime is set to its envelope
// timestamp, so the sweep ages entries by stat alone (no file is read) and
// honours the injected clock. The sweep is best effort: a sweep failure never
// fails the fetch.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FetchCacheOptions {
  ttlMs?: number; // <=0 disables caching (default: off)
  dir?: string; // cache directory (default from FETCH_CACHE_DIR, else <tmp>/robotmoney-fetch-cache)
  now?: () => number; // injectable clock for tests
  maxBytes?: number; // directory size cap (default from HTTP_FETCH_CACHE_MAX_BYTES, else DEFAULT_FETCH_CACHE_MAX_BYTES)
  onStatus?: (status: "disabled" | "hit" | "miss") => void;
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

export const HTTP_FETCH_CACHE_MAX_BYTES_ENV = "HTTP_FETCH_CACHE_MAX_BYTES";
/** The directory size cap when HTTP_FETCH_CACHE_MAX_BYTES is unset: 256 MB. */
export const DEFAULT_FETCH_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export function resolveHttpFetchCacheMaxBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[HTTP_FETCH_CACHE_MAX_BYTES_ENV];
  if (raw === undefined || raw === "") return DEFAULT_FETCH_CACHE_MAX_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${HTTP_FETCH_CACHE_MAX_BYTES_ENV} must be a non-negative integer number of bytes`);
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

/**
 * Best effort. Delete every cache entry older than the TTL, then the oldest
 * entries until the directory total is at or under maxBytes. Only `*.json`
 * files are considered. An entry that cannot be read or deleted is skipped;
 * nothing here ever throws.
 */
export async function sweepFetchCache(dir: string, ttlMs: number, maxBytes: number, now: () => number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const kept: Array<{ path: string; at: number; size: number }> = [];
  const t = now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const entry = { path, at: st.mtimeMs, size: st.size };
      if (t - st.mtimeMs >= ttlMs) {
        await unlink(path).catch(() => kept.push(entry));
        continue;
      }
      kept.push(entry);
    } catch {
      // vanished or unreadable: skip
    }
  }
  let total = kept.reduce((n, e) => n + e.size, 0);
  kept.sort((a, b) => a.at - b.at);
  for (const e of kept) {
    if (total <= maxBytes) break;
    try {
      await unlink(e.path);
      total -= e.size;
    } catch {
      // cannot delete: go on with the next oldest
    }
  }
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
  if (ttl <= 0) {
    opts.onStatus?.("disabled");
    return fetcher();
  }

  const now = opts.now ?? Date.now;
  const dir = cacheDir(opts);
  const path = cacheFile(dir, kind, key);

  try {
    const raw = await readFile(path, "utf8");
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    if (typeof env.ts === "number" && now() - env.ts < ttl) {
      opts.onStatus?.("hit");
      return env.body;
    }
    // expired or malformed: delete it now (best effort), so it never lingers
    await unlink(path).catch(() => {});
  } catch {
    // miss / unreadable → fall through to a live fetch
  }

  opts.onStatus?.("miss");
  const body = await fetcher();
  try {
    mkdirSync(dir, { recursive: true });
    const env: CacheEnvelope<T> = { ts: now(), body };
    await writeFile(path, JSON.stringify(env));
    // mtime = the envelope ts, so the sweep ages entries on the same clock
    await utimes(path, env.ts / 1000, env.ts / 1000);
  } catch {
    // best effort — a cache-write failure must never fail the fetch
  }
  try {
    const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : resolveHttpFetchCacheMaxBytes();
    await sweepFetchCache(dir, ttl, maxBytes, now);
  } catch {
    // best effort — a sweep failure must never fail the fetch
  }
  return body;
}

// Shared TTL-cache primitive for the chain/ modules (issue #455).
//
// Before this file, wallet-balances.ts, wallet-sleeves.ts, buyback-logs.ts,
// token-metrics.ts, allocation-framework.ts, and vault-economics.ts each
// hand-copied the identical
//   const CACHE_TTL_MS = 30_000;
//   let cache: { at: number; value: T } | null = null;
//   if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
// pattern, with a matching per-module `_reset<Module>CacheForTests` hook.
// token-prices.ts hand-copies a keyed variant of the same pattern (one entry
// per token address) with a DEMO_MODE-aware TTL that is a runtime decision,
// not a constant.
//
// TtlCache<K, V> is the low-level keyed primitive both shapes are built from.
// ttlCached() wraps a zero/-arg-ish async producer function in a single-slot
// TtlCache, matching every existing single-value call site's actual behavior:
// extra arguments (e.g. a test-only readers override) are accepted and
// forwarded to the wrapped function but do NOT participate in the cache key —
// exactly what every pre-existing copy of this pattern already did.
export interface TtlCacheEntry<V> {
  at: number;
  value: V;
}

/** A TTL may be a fixed number of ms, or a function resolved on every
 * get/set — token-prices.ts needs its window to track process.env.DEMO_MODE
 * at call time, not at module load. */
export type TtlMs = number | (() => number);

function resolveTtlMs(ttlMs: TtlMs): number {
  return typeof ttlMs === "function" ? ttlMs() : ttlMs;
}

/** Generic per-key cache with a TTL. `reset()` drops every entry — safe both
 * as a production invalidation hook (e.g. buyback-logs.ts invalidates after a
 * successful live index) and as the underlying implementation of a module's
 * test-only `_resetForTests` export. */
export class TtlCache<K, V> {
  private readonly store = new Map<K, TtlCacheEntry<V>>();

  constructor(private readonly ttlMs: TtlMs) {}

  get(key: K, now: number = Date.now()): V | undefined {
    const entry = this.store.get(key);
    if (entry && now - entry.at < resolveTtlMs(this.ttlMs)) return entry.value;
    return undefined;
  }

  set(key: K, value: V, now: number = Date.now()): void {
    this.store.set(key, { at: now, value });
  }

  reset(): void {
    this.store.clear();
  }
}

export interface TtlCachedFn<Args extends unknown[], T> {
  (...args: Args): Promise<T>;
  /** Production-safe cache invalidation (e.g. after a write that changes the
   * underlying data — see buyback-logs.ts::indexBuybacks). */
  invalidate(): void;
  /** Test-only alias of invalidate(), kept as its own name so call sites read
   * as test hygiene rather than a production cache-busting call. */
  _resetForTests(): void;
}

const SINGLETON_KEY = Symbol("ttlCached.singleton");

/** Wrap a single-slot async producer `fn` in a TTL cache: repeated calls
 * within `ttlMs` of the last successful resolution return the cached value
 * without re-invoking `fn`; a call after expiry (or a throwing prior call,
 * which never populates the cache) invokes `fn` again. */
export function ttlCached<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
  ttlMs: TtlMs,
): TtlCachedFn<Args, T> {
  const cache = new TtlCache<typeof SINGLETON_KEY, T>(ttlMs);

  const wrapped = (async (...args: Args): Promise<T> => {
    const now = Date.now();
    const hit = cache.get(SINGLETON_KEY, now);
    if (hit !== undefined) return hit;
    const value = await fn(...args);
    cache.set(SINGLETON_KEY, value, now);
    return value;
  }) as TtlCachedFn<Args, T>;

  wrapped.invalidate = () => cache.reset();
  wrapped._resetForTests = () => cache.reset();

  return wrapped;
}

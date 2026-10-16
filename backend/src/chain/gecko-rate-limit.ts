// Shared GeckoTerminal rate-limit coordination.
//
// Both the spot path (token-prices.ts) and the historical path
// (historical-prices.ts) hit the same GeckoTerminal host from the same IP,
// sharing one keyless rate-limit quota. This module is the single serialization
// and retry primitive they both use, so spot and historical requests cannot race
// for quota.
//
// HOW IT WORKS. Every request goes through `serialized()`, a chain-of-promises
// that enforces a minimum spacing between consecutive HTTP requests. This is
// strictly better than a mutual-exclusion gate: it provides both ordering AND
// spacing, and it naturally serializes across both code paths.
//
// 6 000 ms → ≤ 10 req/min, matching the GeckoTerminal keyless IP quota.
// The old spot path had no inter-request spacing (just mutual exclusion) and
// the old historical path used 3 000 ms — both could briefly exceed 10/min
// under concurrent load.  This default leaves a small safety margin.
const DEFAULT_MIN_INTERVAL_MS = 6_000;
// The paid CoinGecko plan (Basic: 250 to 300 calls a minute) is served from a different host with its own quota, so it
// is paced separately: 400 ms is 150 a minute, well inside it (issue 1062).
const DEFAULT_PRO_MIN_INTERVAL_MS = 400;

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function minIntervalMs(): number {
  // Backward compat: GECKO_OHLCV_MIN_INTERVAL_MS was the historical-path env.
  // GECKO_MIN_INTERVAL_MS is the new unified env. The unified env wins.
  return intEnv("GECKO_MIN_INTERVAL_MS", intEnv("GECKO_OHLCV_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS, 0), 0);
}

export function proMinIntervalMs(): number {
  return intEnv("GECKO_PRO_MIN_INTERVAL_MS", DEFAULT_PRO_MIN_INTERVAL_MS, 0);
}

export type GeckoTier = "free" | "pro";

let chain: Promise<void> = Promise.resolve();
// Per tier: a free request must be 6 s after the previous FREE request, however many Pro requests ran in between, or
// interleaving the two would push the free host past its 10-a-minute quota.
const lastRequestAtMs: Record<GeckoTier, number> = { free: 0, pro: 0 };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` serialized behind every other GeckoTerminal request, with at
 *  least the tier's minimum interval since the previous request of that tier. */
export function serialized<T>(fn: () => Promise<T>, tier: GeckoTier = "free"): Promise<T> {
  const run = chain.then(async () => {
    const interval = tier === "pro" ? proMinIntervalMs() : minIntervalMs();
    const gap = interval - (Date.now() - lastRequestAtMs[tier]);
    if (gap > 0) await sleep(gap);
    try {
      return await fn();
    } finally {
      lastRequestAtMs[tier] = Date.now();
    }
  });
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) and fall back to
 *  exponential backoff with the given `baseMs`. `attempt` is 1-based. */
export function retryAfterMs(header: string | null, attempt: number, baseMs: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  return baseMs * 2 ** (attempt - 1);
}

/** Test-only hygiene. */
export function _resetRateLimitStateForTests(): void {
  lastRequestAtMs.free = 0;
  lastRequestAtMs.pro = 0;
  chain = Promise.resolve();
}

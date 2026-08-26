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

let chain: Promise<void> = Promise.resolve();
let lastRequestAtMs = 0;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` serialized behind every other GeckoTerminal request, with at
 *  least `minIntervalMs()` between consecutive requests. */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const gap = minIntervalMs() - (Date.now() - lastRequestAtMs);
    if (gap > 0) await sleep(gap);
    try {
      return await fn();
    } finally {
      lastRequestAtMs = Date.now();
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
  lastRequestAtMs = 0;
  chain = Promise.resolve();
}

// Per-day historical USD prices for the wallet backfill (issue #709,
// docs/technical/data-self-healing.md §6.5.2).
//
// THIS IS THE FILE THAT REVERSES OPEN QUESTION 9. `chain/token-prices.ts` says
// historical valuation comes from the persisted `wallet_balance_samples` series
// "NOT from a re-fetched OHLCV series". That was written when the answer to
// "does OHLCV reach back far enough for illiquid ROBOTMONEY/BNKR?" was assumed
// to be no. It does. token-prices.ts's header is amended in the same change;
// the reversal is recorded in #709 rather than smuggled in, and is NOT settled
// until that issue is (PD3).
//
// HARD VENDOR CONSTRAINT, inherited unchanged from token-prices.ts:3-8 — this
// file reaches ONLY the GeckoTerminal host. New GeckoTerminal *endpoint* code is
// explicitly permitted (same vendor already in the repo); a new vendor is not.
//
// WHY NOT REUSE runGeckoBatch. token-prices.ts's batch runner is ADDRESS-keyed
// with no time dimension and targets the spot-only `token_price` endpoint. The
// pattern is copied here (serialize, cache, degrade one leg at a time); the code
// is not.
//
// COST. One OHLCV request serves up to ~181 daily candles, so a whole 42-day gap
// is about 4 requests across the market-priced pools and even a full year is
// ~10. Prices are not the rate-limit concern the backfill has to engineer
// around — the Base RPC is (base-rpc-client.ts's token bucket).
import type { TrackedAsset } from "../config.ts";
import { UA } from "../analytics/extract/http.ts";
import { withFetchCache } from "../analytics/extract/fetch-cache.ts";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// A keyless 429 was observed on the SIXTH call in ~15s against an endpoint this
// repo has already tuned to conserve quota (#202). Every request in this module
// goes through one serializer with a minimum spacing so a multi-pool,
// multi-page load cannot burst. This is a GeckoTerminal-host control and is
// unrelated to — and must never be confused with — the single shared Base RPC
// budget in base-rpc-client.ts.
const DEFAULT_MIN_INTERVAL_MS = 3_000;

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function minIntervalMs(): number {
  return intEnv("GECKO_OHLCV_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS, 0);
}

let chain: Promise<void> = Promise.resolve();
let lastRequestAtMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` serialized behind every other request from this module, with at
 *  least `GECKO_OHLCV_MIN_INTERVAL_MS` between consecutive requests. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
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

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return withFetchCache("json", url, async () => {
    const deadline = Date.now() + timeoutMs;
    const retries = intEnv("GECKO_OHLCV_MAX_RETRIES", 3, 0);
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`geckoterminal: timeout for ${url}`);
      const res = await serialized(() =>
        fetch(url, { signal: AbortSignal.timeout(remaining), headers: { "user-agent": UA, accept: "application/json" } }),
      );
      if (res.ok) return (await res.json()) as unknown;
      if (!GECKO_TRANSIENT_STATUSES.has(res.status) || attempt >= retries) {
        throw new Error(`${res.status} ${res.statusText} for ${url}`);
      }
      const wait = Math.min(intEnv("GECKO_OHLCV_RETRY_BASE_MS", 1_000, 1) * 2 ** attempt, Math.max(0, deadline - Date.now()));
      if (wait <= 0) throw new Error(`geckoterminal: retry budget exhausted after HTTP ${res.status} for ${url}`);
      await sleep(wait);
    }
  }) as Promise<unknown>;
}

// ── Pool resolution ──────────────────────────────────────────────────────────
// The OHLCV endpoint is keyed by POOL, not by the token address the spot path
// uses, and the three *_POOL_ID env vars are dead code with zero readers (#639)
// — so there is nothing configured to read. Pools are DERIVED at use time and
// then cached for the process; re-discovering per run is exactly what burns the
// keyless quota.

interface GeckoPool {
  id?: string;
  attributes?: {
    address?: string;
    volume_usd?: { h24?: string };
    reserve_in_usd?: string;
  };
}

const poolIdCache = new Map<string, Promise<string>>();

// Per-pool daily closes, with the window they cover.
//
// The repair driver asks DAY BY DAY (one job per missing day), and two symbols
// can share one pool (native ETH is priced off WETH's address). Caching by
// (pool, exact window) would therefore miss on every single day and turn an
// O(1)-per-window cost into O(days). This cache is keyed by POOL and remembers
// the range it holds, so the first day of a run pays one request and every
// later day inside that range pays nothing. A day outside it widens the range
// with one more request.
interface PoolCloses {
  closes: Map<string, number>;
  fromDate: string;
  toDate: string;
}
const closesCache = new Map<string, Promise<PoolCloses>>();

// How far back the first request for a pool reaches, so a day-at-a-time driver
// warms the whole gap in ONE request rather than one per day. One OHLCV request
// serves ~181 daily candles, which is the natural size of this lookback.
const PREFETCH_DAYS = 180;

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function poolCloses(poolKey: string, fromDate: string, toDate: string): Promise<Map<string, number>> {
  const pending = closesCache.get(poolKey);
  if (pending) {
    const held = await pending;
    if (held.fromDate <= fromDate && held.toDate >= toDate) return held.closes;
    // Widen: refetch the union rather than stitching two partial windows, so
    // the cached range is always exactly what one response covered.
    fromDate = held.fromDate < fromDate ? held.fromDate : fromDate;
    toDate = held.toDate > toDate ? held.toDate : toDate;
  } else {
    // Widen in BOTH directions on the first request for a pool. Backwards
    // because the gap being repaired extends into the past; forwards to the
    // current day because the driver walks the gap day by day and each new day
    // would otherwise sit one day past the cached upper bound — turning
    // "one request per window" back into one request per day.
    fromDate = shiftDay(fromDate, -PREFETCH_DAYS);
    const today = new Date().toISOString().slice(0, 10);
    if (today > toDate) toDate = today;
  }
  const next = (async (): Promise<PoolCloses> => ({
    closes: await fetchDailyCloses(poolKey, fromDate, toDate),
    fromDate,
    toDate,
  }))();
  closesCache.set(poolKey, next);
  next.catch(() => closesCache.delete(poolKey));
  return (await next).closes;
}

function poolKeyFrom(pool: GeckoPool): string | null {
  // `attributes.address` is authoritative; `id` is "base_<address>" (and for a
  // v4 pool the address is a 32-byte hash, not a 20-byte address — the OHLCV
  // endpoint accepts it either way).
  const addr = pool.attributes?.address;
  if (typeof addr === "string" && addr.length > 0) return addr;
  const id = pool.id;
  if (typeof id === "string" && id.length > 0) return id.replace(/^base_/, "");
  return null;
}

/**
 * The pool to price `tokenAddress` from: the one with the highest 24h VOLUME.
 *
 * SORT BY VOLUME, NOT RESERVE. A `max(reserve_in_usd)` selector picks a decoy
 * for WETH — an observed `Bnb / WETH` pool reports ~$7.68B reserve against
 * `volume.h1 = 0.0` and wins a reserve sort outright. ROBOTMONEY is unambiguous
 * either way; BNKR's top two disagree by sort key but are both real BNKR/WETH
 * pools at a negligible price difference; WETH is the case where reserve-sort is
 * unsafe and volume-sort is correct.
 */
export async function resolvePoolForToken(tokenAddress: string, timeoutMs = 15_000): Promise<string> {
  const lc = tokenAddress.toLowerCase();
  const cached = poolIdCache.get(lc);
  if (cached) return cached;
  const pending = (async () => {
    const url = `${GECKOTERMINAL_BASE}/networks/base/tokens/${lc}/pools`;
    const body = (await getJson(url, timeoutMs)) as { data?: GeckoPool[] };
    const pools = Array.isArray(body?.data) ? body.data : [];
    let best: { key: string; volume: number } | null = null;
    for (const p of pools) {
      const key = poolKeyFrom(p);
      if (!key) continue;
      const volume = Number(p.attributes?.volume_usd?.h24 ?? NaN);
      if (!Number.isFinite(volume)) continue;
      if (!best || volume > best.volume) best = { key, volume };
    }
    if (!best) throw new Error(`geckoterminal: no pool with 24h volume for token ${lc}`);
    return best.key;
  })();
  poolIdCache.set(lc, pending);
  // A failed discovery must not be cached as a permanent negative.
  pending.catch(() => poolIdCache.delete(lc));
  return pending;
}

// ── Daily OHLCV ──────────────────────────────────────────────────────────────

function isoDay(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

// A response is a FULL page at the server's own cap (~181 candles were returned
// for both `limit=1000` and `limit=500`). Anything materially short of that has
// exhausted the pool's history, so there is nothing older to page to.
const SHORT_PAGE = 100;

/**
 * Daily CLOSES keyed by UTC calendar day for one pool, covering
 * [fromDate, toDate] inclusive.
 *
 * Candles from this endpoint are EXACTLY UTC-midnight aligned, which is the
 * same day key `worker/handlers/wallet.ts:49` writes as `sampleDate` — so no
 * boundary reconciliation is needed, and none is done here. A ~6-month server
 * window caps each request (`limit=1000` and `limit=500` both returned 181
 * candles), so deeper windows page backwards with `before_timestamp`.
 */
export async function fetchDailyCloses(
  poolKey: string,
  fromDate: string,
  toDate: string,
  timeoutMs = 20_000,
): Promise<Map<string, number>> {
  const fromSec = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
  const toSec = Math.floor(Date.parse(`${toDate}T00:00:00Z`) / 1000);
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
    throw new Error(`historical-prices: bad range ${fromDate}..${toDate}`);
  }
  const out = new Map<string, number>();
  let before = toSec + 86_400; // exclusive upper bound: one day past the newest wanted candle
  // Bounded so a server that keeps returning the same page can never spin.
  for (let page = 0; page < 12; page++) {
    const url = `${GECKOTERMINAL_BASE}/networks/base/pools/${poolKey}/ohlcv/day?aggregate=1&limit=1000&before_timestamp=${before}`;
    const body = (await getJson(url, timeoutMs)) as { data?: { attributes?: { ohlcv_list?: unknown } } };
    const list = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length === 0) break;
    let oldest = Infinity;
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const ts = Number(row[0]);
      if (!Number.isFinite(ts)) continue;
      if (ts < oldest) oldest = ts;
      if (ts < fromSec || ts > toSec) continue;
      // A close that is null / missing / non-numeric is an ABSENT price for that
      // day. `Number(null)` is 0 and 0 is finite, so this must be checked BEFORE
      // coercion — otherwise a thin candle prices a real holding at zero, which
      // reads downstream as a drawdown rather than as a gap.
      const rawClose = row[4];
      const close = typeof rawClose === "number" ? rawClose : typeof rawClose === "string" ? Number(rawClose) : NaN;
      if (Number.isFinite(close)) out.set(isoDay(ts), close);
    }
    if (!Number.isFinite(oldest) || oldest <= fromSec) break;
    if (oldest >= before) break; // no progress — stop rather than loop
    // A page materially below the server's ~181-candle cap is the end of this
    // pool's history: asking again only re-learns that, at the cost of a
    // request against a keyless quota that 429s on the 6th call in ~15s.
    if (list.length < SHORT_PAGE) break;
    before = oldest;
  }
  return out;
}

// ── The public reader ────────────────────────────────────────────────────────

/** A per-symbol, per-day USD price table for a fixed window. */
export type HistoricalPriceTable = Map<string, Map<string, number>>;

/**
 * Build the price table the backfill needs for `assets` over
 * [fromDate, toDate].
 *
 * - `usdc` price kind (USDC itself, and both strategy sleeves, whose underlying
 *   is USDC) is PINNED $1 and costs no request. ZYFAI-SS1 / GIZA-SS1 are not
 *   share tokens — config.ts:172-180 documents them as the agent's delegated
 *   smart-account wallets on Base, valued at NAV in underlying USDC.
 * - `gecko` price kind resolves a pool once, then pages daily candles.
 * - `yahoo` (SP500) is DELIBERATELY ABSENT. It is not a chain read at all
 *   (valuationKind 'config'), #648 records that the column splices two
 *   different measurements, and PD7's recommendation is to SKIP it rather than
 *   approximate it. Passing a yahoo-priced asset here throws rather than
 *   silently producing a number nobody decided to produce.
 *
 * A per-symbol failure is left OUT of the table rather than defaulted — the
 * caller decides what a missing price means for its day, and for the backfill
 * it means "do not write this day", never "price it at zero".
 */
export async function loadHistoricalPrices(
  assets: TrackedAsset[],
  fromDate: string,
  toDate: string,
): Promise<HistoricalPriceTable> {
  const table: HistoricalPriceTable = new Map();
  const days: string[] = [];
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }

  for (const asset of assets) {
    if (asset.priceKind === "usdc") {
      table.set(asset.symbol, new Map(days.map((d) => [d, 1])));
      continue;
    }
    if (asset.priceKind !== "gecko") {
      throw new Error(
        `historical-prices: ${asset.symbol} has priceKind '${asset.priceKind}', which the backfill deliberately does not resolve (see PD7 / #648)`,
      );
    }
    if (!asset.address) throw new Error(`historical-prices: ${asset.symbol} has no address to resolve a pool from`);
    const poolKey = await resolvePoolForToken(asset.address);
    const closes = await poolCloses(poolKey, fromDate, toDate);
    // Copy out only the requested window: the cache legitimately holds more.
    const windowed = new Map<string, number>();
    for (const d of days) {
      const p = closes.get(d);
      if (p !== undefined) windowed.set(d, p);
    }
    table.set(asset.symbol, windowed);
  }
  return table;
}

/** Test-only hygiene: forget the resolved-pool cache between suites. */
export function _resetHistoricalPriceCachesForTests(): void {
  poolIdCache.clear();
  closesCache.clear();
  lastRequestAtMs = 0;
  chain = Promise.resolve();
}

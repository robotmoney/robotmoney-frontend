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
// Importing config.ts for VALUE (the pinned pools) and not only for a type means
// this module now inherits config.ts's module-level `required("DATABASE_URL")`.
// Its one production importer is the wallet backfill, which cannot run without a
// database anyway; a standalone script that only wants a price cannot.
import { pinnedPoolForToken, type TrackedAsset } from "../config.ts";
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
// uses, so a pool must be named before a candle can be read. WHICH pool is a
// config decision (config.ts PINNED_GECKO_POOLS, the live successor to the dead
// *_POOL_ID env vars of #639), because the alternative decides it by live
// measurement: ranking a token's pools by 24h volume re-runs the choice on every
// run, and for WETH the top two candidates trade places, so two backfills of the
// SAME day can price it from two different markets with nothing in the rows to
// show which one answered.
//
// A token with no pin still falls back to that ranking, and the fallback is
// logged rather than silent. Falling back is defensible only because the request
// names the token and the response is checked against the side the vendor says
// it priced (assertPoolOrientation below) — so a pool the ranking picks whose
// sides are the wrong way round produces a refusal instead of the other token's
// price. A pin buys determinism; the request buys correctness.
//
// Either way the pool is cached for the process: re-discovering per run is
// exactly what burns the keyless quota.

interface GeckoPool {
  id?: string;
  attributes?: {
    address?: string;
    volume_usd?: { h24?: string };
    reserve_in_usd?: string;
  };
}

const poolIdCache = new Map<string, Promise<string>>();

// Daily closes for one (pool, token) pair, with the range they can ANSWER for.
//
// KEYED BY POOL **AND** TOKEN. The request names the token whose side of the
// pair is wanted, so one pool address returns a different series depending on
// which token was asked for — on a `cbBTC / WETH` pool the same address answers
// with BTC prices or with ETH prices. A pool-only key would hand whichever token
// arrived first its series to every other token that resolves to that pool, for
// the life of the process: the exact wrong-price failure this module is built to
// refuse, cached. Native ETH and WETH still share ONE entry and cost ONE
// request, because they are the same address — config.ts gives ETH WETH's
// PRICING address — and therefore the same key.
//
// The repair driver asks DAY BY DAY (one job per missing day). Caching by
// (pool, token, exact window) would miss on every single day and turn an
// O(1)-per-window cost into O(days), so an entry remembers the range it holds:
// the first day of a run pays one request and every later day inside that range
// pays nothing. A day outside it widens the range with one more request.
//
// `covered` is what the RESPONSE reached, which is not always what was asked
// for — paging stops at a bounded number of requests, and today's candle may not
// exist yet. A day outside it was NOT FETCHED and must re-enter the fetch path;
// only a day INSIDE it may be read as "this day has no price". Conflating the
// two is how one truncated page becomes a permanent "no price" for every older
// day for the rest of the process. `null` means the response reached nothing.
interface PoolCloses {
  closes: Map<string, number>;
  covered: { fromDate: string; toDate: string } | null;
}
const closesCache = new Map<string, Promise<PoolCloses>>();

function closesKey(poolKey: string, tokenAddress: string): string {
  return `${poolKey.toLowerCase()}|${tokenAddress.toLowerCase()}`;
}

// How far back the first request for a pool reaches, so a day-at-a-time driver
// warms the whole gap in ONE request rather than one per day. One OHLCV request
// serves ~181 daily candles, which is the natural size of this lookback.
const PREFETCH_DAYS = 180;

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The days a response can be READ for — priced where it carried a candle, and
 * genuinely price-less where it did not. Outside this, silence means "not
 * asked", and the day has to be fetched again.
 *
 * THE FLOOR moves down to the requested start only when paging stopped for a
 * reason that proves nothing older was withheld: it walked past that start, or
 * the pool ran out of history. When it stopped at one of its own bounds instead,
 * the days below the oldest candle it saw were never requested, and recording
 * them as covered would cache "we gave up here" as "there is nothing here".
 *
 * THE CEILING may stay at the requested end for SETTLED days: the first page is
 * the newest the pool has, so a settled day between the newest candle and the
 * requested end has no candle rather than an unfetched one. TODAY is the
 * exception — its candle is still forming and may exist an hour from now — so
 * coverage stops at yesterday unless the response actually carried today.
 */
function coveredRange(read: DailyCloseWindow, fromDate: string, toDate: string): PoolCloses["covered"] {
  if (read.oldestSec === null || read.newestSec === null) return null;
  const from = read.floorProven ? fromDate : isoDay(read.oldestSec);
  const today = utcToday();
  const to = toDate >= today && isoDay(read.newestSec) < today ? shiftDay(today, -1) : toDate;
  return from > to ? null : { fromDate: from, toDate: to };
}

async function poolCloses(
  poolKey: string,
  tokenAddress: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, number>> {
  const key = closesKey(poolKey, tokenAddress);
  const pending = closesCache.get(key);
  if (pending) {
    const held = await pending;
    const covered = held.covered;
    if (covered && covered.fromDate <= fromDate && covered.toDate >= toDate) return held.closes;
    if (covered && covered.fromDate <= fromDate) {
      // TOP UP THE CEILING ONLY. Everything asked for below the entry's ceiling
      // is already answered, and the usual reason the ceiling falls short is
      // that the request reaches the CURRENT day: today's candle may not be
      // published yet, so `coveredRange` will not record today as covered, and
      // an ask that ends today can therefore NEVER be satisfied from this entry
      // however often it is repeated. Widening would answer that by re-reading
      // the whole window — up to PREFETCH_DAYS of paging — on every single call,
      // against a keyless quota that 429s on the sixth request in ~15 seconds.
      //
      // So only the uncovered tail is fetched and stitched onto the entry.
      // Stitching is sound HERE and nowhere else: the tail is asked for FROM the
      // covered ceiling, so the two windows abut and the merged range is still
      // contiguous and still entirely fetched, while the FLOOR claim is
      // inherited untouched from the read that earned it. What this deliberately
      // does not do is cache today's absence — a caller that keeps asking for
      // today keeps paying one request for it, which is the honest price of
      // never recording a still-forming candle as a settled blank.
      const tailFrom = covered.toDate;
      const tail = (async (): Promise<PoolCloses> => {
        const read = await fetchDailyCloses(poolKey, tokenAddress, tailFrom, toDate);
        const merged = new Map(held.closes);
        for (const [day, price] of read.closes) merged.set(day, price);
        const reached = coveredRange(read, tailFrom, toDate);
        const ceiling = reached && reached.toDate > covered.toDate ? reached.toDate : covered.toDate;
        return { closes: merged, covered: { fromDate: covered.fromDate, toDate: ceiling } };
      })();
      closesCache.set(key, tail);
      tail.catch(() => closesCache.delete(key));
      return (await tail).closes;
    }
    // Widen: the FLOOR is short, so refetch the union rather than stitching a
    // window onto the bottom of one whose floor was never established. An entry
    // that covered nothing contributes no bound to widen to — its window is
    // refetched as asked, which is what makes a truncated or still-forming day
    // retryable instead of permanently blank.
    if (covered) {
      fromDate = covered.fromDate < fromDate ? covered.fromDate : fromDate;
      toDate = covered.toDate > toDate ? covered.toDate : toDate;
    }
  } else {
    // Widen in BOTH directions on the first request for a pool. Backwards
    // because the gap being repaired extends into the past; forwards to the
    // current day because the driver walks the gap day by day and each new day
    // would otherwise sit one day past the cached upper bound — turning
    // "one request per window" back into one request per day.
    fromDate = shiftDay(fromDate, -PREFETCH_DAYS);
    const today = utcToday();
    if (today > toDate) toDate = today;
  }
  const next = (async (): Promise<PoolCloses> => {
    const read = await fetchDailyCloses(poolKey, tokenAddress, fromDate, toDate);
    return { closes: read.closes, covered: coveredRange(read, fromDate, toDate) };
  })();
  closesCache.set(key, next);
  next.catch(() => closesCache.delete(key));
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
 * The FALLBACK pool for `tokenAddress` — the one with the highest 24h VOLUME —
 * for tokens config.ts pins no pool for. Its answer is a measurement, so it can
 * differ between two runs an hour apart; callers announce that they took it.
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

interface GeckoOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: unknown } };
  meta?: { base?: { address?: unknown; symbol?: unknown }; quote?: { address?: unknown; symbol?: unknown } };
}

/** A pool that does not price the token that was asked for. Distinct from a
 *  transport failure on purpose: it is a settled fact about the pool, so a
 *  retry returns the same wrong side, and the caller drops the symbol instead of
 *  deferring the window. */
export class PoolOrientationError extends Error {}

/**
 * Refuse a response that priced the other half of the pair.
 *
 * A pool holds two tokens and its candles denominate ONE of them. Which one is
 * whichever the request named: `meta.base` follows the `token=` parameter, so
 * reading it back checks the ANSWER rather than the question, in-band, with no
 * second request and no second vendor.
 *
 * The failure this closes is silent by nature. Ask a `cbBTC / WETH` pool for
 * WETH without naming it and the reply is cbBTC's series — finite, plausible,
 * and ~25× too large, indistinguishable downstream from a real WETH price and
 * written into the ledger as one. So the response is believed only when it says
 * which token it priced and says the right one: no price at all fails a single
 * day loudly, while a wrong price is stored and trusted.
 */
function assertPoolOrientation(poolKey: string, token: string, body: GeckoOhlcvResponse): void {
  const base = body?.meta?.base;
  const address = typeof base?.address === "string" ? base.address.toLowerCase() : null;
  if (address === null) {
    throw new PoolOrientationError(
      `geckoterminal: pool ${poolKey} answered for token ${token} with no meta.base.address — which side of the pair these candles price cannot be established, so none of them is used as a price`,
    );
  }
  if (address !== token) {
    const symbol = typeof base?.symbol === "string" ? base.symbol : "?";
    throw new PoolOrientationError(
      `geckoterminal: pool ${poolKey} was asked for token ${token} and priced ${symbol} ${address} instead — these candles are the OTHER side of the pair, not this token's price`,
    );
  }
}

/** What one paged read of a pool actually reached — see `coveredRange`, which
 *  is the only thing that reads anything here beyond `closes`. */
export interface DailyCloseWindow {
  /** Daily closes keyed by UTC calendar day. */
  closes: Map<string, number>;
  /** Oldest and newest candle timestamps SEEN, across every page; null when the
   *  pool returned no usable candle at all. */
  oldestSec: number | null;
  newestSec: number | null;
  /** True when paging stopped for a reason that proves nothing older exists to
   *  fetch — it reached past the requested start, or the pool's history ran out.
   *  False when it stopped at one of its OWN bounds, which says nothing about
   *  the days below `oldestSec` except that they were never asked for. */
  floorProven: boolean;
}

/**
 * Daily CLOSES keyed by UTC calendar day for `tokenAddress` as priced by
 * `poolKey`, over [fromDate, toDate] inclusive, plus how much of that range the
 * response actually reached.
 *
 * THE TOKEN IS PART OF THE REQUEST, not an interpretation of the reply. Absent
 * `token=`, the endpoint prices the pool's own base side, which for a token
 * sitting on the quote side is the wrong asset entirely; `currency=usd` likewise
 * says what the numbers are denominated in rather than leaving it to the pool.
 * Both are then verified against `meta.base` before any candle is read.
 *
 * Candles from this endpoint are EXACTLY UTC-midnight aligned, which is the
 * same day key `worker/handlers/wallet.ts:49` writes as `sampleDate` — so no
 * boundary reconciliation is needed, and none is done here. A ~6-month server
 * window caps each request (`limit=1000` and `limit=500` both returned 181
 * candles), so deeper windows page backwards with `before_timestamp`.
 */
export async function fetchDailyCloses(
  poolKey: string,
  tokenAddress: string,
  fromDate: string,
  toDate: string,
  timeoutMs = 20_000,
): Promise<DailyCloseWindow> {
  const token = tokenAddress.toLowerCase();
  const fromSec = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
  const toSec = Math.floor(Date.parse(`${toDate}T00:00:00Z`) / 1000);
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
    throw new Error(`historical-prices: bad range ${fromDate}..${toDate}`);
  }
  const out = new Map<string, number>();
  // Folded across every page, because what the caller may CACHE as answered
  // depends on how far the paging actually got, not on how far it was asked to.
  let oldestSec: number | null = null;
  let newestSec: number | null = null;
  let floorProven = false;
  let before = toSec + 86_400; // exclusive upper bound: one day past the newest wanted candle
  // Bounded so a server that keeps returning the same page can never spin.
  for (let page = 0; page < 12; page++) {
    const url = `${GECKOTERMINAL_BASE}/networks/base/pools/${poolKey}/ohlcv/day?aggregate=1&limit=1000&before_timestamp=${before}&token=${token}&currency=usd`;
    const body = (await getJson(url, timeoutMs)) as GeckoOhlcvResponse;
    // Before a single candle is read: an unverifiable page is refused whole,
    // never mined for the rows that happen to look reasonable.
    assertPoolOrientation(poolKey, token, body);
    const list = body?.data?.attributes?.ohlcv_list;
    // A body carrying no candle ARRAY is malformed, and a malformed body proves
    // nothing about the pool's history. An EMPTY array does: it is the vendor
    // saying there is nothing in the window below `before`, and it is the only
    // statement of exhaustion this endpoint makes. See the note at the bottom of
    // the loop for why a merely SHORT page is not that statement.
    if (!Array.isArray(list)) break;
    if (list.length === 0) {
      floorProven = true;
      break;
    }
    let oldest = Infinity;
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const ts = Number(row[0]);
      if (!Number.isFinite(ts)) continue;
      if (ts < oldest) oldest = ts;
      if (oldestSec === null || ts < oldestSec) oldestSec = ts;
      if (newestSec === null || ts > newestSec) newestSec = ts;
      if (ts < fromSec || ts > toSec) continue;
      // A close that is null / missing / non-numeric is an ABSENT price for that
      // day. `Number(null)` is 0 and 0 is finite, so this must be checked BEFORE
      // coercion — otherwise a thin candle prices a real holding at zero, which
      // reads downstream as a drawdown rather than as a gap.
      //
      // A literal 0 (or a negative) is refused for that same reason and not
      // because it is unparseable: no token this table prices is worth nothing,
      // so a zero close is a defect in the candle, and believing it writes
      // `value_usd = 0` for every holding of that asset — a one-day crash to
      // zero that recovers the next day, recorded as a SETTLED 'filled' day no
      // repair pass will revisit. A disclosed gap is the strictly better
      // outcome, and it is what the sibling candle reader already does
      // (chain/token-prices.ts, `close <= 0` throws).
      const rawClose = row[4];
      const close = typeof rawClose === "number" ? rawClose : typeof rawClose === "string" ? Number(rawClose) : NaN;
      if (Number.isFinite(close) && close > 0) out.set(isoDay(ts), close);
    }
    if (!Number.isFinite(oldest) || oldest <= fromSec) {
      // Reaching past the requested start proves the whole window was asked
      // for — the other proving stop is the empty page above, which proves the
      // stronger claim that nothing older exists. A page of rows with no
      // readable timestamp proves neither, and says so.
      floorProven = oldest <= fromSec;
      break;
    }
    if (oldest >= before) break; // no progress — stop rather than loop
    // PAGING IS NOT STOPPED BY ROW COUNT. Each request is capped by a ~6-month
    // WINDOW, not by a number of candles, so a page with few rows means few days
    // TRADED inside that window — not that the history ended. This module exists
    // for the illiquid end of the book: a pool that trades one day in three
    // fills a whole 181-day window with ~60 rows, and reading that as exhaustion
    // both abandons real candles still below it and, far worse, lets
    // `floorProven` record every unfetched day beneath as priceless. The end of
    // history is proven by asking once more and getting an empty list back,
    // which costs ONE extra request per (pool, token) for the life of the
    // process — not per day, because the answer is cached. The residual
    // assumption is narrow and deliberate: a hole in a pool's history wider than
    // one server window would still read as the end of it.
    before = oldest;
  }
  // Falling out of the page bound leaves floorProven false: the days below the
  // oldest candle seen were never requested, and must stay fetchable.
  return { closes: out, oldestSec, newestSec, floorProven };
}

// ── The public reader ────────────────────────────────────────────────────────

/**
 * The pool `symbol` is priced from: the one config pins for its address, else
 * the volume ranking.
 *
 * The fallback is announced because it is the branch that makes the price a
 * property of the hour the job ran in rather than of the config it ran with —
 * an operator seeing a wandering price needs the pool choice to be a line they
 * can find. It is announced where the ranking REQUEST happens and not on every
 * reuse of its cached answer: the driver runs one job per missing day, and a
 * line repeated once per day is a line that gets filtered out.
 */
async function poolForToken(symbol: string, tokenAddress: string): Promise<string> {
  const pinned = pinnedPoolForToken(tokenAddress);
  if (pinned) return pinned;
  if (!poolIdCache.has(tokenAddress.toLowerCase())) {
    console.warn(
      `historical-prices: no pinned pool for ${symbol} (${tokenAddress}) — ranking its pools by 24h volume, which can name a different pool on a later run`,
    );
  }
  return resolvePoolForToken(tokenAddress);
}

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
 * - `gecko` price kind reads daily candles from the pool config PINS for the
 *   token, or from the volume ranking when nothing is pinned; either way the
 *   request names the token, so a pool that holds it on the quote side is
 *   refused rather than believed.
 * - `yahoo` (SP500) is DELIBERATELY ABSENT. It is not a chain read at all
 *   (valuationKind 'config'), #648 records that the column splices two
 *   different measurements, and PD7's recommendation is to SKIP it rather than
 *   approximate it. Passing a yahoo-priced asset here throws rather than
 *   silently producing a number nobody decided to produce.
 *
 * A REFUSAL for one symbol — a pool whose candles are not that token's — leaves
 * the symbol out of the table rather than defaulting it, and leaves every other
 * symbol's entry standing. The caller decides what a missing price means for its
 * day, and for the backfill it means "do not write this day", never "price it at
 * zero".
 *
 * ABSENT SYMBOL AND BLANK DAY ARE DIFFERENT ANSWERS, and callers depend on the
 * difference. Every symbol this function resolved gets a map, empty or not; a
 * symbol with NO map was refused at the pool. That refusal is a settled fact
 * about the pool and therefore about EVERY day in the window at once, so a
 * caller that charges its days a retry budget must charge this to the window and
 * not to the days (ops/wallet-backfill.ts does exactly that, via deferDay) —
 * otherwise a mistyped pin retires the whole window permanently, and fixing the
 * pin no longer repairs it. A blank day inside a present map is the opposite: a
 * thin candle, that day's own problem, and worth its own attempt.
 *
 * A TRANSPORT failure is deliberately not swallowed that way: a timeout or a 429
 * says nothing about whether a price exists, so it rejects this whole call and
 * the backfill defers the window and tries again later rather than charging the
 * day an attempt for the vendor's bad minute.
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
    try {
      const poolKey = await poolForToken(asset.symbol, asset.address);
      const closes = await poolCloses(poolKey, asset.address, fromDate, toDate);
      // Copy out only the requested window: the cache legitimately holds more.
      const windowed = new Map<string, number>();
      for (const d of days) {
        const p = closes.get(d);
        if (p !== undefined) windowed.set(d, p);
      }
      table.set(asset.symbol, windowed);
    } catch (err) {
      if (!(err instanceof PoolOrientationError)) throw err;
      console.warn(`historical-prices: ${asset.symbol} is absent from this price table —`, err);
    }
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

// Keyless USD spot prices for the prop-wallet valuation feed (issue #84).
//
// HARD CONSTRAINT (AC — no new vendor/key): this file reaches ONLY the
// GeckoTerminal (crypto) and Yahoo (SP500) hosts — the same vendors already in
// the repo — plus a deterministic hermetic stub. No Alchemy/DexScreener/
// CoinGecko/Dune/Supabase host or import. New GeckoTerminal-*endpoint* code is
// allowed (same vendor): analytics/extract/geckoterminal.ts today only counts
// new pools, so the token_price read below is genuinely new fetcher code.
//
// Prices in THIS file are SPOT only, and that has not changed.
//
// OPEN QUESTION 9 IS REVERSED — read this before citing the old text (issue
// #709 / docs/technical/markets-asset-pricing-ingest.md §3.2, PD3). This header used to
// say historical valuation comes from the persisted wallet_balance_samples
// series "NOT from a re-fetched OHLCV series", on the premise that
// GeckoTerminal OHLCV may not reach back far enough for illiquid
// ROBOTMONEY/BNKR. It does. Daily OHLCV candles are UTC-midnight aligned —
// the same day key worker/handlers/wallet.ts writes as sampleDate — and one
// request serves ~181 of them.
//
// So the standing arrangement is now:
//   - the daily sampler accumulates forward and reads prices HERE, at spot;
//   - a day the sampler MISSED is repaired by chain/historical-prices.ts, which
//     reads that day's own close, and by ops/wallet-backfill.ts, which reads
//     that day's own block. Repaired rows are tagged provenance='backfilled'
//     and never overwrite a day the sampler wrote;
//   - the pre-launch seeded rows (migration 0014) remain what they were: ported
//     history, provenance 'seed', never a chain read.
//
// This file is still the only SPOT price path, and nothing here fetches a time
// series. Do not add one here — historical-prices.ts owns that, deliberately as
// separate code (same vendor, different endpoint, different failure semantics).
import type { PriceSource, TrackedAsset } from "../config.ts";
import { SP500_TICKER } from "../config.ts";
import { UA } from "../analytics/extract/http.ts";
import { withFetchCache } from "../analytics/extract/fetch-cache.ts";
import { fetchYahoo } from "../analytics/extract/yahoo.ts";
import { TtlCache } from "./ttl-cache.ts";
import { serialized, retryAfterMs, sleep } from "./gecko-rate-limit.ts";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// Production defaults to 30s, short enough that the one-minute sampler never
// persists the same spot twice as fresh. Shared smoke/smoke orchestration
// explicitly supplies one hour through this capability-specific setting.
export const TOKEN_PRICE_CACHE_TTL_ENV = "TOKEN_PRICE_CACHE_TTL_MS";
export const DEFAULT_TOKEN_PRICE_CACHE_TTL_MS = 30_000;

export function resolveTokenPriceCacheTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[TOKEN_PRICE_CACHE_TTL_ENV];
  if (raw === undefined || raw === "") return DEFAULT_TOKEN_PRICE_CACHE_TTL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${TOKEN_PRICE_CACHE_TTL_ENV} must be a non-negative integer number of milliseconds`);
  }
  return value;
}

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function geckoMaxRetries(): number {
  return intEnv("GECKO_PRICE_MAX_RETRIES", 3, 0);
}

function geckoRetryBaseMs(): number {
  return intEnv("GECKO_PRICE_RETRY_BASE_MS", 250, 1);
}

// The keyless endpoint rate-limits short concurrent bursts AND meters a small
// per-IP quota, so unique token reads are SERIALIZED, deduplicated per address
// (WETH + native ETH share the WETH price), and MICRO-BATCHED: every caller
// that arrives while a batch is still open — the wallet feeds' same-tick
// Promise.all fan-out over legs, or callers queued behind the batch gate —
// coalesces into ONE comma-separated token_price request. A sampler run that
// values WETH/ROBOTMONEY/BNKR therefore costs 1 upstream call, not 3 (the
// smoke/CI quota-exhaustion fix; symptom tracked in #202).
const geckoPending = new Map<string, Promise<number>>();
// The shared keyed TTL-cache primitive (chain/ttl-cache.ts, issue #455), keyed
// per lowercased token address. ttlMs is passed as a resolver function (not a
// constant) so the capability TTL is resolved at call time.
const geckoPriceCache = new TtlCache<string, number>(resolveTokenPriceCacheTtlMs);

// The batch currently accepting joiners (null when none). It stays open until
// its runner passes the batch gate (one microtask even when the gate is free),
// then closes so its address set — and therefore its URL, which doubles as the
// withFetchCache key — is final before the fetch goes out.
// Per-address uniqueness inside `waiters` is guaranteed by the geckoPending
// gate: a second same-address caller never opens or joins a batch while the
// first is outstanding. `timeoutMs` is the max over joiners so one shared
// request never cuts an individual caller's budget short.
interface GeckoBatch {
  waiters: Map<string, { resolve: (price: number) => void; reject: (err: unknown) => void }>;
  timeoutMs: number;
}
let geckoOpenBatch: GeckoBatch | null = null;

// Batch serialization gate. Batches execute one at a time so a second batch
// stays open while the first is in-flight, letting concurrent callers join it.
// Rate-limit spacing is handled by serialized() inside geckoFetchJson; this
// gate exists purely for batch coalescing.
let batchChain: Promise<void> = Promise.resolve();

// Test-only cache/gate hygiene. Production callers never reset live prices.
export function _resetTokenPriceCacheForTests(): void {
  geckoPending.clear();
  geckoPriceCache.reset();
  geckoOpenBatch = null;
  batchChain = Promise.resolve();
  geckoDailyCloseCache.clear();
}

// Deterministic hermetic fixtures (PRICE_SOURCE=stub). Recognizable, stable
// magnitudes so the smoke's rendered totals are reproducible without touching a
// live rate-limited price host. USDC is pinned $1 without a fixture.
const STUB_PRICES: Record<string, number> = {
  WETH: 1600,
  ETH: 1600,
  ROBOTMONEY: 0.00001,
  BNKR: 0.0005,
  SP500: 4600,
};

// GeckoTerminal simple token_price (keyless), BATCHED: one GET prices a comma-
// separated list of Base token addresses.
//   GET /simple/networks/base/token_price/{addr1},{addr2},...
//   → { data: { attributes: { token_prices: { "0xaddr1": "1234.5", ... } } } }
// `addresses` MUST arrive lowercase + deduped + SORTED (runGeckoBatch owns
// that): the URL doubles as the withFetchCache key, so a fixed asset set must
// yield the SAME url regardless of arrival order — one on-disk entry, not one
// per permutation. Returns the raw token_prices map; per-address presence is
// judged by the batch runner so ONE absent token fails only its own waiter.
// The final object guard also shields against a stale on-disk envelope from
// the pre-batch code, which cached a bare number under the same single-address
// URL key — that degrades to a per-leg miss and self-heals at TTL expiry.
// One retry/deadline budget shared by every GeckoTerminal endpoint this file
// reads (the batched token_price above and the daily OHLCV below), so a second
// endpoint cannot quietly acquire a laxer rate-limit policy than the first.
// `label` only shapes the error text; the hard-status message is byte-identical
// to the pre-extraction one so the resilience suite's status assertions hold.
async function geckoFetchJson(url: string, timeoutMs: number, label: string): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  const retries = geckoMaxRetries();
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`geckoterminal: ${label} timeout`);
    const res = await serialized(() =>
      fetch(url, {
        signal: AbortSignal.timeout(remaining),
        headers: { "user-agent": UA, accept: "application/json" },
      }),
    );
    if (res.ok) return await res.json();
    if (!GECKO_TRANSIENT_STATUSES.has(res.status) || attempt >= retries) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    const wait = retryAfterMs(res.headers.get("retry-after"), attempt + 1, geckoRetryBaseMs());
    if (wait >= deadline - Date.now()) {
      throw new Error(`geckoterminal: ${label} retry budget exhausted after HTTP ${res.status}`);
    }
    await sleep(wait);
  }
}

async function fetchGeckoTokenPricesUsdUncached(addresses: string[], timeoutMs: number): Promise<Record<string, string>> {
  const url = `${GECKOTERMINAL_BASE}/simple/networks/base/token_price/${addresses.join(",")}`;
  const body = await (withFetchCache("json", url, async () => {
    const j = (await geckoFetchJson(url, timeoutMs, `price for ${addresses.join(",")}`)) as {
      data?: { attributes?: { token_prices?: Record<string, string> } };
    };
    return j?.data?.attributes?.token_prices ?? {};
  }) as Promise<unknown>);
  return typeof body === "object" && body !== null ? (body as Record<string, string>) : {};
}

// --- Historical daily price (issue #640) -------------------------------------
// GeckoTerminal daily OHLCV for a pool — the SAME vendor and host as the spot
// read above, a different endpoint:
//   GET /networks/base/pools/{pool}/ohlcv/day
//         ?before_timestamp={ts}&limit=1&token={token}&currency=usd
//   → { data: { attributes: { ohlcv_list: [[bucketTs, open, high, low, close, volume]] } },
//       meta: { base: { symbol, address }, quote: { symbol, address } } }
//
// Returns the CLOSE, in USD, of the UTC day containing `atUnixSeconds` — for the
// token NAMED in the request. Why the close and not the open/mid: it is the
// day's settled price, the same convention the rest of this repo's daily series
// use, and a daily candle cannot be finer than the day anyway — the buyback
// swaps this prices sit inside a single candle's range (the 2026-03-23 bucket
// 1774224000 spans 2026.51–2188.00 and the seeded rows imply ~2179.3). It is a
// bounded, disclosed approximation of a historical fact, which is categorically
// different from stamping TODAY's spot on a months-old swap — see indexBuybacks.
//
// A pool holds two tokens and its candles denominate exactly ONE of them, so the
// request has to say which. Absent `token=`, the endpoint answers for the pool's
// BASE side; this read returned WETH prices anyway because its only caller pins
// a pool whose base side happens to be WETH. That was a property of one
// hardcoded address, not of this code — re-point that constant at a pool holding
// WETH as the QUOTE side and every buyback quietly becomes denominated in the
// other token, at the other token's magnitude. Naming the token makes the
// request say what it wants, and `meta.base` — which follows `token=` — is read
// back so the ANSWER is checked too, in-band, with no second request and no
// second vendor. The orientation is now asserted rather than assumed.
//
// `before_timestamp` is normalized to the END of that UTC day so every swap in a
// day produces ONE url: the url is both the withFetchCache key and the in-memory
// memo key, so a catch-up scan that finds twenty swaps across three days costs
// three upstream candles, not twenty. `token` sits inside that url too, which
// leaves the scan's dedupe exactly as it was (one token throughout a scan) while
// making it impossible for two tokens read from the same pool to share a key and
// hand one the other's series. Throws when no candle covers the day, and when
// the candles are not this token's, so the caller records an honest NULL rather
// than substituting a price it cannot stand behind.
const DAY_SECONDS = 86_400;
const geckoDailyCloseCache = new Map<string, Promise<number>>();

// Refuse a response that priced the other half of the pair.
//
// The failure this closes is silent by nature: the other side's candle is
// finite, plausible, and (cbBTC against WETH) ~25× too large, indistinguishable
// downstream from a real price and stored as a durable USD figure. A body with
// no `meta.base` at all is refused for the same reason — an unattributed candle
// cannot be shown to be this token's, and "shown" is the whole point of asking.
// The message carries both addresses because the caller's warning line is the
// only thing an operator sees, and a systematic mis-orientation must not read
// like a pool with a thin day.
function assertCandleToken(
  pool: string,
  token: string,
  body: { meta?: { base?: { address?: unknown; symbol?: unknown } } },
): void {
  const base = body?.meta?.base;
  const address = typeof base?.address === "string" ? base.address.toLowerCase() : null;
  if (address === null) {
    throw new Error(
      `geckoterminal: pool ${pool} answered for token ${token} with no meta.base.address — which side of the pair this candle prices cannot be established, so it is not used as a price`,
    );
  }
  if (address !== token) {
    const symbol = typeof base?.symbol === "string" ? base.symbol : "?";
    throw new Error(
      `geckoterminal: pool ${pool} was asked for token ${token} and priced ${symbol} ${address} instead — this candle is the OTHER side of the pair, not this token's price`,
    );
  }
}

export async function fetchGeckoDailyCloseUsd(
  pool: string,
  tokenAddress: string,
  atUnixSeconds: number,
  timeoutMs = 8000,
): Promise<number> {
  // Required, not defaulted: a caller that cannot name the token it wants
  // cannot ask this endpoint an unambiguous question, and the compiler is the
  // cheapest place to say so.
  const token = tokenAddress.toLowerCase();
  const dayStart = Math.floor(atUnixSeconds / DAY_SECONDS) * DAY_SECONDS;
  const url =
    `${GECKOTERMINAL_BASE}/networks/base/pools/${pool.toLowerCase()}/ohlcv/day` +
    `?before_timestamp=${dayStart + DAY_SECONDS - 1}&limit=1&token=${token}&currency=usd`;
  const memo = geckoDailyCloseCache.get(url);
  if (memo) return memo;

  const request = (async () => {
    const body = await (withFetchCache("json", url, async () => {
      const j = (await geckoFetchJson(url, timeoutMs, `ohlcv for ${pool}@${dayStart}`)) as {
        data?: { attributes?: { ohlcv_list?: unknown[][] } };
        meta?: { base?: { address?: unknown; symbol?: unknown } };
      };
      // Checked HERE, inside the fetcher, so what the cache holds stays the
      // bare candle list it has always been — no envelope shape change, and
      // therefore no stale-shape hazard on disk. A body only reaches the cache
      // after it has proved which token it prices, so a later hit is serving
      // an already-attested candle rather than skipping the check.
      assertCandleToken(pool, token, j);
      return j?.data?.attributes?.ohlcv_list ?? [];
    }) as Promise<unknown>);
    const candle = Array.isArray(body) ? (body[0] as unknown[] | undefined) : undefined;
    const bucket = Number(candle?.[0]);
    const close = Number(candle?.[4]);
    // The bucket must be the requested day: `before_timestamp` returns the
    // most recent candle at or before it, so a pool with a gap would silently
    // hand back an OLDER day's price for this swap.
    if (bucket !== dayStart || !Number.isFinite(close) || close <= 0) {
      throw new Error(`geckoterminal: no daily candle for ${pool} at ${new Date(dayStart * 1000).toISOString().slice(0, 10)}`);
    }
    return close;
  })();

  // A settled day's candle never changes, so it is memoized for the life of the
  // process; TODAY's candle is still forming and is deliberately not memoized.
  if (dayStart < Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS) {
    geckoDailyCloseCache.set(url, request);
    request.catch(() => geckoDailyCloseCache.delete(url)); // never memoize a failure
  }
  return request;
}

// Join (or open) the batch that is currently accepting addresses. The opener
// also starts the runner; joiners just register a waiter and share its request.
function joinGeckoBatch(lc: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (geckoOpenBatch) {
      geckoOpenBatch.waiters.set(lc, { resolve, reject });
      geckoOpenBatch.timeoutMs = Math.max(geckoOpenBatch.timeoutMs, timeoutMs);
      return;
    }
    const batch: GeckoBatch = { waiters: new Map([[lc, { resolve, reject }]]), timeoutMs };
    geckoOpenBatch = batch;
    void runGeckoBatch(batch);
  });
}

// Gate-holder for one batch: fetch every joined address in ONE request and
// settle each waiter individually. Failure semantics preserve the pre-batch
// per-leg degrade contract (#50 honesty) EXACTLY:
//   - an address missing (or non-numeric) in a SUCCESSFUL response rejects
//     ONLY that address ("no USD price") — the caller marks that single leg
//     stale while the batch's other legs resolve and stay live;
//   - a FAILED request (hard status / retries exhausted / timeout) rejects
//     every address in the batch, equivalent to the old individual failures.
async function runGeckoBatch(batch: GeckoBatch): Promise<void> {
  await batchChain; // wait for previous batch — keeps this batch open for joiners
  let release!: () => void;
  batchChain = new Promise<void>((r) => { release = r; });
  if (geckoOpenBatch === batch) geckoOpenBatch = null; // close: the address set is final
  const addresses = [...batch.waiters.keys()].sort(); // stable URL/cache key (see fetcher note)
  try {
    const prices = await fetchGeckoTokenPricesUsdUncached(addresses, batch.timeoutMs);
    const at = Date.now();
    for (const [lc, waiter] of batch.waiters) {
      const n = prices[lc] == null ? NaN : Number(prices[lc]);
      if (Number.isFinite(n)) {
        geckoPriceCache.set(lc, n, at);
        waiter.resolve(n);
      } else {
        waiter.reject(new Error(`geckoterminal: no USD price for ${lc}`));
      }
    }
  } catch (err) {
    for (const waiter of batch.waiters.values()) waiter.reject(err);
  } finally {
    release();
  }
}

// Public API — unchanged signature: callers still price one address at a time
// and degrade one leg at a time; the coalescing into a shared batched request
// is transparent. Cache-hit and same-address dedup short-circuits never touch
// the serializer, exactly as before.
export async function fetchGeckoTokenPriceUsd(address: string, timeoutMs = 8000): Promise<number> {
  const lc = address.toLowerCase();
  const cached = geckoPriceCache.get(lc);
  if (cached !== undefined) return cached;
  const pending = geckoPending.get(lc);
  if (pending) return pending;

  const request = joinGeckoBatch(lc, timeoutMs);
  geckoPending.set(lc, request);
  try {
    return await request;
  } finally {
    geckoPending.delete(lc);
  }
}

// Latest Yahoo close for the SP500 ticker (reuses analytics/extract/yahoo.ts).
export async function fetchSp500PriceUsd(ticker: string, timeoutMs = 15000): Promise<number> {
  const points = await fetchYahoo(ticker, 0, Math.floor(Date.now() / 1000), timeoutMs);
  const last = points[points.length - 1];
  if (!last || !Number.isFinite(last.value)) throw new Error(`yahoo: no SP500 close for ${ticker}`);
  return last.value;
}

// Resolve one asset's USD unit price under the active price source. Throws on a
// live-fetch failure so the CALLER degrades that single leg to its last
// persisted sample marked 'stale' — never a fabricated or falsely-live number.
export async function fetchAssetPriceUsd(
  asset: TrackedAsset,
  source: PriceSource,
): Promise<number> {
  if (asset.priceKind === "usdc") return 1; // USDC / strategy-underlying pinned $1

  if (source === "stub") {
    const p = STUB_PRICES[asset.symbol];
    if (p === undefined) throw new Error(`token-prices stub: no fixture price for ${asset.symbol}`);
    return p;
  }

  if (asset.priceKind === "yahoo") {
    return fetchSp500PriceUsd(SP500_TICKER);
  }
  // gecko: native ETH is priced off WETH's address (canonical wrapped price).
  if (!asset.address) throw new Error(`token-prices: ${asset.symbol} has no address for a gecko price read`);
  return fetchGeckoTokenPriceUsd(asset.address);
}

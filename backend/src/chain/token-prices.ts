// Keyless USD spot prices for the prop-wallet valuation feed (issue #84).
//
// HARD CONSTRAINT (AC — no new vendor/key): this file reaches ONLY the
// GeckoTerminal (crypto) and Yahoo (SP500) hosts — the same vendors already in
// the repo — plus a deterministic hermetic stub. No Alchemy/DexScreener/
// CoinGecko/Dune/Supabase host or import. New GeckoTerminal-*endpoint* code is
// allowed (same vendor): analytics/extract/geckoterminal.ts today only counts
// new pools, so the token_price read below is genuinely new fetcher code.
//
// Prices are SPOT only. Historical valuation for /performance comes from the
// persisted wallet_balance_samples series (seeded once from the baked views.js
// data, then accumulated forward by the daily sampler — see migration 0014 +
// worker/handlers/wallet.ts), NOT from a re-fetched OHLCV series, which resolves
// Open Question 9 (GeckoTerminal OHLCV may not reach back to Mar 18 for illiquid
// ROBOTMONEY/BNKR): the seeded rows ARE the carried-forward history.
import type { PriceSource, TrackedAsset } from "../config.ts";
import { resolveSp500 } from "../config.ts";
import { UA } from "../analytics/extract/http.ts";
import { withFetchCache } from "../analytics/extract/fetch-cache.ts";
import { fetchYahoo } from "../analytics/extract/yahoo.ts";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// In-memory spot-price reuse windows. Both values are SOURCE CONSTANTS on
// purpose (user decision 2026-07-21: no per-property env knobs) — the only
// runtime signal is the stack-level DEMO_MODE flag the demo compose pins.
//   - 30s (production/default): short enough that the 1-minute sampler cron
//     never persists the same spot twice in a row as if it were fresh.
//   - 1h (demo): the standing demo shares its host/IP with the self-hosted CI
//     runner and GeckoTerminal's keyless quota is metered PER IP, so the
//     demo's 1-minute sampler was starving CI e2e of quota (the 429-exhaustion
//     symptom tracked in #202). Hourly demo spot prices are an accepted
//     tradeoff (user decision 2026-07-21) to keep that quota available to CI.
const GECKO_PRICE_CACHE_TTL_MS = 30_000;
const GECKO_PRICE_CACHE_TTL_DEMO_MS = 3_600_000;

// Resolved at CALL time (not module load) — the same truthiness read
// db/seed.ts applies to its fast-schedule flag — so tests can flip DEMO_MODE
// per case and the container env applies without an import-order footgun.
function geckoPriceCacheTtlMs(): number {
  return process.env.DEMO_MODE ? GECKO_PRICE_CACHE_TTL_DEMO_MS : GECKO_PRICE_CACHE_TTL_MS;
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
// Promise.all fan-out over legs, or callers queued behind the in-flight slot —
// coalesces into ONE comma-separated token_price request. A sampler run that
// values WETH/ROBOTMONEY/BNKR therefore costs 1 upstream call, not 3 (the
// demo/CI quota-exhaustion fix; symptom tracked in #202).
let geckoInFlight = false;
const geckoWaiters: Array<() => void> = [];
const geckoPending = new Map<string, Promise<number>>();
const geckoPriceCache = new Map<string, { at: number; value: number }>();

// The batch currently accepting joiners (null when none). It stays open until
// its runner actually HOLDS the serializer slot (>= 1 microtask even when the
// slot is free), then closes so its address set — and therefore its URL, which
// doubles as the withFetchCache key — is final before the fetch goes out.
// Per-address uniqueness inside `waiters` is guaranteed by the geckoPending
// gate: a second same-address caller never opens or joins a batch while the
// first is outstanding. `timeoutMs` is the max over joiners so one shared
// request never cuts an individual caller's budget short.
interface GeckoBatch {
  waiters: Map<string, { resolve: (price: number) => void; reject: (err: unknown) => void }>;
  timeoutMs: number;
}
let geckoOpenBatch: GeckoBatch | null = null;

async function acquireGeckoSlot(): Promise<void> {
  if (!geckoInFlight) {
    geckoInFlight = true;
    return;
  }
  await new Promise<void>((resolve) => geckoWaiters.push(resolve));
}

function releaseGeckoSlot(): void {
  const next = geckoWaiters.shift();
  if (next) next();
  else geckoInFlight = false;
}

function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  return geckoRetryBaseMs() * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-only cache/gate hygiene. Production callers never reset live prices.
export function _resetTokenPriceCacheForTests(): void {
  geckoInFlight = false;
  geckoWaiters.length = 0;
  geckoPending.clear();
  geckoPriceCache.clear();
  geckoOpenBatch = null;
}

// Deterministic hermetic fixtures (PRICE_SOURCE=stub). Recognizable, stable
// magnitudes so the demo's rendered totals are reproducible without touching a
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
async function fetchGeckoTokenPricesUsdUncached(addresses: string[], timeoutMs: number): Promise<Record<string, string>> {
  const url = `${GECKOTERMINAL_BASE}/simple/networks/base/token_price/${addresses.join(",")}`;
  const deadline = Date.now() + timeoutMs;
  const body = await (withFetchCache("json", url, async () => {
    const retries = geckoMaxRetries();
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`geckoterminal: price timeout for ${addresses.join(",")}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(remaining),
        headers: { "user-agent": UA, accept: "application/json" },
      });
      if (res.ok) {
        const j = (await res.json()) as {
          data?: { attributes?: { token_prices?: Record<string, string> } };
        };
        return j?.data?.attributes?.token_prices ?? {};
      }
      if (!GECKO_TRANSIENT_STATUSES.has(res.status) || attempt >= retries) {
        throw new Error(`${res.status} ${res.statusText} for ${url}`);
      }
      const wait = retryAfterMs(res.headers.get("retry-after"), attempt + 1);
      if (wait >= deadline - Date.now()) {
        throw new Error(`geckoterminal: price retry budget exhausted after HTTP ${res.status} for ${addresses.join(",")}`);
      }
      await sleep(wait);
    }
  }) as Promise<unknown>);
  return typeof body === "object" && body !== null ? (body as Record<string, string>) : {};
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

// Slot-holder for one batch: fetch every joined address in ONE request and
// settle each waiter individually. Failure semantics preserve the pre-batch
// per-leg degrade contract (#50 honesty) EXACTLY:
//   - an address missing (or non-numeric) in a SUCCESSFUL response rejects
//     ONLY that address ("no USD price") — the caller marks that single leg
//     stale while the batch's other legs resolve and stay live;
//   - a FAILED request (hard status / retries exhausted / timeout) rejects
//     every address in the batch, equivalent to the old individual failures.
async function runGeckoBatch(batch: GeckoBatch): Promise<void> {
  await acquireGeckoSlot();
  if (geckoOpenBatch === batch) geckoOpenBatch = null; // close: the address set is final
  const addresses = [...batch.waiters.keys()].sort(); // stable URL/cache key (see fetcher note)
  try {
    const prices = await fetchGeckoTokenPricesUsdUncached(addresses, batch.timeoutMs);
    const at = Date.now();
    for (const [lc, waiter] of batch.waiters) {
      const n = prices[lc] == null ? NaN : Number(prices[lc]);
      if (Number.isFinite(n)) {
        geckoPriceCache.set(lc, { at, value: n });
        waiter.resolve(n);
      } else {
        waiter.reject(new Error(`geckoterminal: no USD price for ${lc}`));
      }
    }
  } catch (err) {
    for (const waiter of batch.waiters.values()) waiter.reject(err);
  } finally {
    releaseGeckoSlot();
  }
}

// Public API — unchanged signature: callers still price one address at a time
// and degrade one leg at a time; the coalescing into a shared batched request
// is transparent. Cache-hit and same-address dedup short-circuits never touch
// the serializer, exactly as before.
export async function fetchGeckoTokenPriceUsd(address: string, timeoutMs = 8000): Promise<number> {
  const lc = address.toLowerCase();
  const cached = geckoPriceCache.get(lc);
  if (cached && Date.now() - cached.at < geckoPriceCacheTtlMs()) return cached.value;
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
    return fetchSp500PriceUsd(resolveSp500().ticker);
  }
  // gecko: native ETH is priced off WETH's address (canonical wrapped price).
  if (!asset.address) throw new Error(`token-prices: ${asset.symbol} has no address for a gecko price read`);
  return fetchGeckoTokenPriceUsd(asset.address);
}

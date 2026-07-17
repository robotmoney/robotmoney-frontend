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
const GECKO_PRICE_CACHE_TTL_MS = 30_000;

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

// The keyless endpoint rate-limits short concurrent bursts. Serialize unique
// token reads and deduplicate same-address calls (WETH + native ETH share the
// WETH price) so one sleeve request does not create its own price-fetch storm.
let geckoInFlight = false;
const geckoWaiters: Array<() => void> = [];
const geckoPending = new Map<string, Promise<number>>();
const geckoPriceCache = new Map<string, { at: number; value: number }>();

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

// GeckoTerminal simple token_price (keyless): one Base token address → USD.
//   GET /simple/networks/base/token_price/{address}
//   → { data: { attributes: { token_prices: { "0xaddr": "1234.5" } } } }
async function fetchGeckoTokenPriceUsdUncached(lc: string, timeoutMs: number): Promise<number> {
  const url = `${GECKOTERMINAL_BASE}/simple/networks/base/token_price/${lc}`;
  const deadline = Date.now() + timeoutMs;
  return withFetchCache("json", url, async () => {
    const retries = geckoMaxRetries();
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`geckoterminal: price timeout for ${lc}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(remaining),
        headers: { "user-agent": UA, accept: "application/json" },
      });
      if (res.ok) {
        const j = (await res.json()) as {
          data?: { attributes?: { token_prices?: Record<string, string> } };
        };
        const raw = j?.data?.attributes?.token_prices?.[lc];
        const n = raw == null ? NaN : Number(raw);
        if (!Number.isFinite(n)) throw new Error(`geckoterminal: no USD price for ${lc}`);
        return n;
      }
      if (!GECKO_TRANSIENT_STATUSES.has(res.status) || attempt >= retries) {
        throw new Error(`${res.status} ${res.statusText} for ${url}`);
      }
      const wait = retryAfterMs(res.headers.get("retry-after"), attempt + 1);
      if (wait >= deadline - Date.now()) {
        throw new Error(`geckoterminal: price retry budget exhausted after HTTP ${res.status} for ${lc}`);
      }
      await sleep(wait);
    }
  }) as Promise<number>;
}

export async function fetchGeckoTokenPriceUsd(address: string, timeoutMs = 8000): Promise<number> {
  const lc = address.toLowerCase();
  const cached = geckoPriceCache.get(lc);
  if (cached && Date.now() - cached.at < GECKO_PRICE_CACHE_TTL_MS) return cached.value;
  const pending = geckoPending.get(lc);
  if (pending) return pending;

  const request = (async () => {
    await acquireGeckoSlot();
    try {
      const value = await fetchGeckoTokenPriceUsdUncached(lc, timeoutMs);
      geckoPriceCache.set(lc, { at: Date.now(), value });
      return value;
    } finally {
      releaseGeckoSlot();
    }
  })();
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

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
import { fetchJson } from "../analytics/extract/http.ts";
import { fetchYahoo } from "../analytics/extract/yahoo.ts";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";

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
export async function fetchGeckoTokenPriceUsd(address: string, timeoutMs = 8000): Promise<number> {
  const lc = address.toLowerCase();
  const url = `${GECKOTERMINAL_BASE}/simple/networks/base/token_price/${lc}`;
  const j = (await fetchJson(url, timeoutMs)) as {
    data?: { attributes?: { token_prices?: Record<string, string> } };
  };
  const prices = j?.data?.attributes?.token_prices;
  const raw = prices?.[lc];
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`geckoterminal: no USD price for ${lc}`);
  return n;
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

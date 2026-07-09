// Vendored, deterministic projects pipeline dataset (issue #87). This is the
// ground-truth INPUT the hermetic fixture data source (access/fixture-source.ts)
// serves and the fidelity suite replays. Every payload is shaped exactly like the
// real provider response the legacy edge function parsed (CoinGecko
// /coins/markets rows, DexScreener /tokens pairs, an ERC-4626 chain read, a
// wallet USD balance), so replaying it through projects/transforms.ts reproduces
// the vendored legacy output in fixtures/ground-truth.ts byte-for-byte.
//
// Addresses/ids are synthetic but internally consistent: the discovery records
// reference coingecko_id / contract_address / virtuals_agent_id / vault_address /
// wallet address keys that resolve in the provider maps below.
import type { DiscoveredProject } from "../access/data-source.ts";
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";

// ── Discovery bucket ─────────────────────────────────────────────────────────
export const DISCOVERY_DATASET: DiscoveredProject[] = [
  {
    slug: "virtuals-protocol",
    display_name: "Virtuals Protocol",
    description: "Agent launchpad and co-ownership layer on Base (G.A.M.E. orchestration).",
    website_url: "https://virtuals.io/",
    twitter_handle: "@virtuals_io",
    logo_url: "https://cdn.example/virtuals.png",
    is_sticky: true,
    agents: [
      {
        name: "G.A.M.E. Protocol Agent",
        protocol_standard: "virtuals",
        virtuals_agent_id: "0xvirt00000000000000000000000000000000game",
        productivity_score: 88,
        source_confidence: "high",
      },
    ],
    coins: [
      { name: "Virtuals Protocol", ticker: "VIRTUAL", coingecko_id: "virtual-protocol", chain: "base" },
      { name: "G.A.M.E. by Virtuals", ticker: "GAME", contract_address: "0xgame00000000000000000000000000000000coin", chain: "base" },
    ],
    wallets: [{ label: "Virtuals DAO Treasury", chain: "base", address: "0xwallet0000000000000000000000000000000aaa" }],
    vaults: [
      {
        name: "Virtuals Creator Vault",
        vault_address: "0xvault0000000000000000000000000000000aaa",
        chain: "base",
        strategy_type: "erc4626",
        protocol: "morpho",
        data_source: "live",
      },
    ],
  },
  {
    slug: "aixbt",
    display_name: "aixbt",
    description: "AI market-intelligence agent on Virtuals.",
    website_url: "https://aixbt.tech/",
    twitter_handle: "@aixbt_agent",
    logo_url: "https://cdn.example/aixbt.png",
    is_sticky: true,
    agents: [
      {
        name: "aixbt",
        protocol_standard: "virtuals",
        virtuals_agent_id: "0xaixbt0000000000000000000000000000000tok",
        productivity_score: 80,
        source_confidence: "high",
      },
    ],
    coins: [{ name: "aixbt", ticker: "AIXBT", coingecko_id: "aixbt", chain: "base" }],
    wallets: [{ label: "aixbt Agent Wallet", chain: "base", address: "0xwallet0000000000000000000000000000000bbb" }],
    vaults: [],
  },
  {
    slug: "coinbase-x402-facilitator",
    display_name: "Coinbase x402 Facilitator",
    description: "High-volume x402 payment facilitator on Base.",
    website_url: "https://www.x402.org/",
    twitter_handle: "@coinbase",
    logo_url: "https://cdn.example/x402.png",
    is_sticky: false,
    agents: [
      {
        name: "Coinbase x402 Facilitator",
        protocol_standard: "x402",
        x402_score: 98,
        x402_txn_count: 128_400,
        x402_resources_count: 42,
        x402_volume_usd: 15_000,
        productivity_score: 72,
        source_confidence: "high",
      },
    ],
    coins: [],
    wallets: [{ label: "Coinbase x402 Facilitator Wallet", chain: "base", address: "0xwallet0000000000000000000000000000000ccc" }],
    vaults: [],
  },
];

// ── Market bucket: CoinGecko /coins/markets rows, keyed by coingecko_id ───────
export const COINGECKO_MARKETS: Record<string, CoinGeckoMarketRow> = {
  "virtual-protocol": {
    id: "virtual-protocol",
    current_price: 1.5,
    market_cap: 1_500_000_000,
    fully_diluted_valuation: 2_000_000_000,
    total_volume: 50_000_000,
    price_change_percentage_24h: 5.2,
  },
  // fully_diluted_valuation absent → fdv falls back to market_cap.
  aixbt: {
    id: "aixbt",
    current_price: 0.32,
    market_cap: 320_000_000,
    fully_diluted_valuation: null,
    total_volume: 10_000_000,
    price_change_percentage_24h: -3.1,
  },
};

// ── Market/revenue bucket: DexScreener /tokens payloads, keyed by address ─────
export const DEXSCREENER_TOKENS: Record<string, DexPayload> = {
  // GAME on-chain coin: base base-token pair wins over a quote-side decoy and a
  // wrong-chain pair.
  "0xgame00000000000000000000000000000000coin": {
    pairs: [
      {
        chainId: "base",
        baseToken: { address: "0xgame00000000000000000000000000000000coin" },
        liquidity: { usd: 500_000 },
        priceUsd: "0.045",
        marketCap: 90_000_000,
        fdv: 120_000_000,
        volume: { h24: 2_000_000 },
        priceChange: { h24: -1.4 },
      },
      {
        // decoy: high liquidity but GAME is the QUOTE token here → must be ignored.
        chainId: "base",
        baseToken: { address: "0xdecoy0000000000000000000000000000000000" },
        liquidity: { usd: 9_999_999 },
        priceUsd: "1.23",
        marketCap: 1,
        fdv: 1,
        volume: { h24: 1 },
        priceChange: { h24: 0 },
      },
      {
        // wrong chain → deprioritized behind the base pair.
        chainId: "ethereum",
        baseToken: { address: "0xgame00000000000000000000000000000000coin" },
        liquidity: { usd: 100_000 },
        priceUsd: "0.05",
        marketCap: 80_000_000,
        fdv: 110_000_000,
        volume: { h24: 900_000 },
        priceChange: { h24: 2.0 },
      },
    ],
  },
  // Virtuals revenue token for the G.A.M.E. agent: highest-liquidity base pair
  // sets the 24h volume.
  "0xvirt00000000000000000000000000000000game": {
    pairs: [
      { chainId: "base", liquidity: { usd: 3_000_000 }, volume: { h24: 10_000_000 } },
      { chainId: "base", liquidity: { usd: 1_000_000 }, volume: { h24: 99_999_999 } },
      { chainId: "ethereum", liquidity: { usd: 5_000_000 }, volume: { h24: 88_888_888 } },
    ],
  },
  // Virtuals revenue token for the aixbt agent.
  "0xaixbt0000000000000000000000000000000tok": {
    pairs: [{ chainId: "base", liquidity: { usd: 2_000_000 }, volume: { h24: 5_000_000 } }],
  },
};

// ── Vault bucket: ERC-4626 reads keyed by vault_address ──────────────────────
export const VAULT_READS: Record<string, { totalAssetsRaw: string; decimals: number; assetPriceUsd: number }> = {
  // 1e12 raw / 1e6 (USDC decimals) = 1,000,000 units × $1 = $1,000,000 TVL.
  "0xvault0000000000000000000000000000000aaa": { totalAssetsRaw: "1000000000000", decimals: 6, assetPriceUsd: 1 },
};

// ── Wallet bucket: USD balances keyed by address ─────────────────────────────
export const WALLET_BALANCES: Record<string, number> = {
  "0xwallet0000000000000000000000000000000aaa": 4_200_000,
  "0xwallet0000000000000000000000000000000bbb": 980_000,
  "0xwallet0000000000000000000000000000000ccc": 3_100_000,
};

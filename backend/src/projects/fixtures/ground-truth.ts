// Vendored legacy ground truth (issue #87). These are the EXACT outputs the
// deprecated bot-analytics edge functions computed for the fixtures/dataset.ts
// inputs, hand-derived from the legacy formulas (arithmetic shown per entry) and
// pinned as literals so the fidelity suite proves the port reproduces them — it
// asserts our transform === this literal, never our transform === our transform.
import type { AgentSnapshot, CoinMarketFields, CoverageInputs, CoverageScores, RevenueRow } from "../transforms.ts";

// ── Market: coinGeckoFields per coingecko_id ─────────────────────────────────
export const COINGECKO_GROUND_TRUTH: Record<string, CoinMarketFields> = {
  "virtual-protocol": { price_usd: 1.5, market_cap: 1_500_000_000, fdv: 2_000_000_000, volume_24h: 50_000_000, percent_change_24h: 5.2 },
  // fdv missing upstream → falls back to market_cap (320M).
  aixbt: { price_usd: 0.32, market_cap: 320_000_000, fdv: 320_000_000, volume_24h: 10_000_000, percent_change_24h: -3.1 },
};

// ── Market: dexScreenerBest for the GAME on-chain coin ───────────────────────
// baseToken-filtered, base-chain, highest-liquidity ($500k) pair — the $9.99M
// quote-side decoy and the ethereum pair are correctly rejected.
export const DEX_GAME_GROUND_TRUTH: CoinMarketFields = {
  price_usd: 0.045,
  market_cap: 90_000_000,
  fdv: 120_000_000,
  volume_24h: 2_000_000,
  percent_change_24h: -1.4,
};

// ── Revenue: virtualsRevenueRow (vol24 × 0.006) ──────────────────────────────
// GAME agent: highest-liquidity base pair vol24 = 10,000,000 → 10,000,000×0.006 = 60,000.
export const VIRTUALS_REVENUE_GROUND_TRUTH: Record<string, number> = {
  "0xvirt00000000000000000000000000000000game": 60_000, // 10,000,000 × 0.006
  "0xaixbt0000000000000000000000000000000tok": 30_000, // 5,000,000 × 0.006
};

// ── Revenue: x402 rollup input + expected rows ───────────────────────────────
export const X402_SNAPSHOTS: AgentSnapshot[] = [
  { agent_id: "agent-1", snapshot_date: "2026-07-01", x402_volume_usd: 1_000 },
  { agent_id: "agent-1", snapshot_date: "2026-07-02", x402_volume_usd: 0 }, // dropped (not > 0)
  { agent_id: "agent-1", snapshot_date: "2026-07-03", x402_volume_usd: 2_500 },
  { agent_id: "agent-2", snapshot_date: "2026-07-03", x402_volume_usd: null }, // dropped (null)
];
export const X402_ROWS_GROUND_TRUTH: RevenueRow[] = [
  { agent_id: "agent-1", revenue_date: "2026-07-01", revenue_usd: 1_000, source: "x402" },
  { agent_id: "agent-1", revenue_date: "2026-07-03", revenue_usd: 2_500, source: "x402" },
];

// ── Revenue: trailing-30d sum ────────────────────────────────────────────────
export const TRAILING_ROWS = [
  { revenue_date: "2026-07-15", revenue_usd: 100 },
  { revenue_date: "2026-07-01", revenue_usd: 250 },
  { revenue_date: "2026-06-15", revenue_usd: 9_999 }, // > 30d before asof → excluded
];
export const TRAILING_ASOF = "2026-07-30"; // cutoff 2026-06-30
export const TRAILING_SUM_GROUND_TRUTH = 350; // 100 + 250

// ── Vault: ERC-4626 TVL per vault_address ────────────────────────────────────
export const VAULT_TVL_GROUND_TRUTH: Record<string, number> = {
  "0xvault0000000000000000000000000000000aaa": 1_000_000, // 1e12/1e6 × $1
};
// A decimals-18 / non-stable case proving the scaling generalises.
export const VAULT_TVL_18DEC = { input: { totalAssetsRaw: "5000000000000000000", decimals: 18, assetPriceUsd: 2 }, expected: 10 }; // 5 × $2

// ── Coverage: compute_project_coverage parity cases ──────────────────────────
// Full-facet agent project. breadth 100, identity 100, onchain trunc(270/3)=90,
// activity min(100,100)=100 → round(390/4)=98.
export const COVERAGE_FULL: { input: CoverageInputs; expected: CoverageScores } = {
  input: {
    project: {
      has_agent: true,
      has_coin: true,
      has_wallet: true,
      has_vault: true,
      logo_url: "x",
      description: "x",
      twitter_handle: "@x",
      website_url: "https://x/",
      display_name: "Virtuals Protocol",
      slug: "virtuals-protocol",
      resolved_at: "2026-07-01T00:00:00Z",
    },
    agent: { productivityPositive: true, revenueSignal: true, confidence: "high", enriched: true },
    coin: { pricePositive: true, mcapPositive: true, hasContract: true, hasCoingecko: true },
    wallet: { balancePositive: true, recentTx: true },
    vault: { tvlPositive: true, hasApy: false, hasAddress: true }, // no APY → vault sub-score 70
    history: { agent7: true, coin7: true, wallet7: true },
  },
  expected: { breadth: 100, identity: 100, onchain: 90, activity: 100, score: 98 },
};

// Coin-only, no agent, sparse identity → exercises the non-agent activity branch.
// breadth 25, identity 20, onchain 50, activity 0 → round(95/4)=24.
export const COVERAGE_SPARSE: { input: CoverageInputs; expected: CoverageScores } = {
  input: {
    project: {
      has_agent: false,
      has_coin: true,
      has_wallet: false,
      has_vault: false,
      logo_url: null,
      description: "x",
      twitter_handle: null,
      website_url: null,
      display_name: "sparse-co",
      slug: "sparse-co", // display_name === slug → 0 identity points for the name
      resolved_at: null,
    },
    agent: { productivityPositive: false, revenueSignal: false, confidence: null, enriched: false },
    coin: { pricePositive: true, mcapPositive: false, hasContract: true, hasCoingecko: false },
    wallet: { balancePositive: false, recentTx: false },
    vault: { tvlPositive: false, hasApy: false, hasAddress: false },
    history: { agent7: false, coin7: false, wallet7: false },
  },
  expected: { breadth: 25, identity: 20, onchain: 50, activity: 0, score: 24 },
};

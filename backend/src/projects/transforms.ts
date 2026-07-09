// Pure, deterministic pipeline transforms ported 1:1 from the deprecated
// robotmoney-bot-analytics Supabase edge functions (issue #87). Every function
// here takes vendored provider-shaped input and returns exactly what the legacy
// transform computed — no DB, no network, no clock — so the fidelity suite
// (tests/projects-pipelines-fidelity.test.ts) can replay vendored provider
// payloads and assert byte-exact equality with vendored legacy ground truth (the
// PR #9 methodology). The worker handlers (worker/handlers/projects.ts) are thin
// I/O shells that pull a payload from the data source, call these, and upsert.

// ── Market refresh ───────────────────────────────────────────────────────────
// refresh-lobster-coins/index.ts. CoinGecko /coins/markets row → coin columns.
export interface CoinMarketFields {
  price_usd: number;
  market_cap: number;
  fdv: number;
  volume_24h: number;
  percent_change_24h: number;
}

export interface CoinGeckoMarketRow {
  id: string;
  current_price?: number | null;
  market_cap?: number | null;
  fully_diluted_valuation?: number | null;
  total_volume?: number | null;
  price_change_percentage_24h?: number | null;
}

// Legacy refreshCoinGecko(): fdv falls back to market_cap; every field 0-defaults.
export function coinGeckoFields(r: CoinGeckoMarketRow): CoinMarketFields {
  return {
    price_usd: r.current_price ?? 0,
    market_cap: r.market_cap ?? 0,
    fdv: r.fully_diluted_valuation ?? r.market_cap ?? 0,
    volume_24h: r.total_volume ?? 0,
    percent_change_24h: r.price_change_percentage_24h ?? 0,
  };
}

export const MIN_LIQUIDITY_USD = 1_000;

export interface DexPair {
  chainId?: string;
  baseToken?: { address?: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  url?: string;
}
export interface DexPayload {
  pairs?: DexPair[] | null;
}

export type DexResult =
  | { status: "failed" }
  | { status: "skipped" }
  | { status: "ok"; values: CoinMarketFields };

// Legacy refreshDexOne(): pick the highest-liquidity pair where THIS token is the
// base token (never the quote token — a quote-side pair describes the other
// asset), preferring the coin's chain, and skip pairs under the liquidity floor.
export function dexScreenerBest(
  payload: DexPayload,
  coin: { contract_address: string; chain?: string | null },
): DexResult {
  const pairs = payload.pairs ?? [];
  const tokenAddr = (coin.contract_address || "").toLowerCase();
  const chain = coin.chain || "base";
  const baseOnly = pairs.filter((p) => (p?.baseToken?.address || "").toLowerCase() === tokenAddr);
  const chainPairs = baseOnly.filter((p) => p.chainId === chain);
  const sorted = (chainPairs.length ? chainPairs : baseOnly).sort(
    (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
  );
  const best = sorted[0];
  if (!best) return { status: "failed" };
  const liq = best.liquidity?.usd || 0;
  if (liq < MIN_LIQUIDITY_USD) return { status: "skipped" };
  return {
    status: "ok",
    values: {
      price_usd: best.priceUsd ? parseFloat(best.priceUsd) : 0,
      market_cap: best.marketCap || best.fdv || 0,
      fdv: best.fdv || best.marketCap || 0,
      volume_24h: best.volume?.h24 || 0,
      percent_change_24h: best.priceChange?.h24 ?? 0,
    },
  };
}

// Directory aggregation the projection applies over a project's coins.
export function maxAcross<T>(rows: T[], pick: (r: T) => number | null | undefined): number {
  return Math.max(0, ...rows.map((r) => pick(r) ?? 0));
}

// ── Revenue sync ─────────────────────────────────────────────────────────────
// sync-agent-revenue-virtuals/index.ts. Virtuals 1%/swap tax, ~30% to the agent:
// effective agent share of round-trip volume = 0.02 * 0.30 = 0.006.
export const VIRTUALS_TAX = 0.006;

export interface RevenueRow {
  agent_id: string;
  revenue_date: string;
  revenue_usd: number;
  source: string;
}

// Highest-liquidity Base pair's 24h volume × the agent tax share. Returns null
// when there is no positive-volume Base pair (the legacy `if (vol24 <= 0) continue`).
export function virtualsRevenueRow(
  payload: DexPayload,
  agent: { agent_id: string; date: string },
): RevenueRow | null {
  const pairs = payload.pairs ?? [];
  const pair = pairs
    .filter((p) => p?.chainId === "base")
    .sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
  const vol24 = Number(pair?.volume?.h24) || 0;
  if (vol24 <= 0) return null;
  return { agent_id: agent.agent_id, revenue_date: agent.date, revenue_usd: vol24 * VIRTUALS_TAX, source: "virtuals" };
}

export interface AgentSnapshot {
  agent_id: string;
  snapshot_date: string;
  x402_volume_usd: number | string | null;
}

// sync-agent-revenue-x402/index.ts. Roll up positive daily x402 volume into
// per-day revenue rows (source='x402'). Non-positive volume days are dropped.
export function x402RevenueRows(snaps: AgentSnapshot[]): RevenueRow[] {
  return snaps
    .filter((s) => Number(s.x402_volume_usd) > 0)
    .map((s) => ({
      agent_id: s.agent_id,
      revenue_date: s.snapshot_date,
      revenue_usd: Number(s.x402_volume_usd) || 0,
      source: "x402",
    }));
}

// The directory's trailing-30d revenue: sum revenue_usd for rows on/after
// (asof - 30d). `asof` is an ISO yyyy-mm-dd day; the window matches the
// projection's `revenue_date >= cutoff`.
export function sumTrailing30d(
  rows: { revenue_date: string; revenue_usd: number }[],
  asof: string,
): number {
  const cutoff = new Date(new Date(`${asof}T00:00:00Z`).getTime() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return rows.filter((r) => r.revenue_date >= cutoff).reduce((s, r) => s + (Number(r.revenue_usd) || 0), 0);
}

// ── Vault data ───────────────────────────────────────────────────────────────
// fetch-vault-data/index.ts. ERC-4626 TVL = totalAssets() scaled by the
// underlying's decimals × its USD price (stables fast-path to $1 upstream).
export function vaultTvlErc4626(input: { totalAssetsRaw: string; decimals: number; assetPriceUsd: number }): number {
  const totalUnits = Number(BigInt(input.totalAssetsRaw)) / 10 ** input.decimals;
  return totalUnits * input.assetPriceUsd;
}

// Legacy DexScreener-LP fallback: sum liquidity across the vault token's pairs on
// its chain.
export function vaultTvlDexLp(payload: DexPayload, chain: string): number {
  const pairs = (payload.pairs ?? []).filter((p) => p.chainId === chain);
  return pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
}

// ── Daily snapshots ──────────────────────────────────────────────────────────
// snapshot-daily/index.ts. Freeze the current coin market row as one dated point.
export function coinSnapshotRow(
  coin: { id: string; price_usd?: number | string | null; market_cap?: number | string | null; volume_24h?: number | string | null },
  date: string,
): { coin_id: string; snapshot_date: string; price_usd: number; market_cap: number; volume_24h: number } {
  return {
    coin_id: coin.id,
    snapshot_date: date,
    price_usd: Number(coin.price_usd) || 0,
    market_cap: Number(coin.market_cap) || 0,
    volume_24h: Number(coin.volume_24h) || 0,
  };
}

// ── Coverage scoring ─────────────────────────────────────────────────────────
// compute_project_coverage() (Supabase migration 20260603200417). Ported 1:1:
// breadth/identity/onchain/activity each 0..100, final score = round(mean/4).
export type SourceConfidence = "high" | "medium" | "low" | null;

export interface CoverageInputs {
  project: {
    has_agent: boolean;
    has_coin: boolean;
    has_wallet: boolean;
    has_vault: boolean;
    logo_url: string | null;
    description: string | null;
    twitter_handle: string | null;
    website_url: string | null;
    display_name: string | null;
    slug: string;
    resolved_at: string | null;
  };
  // bool_or aggregates over the project's active facet rows.
  agent: { productivityPositive: boolean; revenueSignal: boolean; confidence: SourceConfidence; enriched: boolean };
  coin: { pricePositive: boolean; mcapPositive: boolean; hasContract: boolean; hasCoingecko: boolean };
  wallet: { balancePositive: boolean; recentTx: boolean };
  vault: { tvlPositive: boolean; hasApy: boolean; hasAddress: boolean };
  history: { agent7: boolean; coin7: boolean; wallet7: boolean };
}

export interface CoverageScores {
  breadth: number;
  identity: number;
  onchain: number;
  activity: number;
  score: number;
}

function confPoints(c: SourceConfidence): number {
  return c === "high" ? 25 : c === "medium" ? 15 : c === "low" ? 5 : 0;
}

export function computeCoverage(i: CoverageInputs): CoverageScores {
  const p = i.project;
  const breadth = (Number(p.has_agent) + Number(p.has_coin) + Number(p.has_wallet) + Number(p.has_vault)) * 25;

  const identity = Math.min(
    100,
    (p.logo_url != null ? 20 : 0) +
      (p.description != null ? 20 : 0) +
      (p.twitter_handle != null ? 20 : 0) +
      (p.website_url != null ? 20 : 0) +
      (p.display_name != null && p.display_name !== p.slug ? 20 : 0),
  );

  let onchainSum = 0;
  let onchainCnt = 0;
  if (p.has_coin) {
    onchainSum +=
      (i.coin.pricePositive ? 30 : 0) +
      (i.coin.mcapPositive ? 30 : 0) +
      (i.coin.hasContract ? 20 : 0) +
      (i.coin.hasCoingecko ? 20 : 0);
    onchainCnt++;
  }
  if (p.has_wallet) {
    onchainSum += (i.wallet.balancePositive ? 40 : 0) + (i.wallet.recentTx ? 30 : 0) + (i.history.wallet7 ? 30 : 0);
    onchainCnt++;
  }
  if (p.has_vault) {
    onchainSum += (i.vault.tvlPositive ? 40 : 0) + (i.vault.hasApy ? 30 : 0) + (i.vault.hasAddress ? 30 : 0);
    onchainCnt++;
  }
  // Postgres integer division (sum / cnt) truncates toward zero — match it.
  const onchain = onchainCnt > 0 ? Math.trunc(onchainSum / onchainCnt) : 0;

  let activity: number;
  if (p.has_agent) {
    activity = Math.min(
      100,
      (i.agent.productivityPositive ? 25 : 0) +
        (i.agent.revenueSignal ? 25 : 0) +
        confPoints(i.agent.confidence) +
        (i.agent.enriched ? 15 : 0) +
        (i.history.agent7 || i.history.coin7 || i.history.wallet7 ? 10 : 0),
    );
  } else {
    activity = Math.min(
      70,
      (i.history.coin7 || i.history.wallet7 ? 40 : 0) + (p.resolved_at != null ? 30 : 0),
    );
  }

  // round((breadth+identity+onchain+activity)/4.0) — non-negative, so JS
  // Math.round (half-up) matches Postgres round (half-away-from-zero).
  const score = Math.round((breadth + identity + onchain + activity) / 4.0);
  return { breadth, identity, onchain, activity, score };
}

// Live prop-wallet valuation for GET /api/dashboards/wallet-balances (issue #84).
// Replaces the baked WALLET_SNAPSHOT_TOTAL_USD scalar (/allocation hero) and the
// 99-day walletPerfView series (/performance) that used to live in the frontend
// (alpine/views.js). Reads each configured prop wallet via Base JSON-RPC
// (base-rpc-client.ts) + keyless prices (token-prices.ts) on demand, behind a
// short-TTL in-process cache — the same shape as chain/vault-economics.ts.
//
// Per-holding provenance mirrors #50: 'live' = a real Base RPC + price read;
// 'stub' = the hermetic BASE_RPC_SOURCE/PRICE_SOURCE=stub fixtures; 'stale' = a
// single leg whose live read FAILED and degraded to its last-persisted Postgres
// sample. A value is NEVER fabricated, never silently frozen, and a single bad
// leg never 5xxs the whole endpoint.
import {
  config,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolvePropWallets,
  resolveTrackedAssets,
  resolveSp500,
  type BaseRpcSource,
  type PriceSource,
  type TrackedAsset,
} from "../config.ts";
import { sql } from "../db/client.ts";
import { callBalanceOf, callConvertToAssets, ethGetBalance, type RpcCallOptions } from "./base-rpc-client.ts";
import { fetchAssetPriceUsd } from "./token-prices.ts";

// 'seed' = a pre-launch history row backfilled from the ported baked constants
// (chain/wallet-history-seed.ts), NOT a live chain read — honesty invariant from
// migration 0014 ("a value is NEVER fabricated or falsely labelled 'live'").
export type Provenance = "live" | "stub" | "stale" | "seed";

export interface WalletHolding {
  symbol: string;
  chain: "base";
  group: string;
  color: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  priceSource: string; // 'pinned' (USDC) | 'geckoterminal' | 'yahoo'
  provenance: Provenance;
}

export interface WalletHistoryPoint {
  date: string; // ISO calendar day
  byAsset: Record<string, number>; // sparse: only symbols present that day
  totalUsd: number;
}

export interface WalletBalances {
  asOf: string;
  totalUsd: number;
  source: BaseRpcSource;
  priceSource: PriceSource;
  holdings: WalletHolding[];
  history: WalletHistoryPoint[];
}

const PRICE_VENDOR: Record<string, string> = { usdc: "pinned", gecko: "geckoterminal", yahoo: "yahoo" };

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

function amountFrom(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

// Sum a per-wallet raw read across every prop wallet. A read that throws
// propagates so the caller degrades the whole leg (never a partial/fabricated
// sum).
async function sumOverWallets(
  wallets: string[],
  read: (wallet: string) => Promise<bigint>,
): Promise<bigint> {
  const parts = await Promise.all(wallets.map(read));
  return parts.reduce((a, b) => a + b, 0n);
}

// Compute one asset's live amount (in token units) from chain reads.
async function readAmount(asset: TrackedAsset, wallets: string[]): Promise<number> {
  const opts = rpcOpts();
  switch (asset.valuationKind) {
    case "erc20": {
      const raw = await sumOverWallets(wallets, (w) => callBalanceOf(asset.address!, w, opts));
      return amountFrom(raw, asset.decimals);
    }
    case "native": {
      const raw = await sumOverWallets(wallets, (w) => ethGetBalance(w, opts));
      return amountFrom(raw, asset.decimals);
    }
    case "aave": {
      // Aave V3 aToken balanceOf already returns the underlying-denominated
      // (rebasing 1:1) balance, so amount = balanceOf / 10^underlyingDecimals.
      const raw = await sumOverWallets(wallets, (w) => callBalanceOf(asset.address!, w, opts));
      return amountFrom(raw, asset.decimals);
    }
    case "strategy": {
      // ERC-4626 NAV: value each wallet's shares at convertToAssets(shares) →
      // underlying USDC (6 dp), pinned $1. Yield-bearing, NOT a $1-pegged share.
      const shares = await sumOverWallets(wallets, (w) => callBalanceOf(asset.address!, w, opts));
      const assets = await callConvertToAssets(asset.address!, shares, opts);
      return amountFrom(assets, 6); // underlying USDC (6 dp)
    }
    case "config": {
      // Off-chain size from config (SP500): no derivatives-venue positions API.
      return resolveSp500().size;
    }
  }
}

interface PersistedHolding {
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

async function lastPersistedHolding(symbol: string): Promise<PersistedHolding | null> {
  const rows = await sql<{ amount: string | null; price_usd: string | null; value_usd: string }[]>`
    SELECT amount, price_usd, value_usd
      FROM wallet_balance_samples
     WHERE symbol = ${symbol}
     ORDER BY sample_date DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    amount: row.amount == null ? null : Number(row.amount),
    priceUsd: row.price_usd == null ? null : Number(row.price_usd),
    valueUsd: Number(row.value_usd),
  };
}

// Value a single asset. Each leg is independent: on ANY failure (RPC or price)
// it degrades to its last-persisted sample marked 'stale' — the other legs are
// unaffected.
async function valueAsset(
  asset: TrackedAsset,
  wallets: string[],
  source: BaseRpcSource,
  priceSource: PriceSource,
): Promise<WalletHolding> {
  const base = {
    symbol: asset.symbol,
    chain: "base" as const,
    group: asset.group,
    color: asset.color,
    priceSource: PRICE_VENDOR[asset.priceKind] ?? asset.priceKind,
  };
  try {
    const [amount, priceUsd] = await Promise.all([
      readAmount(asset, wallets),
      fetchAssetPriceUsd(asset, priceSource),
    ]);
    return {
      ...base,
      amount,
      priceUsd,
      valueUsd: amount * priceUsd,
      provenance: source === "stub" || priceSource === "stub" ? "stub" : "live",
    };
  } catch (err) {
    console.error(`wallet-balances: ${asset.symbol} live read failed, degrading to last-persisted sample:`, err);
    const persisted = await lastPersistedHolding(asset.symbol).catch(() => null);
    return {
      ...base,
      amount: persisted?.amount ?? null,
      priceUsd: persisted?.priceUsd ?? null,
      valueUsd: persisted?.valueUsd ?? null,
      provenance: "stale",
    };
  }
}

// Continuous history from persisted samples (seeded once from the baked series,
// then accumulated forward by the daily sampler). byAsset is sparse per day
// (ZYFAI/GIZA/SP500 are intermittent); the eight fixed series' group/colour
// ORDER is carried by holdings[]/resolveTrackedAssets, which the frontend
// iterates — byAsset is a lookup, not the ordering.
async function loadHistory(): Promise<WalletHistoryPoint[]> {
  const rows = await sql<{ sample_date: Date; symbol: string; value_usd: string }[]>`
    SELECT sample_date, symbol, value_usd
      FROM wallet_balance_samples
     ORDER BY sample_date ASC, symbol ASC
  `;
  const byDate = new Map<string, WalletHistoryPoint>();
  for (const r of rows) {
    const date = (r.sample_date instanceof Date ? r.sample_date : new Date(r.sample_date))
      .toISOString()
      .slice(0, 10);
    let point = byDate.get(date);
    if (!point) {
      point = { date, byAsset: {}, totalUsd: 0 };
      byDate.set(date, point);
    }
    const v = Number(r.value_usd);
    point.byAsset[r.symbol] = v;
    point.totalUsd += v;
  }
  return [...byDate.values()];
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: WalletBalances } | null = null;

export function _resetWalletBalancesCacheForTests(): void {
  cache = null;
}

export async function fetchWalletBalances(): Promise<WalletBalances> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  // Resolved per call (not module load) so tests can flip the env per case and
  // so provenance always tracks the current source. Fail-closed resolvers are
  // OUTSIDE the try below: an invalid marker must refuse loudly, never degrade
  // into a payload claiming 'live'.
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();

  const holdings = await Promise.all(assets.map((a) => valueAsset(a, wallets, source, priceSource)));
  const totalUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const history = await loadHistory().catch(() => [] as WalletHistoryPoint[]);

  const value: WalletBalances = {
    asOf: new Date(now).toISOString(),
    totalUsd,
    source,
    priceSource,
    holdings,
    history,
  };
  cache = { at: now, value };
  return value;
}

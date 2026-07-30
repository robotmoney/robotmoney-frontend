// Per-prop-wallet holdings breakdown for GET /api/dashboards/wallet-sleeves
// (live-data contract §3). Served purely from `wallet_sleeve_samples` in Postgres —
// ZERO RPC on the request path (issue #294).
import {
  isPlaceholderAddress,
  resolveBaseRpcSource,
  resolvePropWallets,
  resolveTrackedAssets,
  type BaseRpcSource,
  type TrackedAsset,
} from "../config.ts";
import { sql } from "../db/client.ts";
import {
  persistedFallbackWalletPriceReader,
  readChainAmountsBatched,
  type ChainAmount,
  type KeyedAssetRead,
  type Provenance,
  type WalletPriceReader,
} from "./wallet-valuation.ts";

export type { Provenance };

export interface SleeveHolding {
  symbol: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  provenance: Provenance;
  observedAt?: string | null;
}

export interface WalletSleeve {
  name: string;
  address: string; // lowercased
  type: string; // "primary" | "strategy"
  totalUsd: number; // sum of holdings[].valueUsd (nulls as 0)
  stale: boolean; // true when any holding degraded (provenance 'stale') or exceeds freshness budget
  holdings: SleeveHolding[];
  observedAt?: string | null;
}

export interface WalletSleeves {
  wallets: WalletSleeve[];
  asOf: string;
  source: BaseRpcSource;
  stale: boolean; // true when ANY sleeve is stale
}

export interface WalletSleeveReaders {
  readChainAmounts(reads: KeyedAssetRead[], logLabel: string): Promise<Map<string, ChainAmount>>;
  priceReader: WalletPriceReader;
}

const defaultWalletSleeveReaders: WalletSleeveReaders = {
  readChainAmounts: readChainAmountsBatched,
  priceReader: persistedFallbackWalletPriceReader,
};

interface SleeveDef {
  name: string;
  type: string;
  symbols: string[];
}
const SLEEVE_DEFS: SleeveDef[] = [
  { name: "Bankr", type: "primary", symbols: ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"] },
  { name: "Stablecoin Strategy 1", type: "strategy", symbols: ["ZYFAI-SS1"] },
  { name: "Stablecoin Strategy 2", type: "strategy", symbols: ["GIZA-SS1"] },
];

export const WALLET_SLEEVES_FRESHNESS_BUDGET_MS = 5 * 60_000;

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: WalletSleeves } | null = null;

export function _resetWalletSleevesCacheForTests(): void {
  cache = null;
}

export async function getWalletSleeves(
  _readers: WalletSleeveReaders = defaultWalletSleeveReaders,
): Promise<WalletSleeves> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const source = resolveBaseRpcSource();
  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));

  const sleeves: WalletSleeve[] = [];
  let overallStale = false;
  let newestSampleTime = 0;

  for (let i = 0; i < SLEEVE_DEFS.length && i < wallets.length; i++) {
    const def = SLEEVE_DEFS[i]!;
    const address = wallets[i]!.toLowerCase();
    const walletAssets = def.symbols
      .map((s) => bySymbol.get(s))
      .filter((a): a is TrackedAsset => a != null && (a.valuationKind === "native" || !isPlaceholderAddress(a.address)));

    const rows = await sql<
      { symbol: string; amount: string | null; price_usd: string | null; value_usd: string | null; provenance: string; sampled_at: Date }[]
    >`
      SELECT DISTINCT ON (symbol) symbol, amount, price_usd, value_usd, provenance, sampled_at
        FROM wallet_sleeve_samples
       WHERE lower(wallet_address) = lower(${address})
       ORDER BY symbol, sample_date DESC, sampled_at DESC
    `;
    const sampleMap = new Map(rows.map((r) => [r.symbol, r]));

    let sleeveStale = false;
    let sleeveNewestMs = 0;
    const holdings: SleeveHolding[] = [];

    for (const a of walletAssets) {
      const row = sampleMap.get(a.symbol);
      if (!row) {
        sleeveStale = true;
        holdings.push({
          symbol: a.symbol,
          amount: null,
          priceUsd: null,
          valueUsd: null,
          provenance: "stale",
          observedAt: null,
        });
        continue;
      }

      const sampledAtMs = (row.sampled_at instanceof Date ? row.sampled_at : new Date(row.sampled_at)).getTime();
      if (sampledAtMs > sleeveNewestMs) sleeveNewestMs = sampledAtMs;
      if (sampledAtMs > newestSampleTime) newestSampleTime = sampledAtMs;

      const isAgeStale = now - sampledAtMs > WALLET_SLEEVES_FRESHNESS_BUDGET_MS;
      const prov = row.provenance as Provenance;
      if (prov === "stale" || isAgeStale) {
        sleeveStale = true;
      }

      holdings.push({
        symbol: a.symbol,
        amount: row.amount == null ? null : Number(row.amount),
        priceUsd: row.price_usd == null ? null : Number(row.price_usd),
        valueUsd: row.value_usd == null ? null : Number(row.value_usd),
        provenance: prov,
        observedAt: row.sampled_at.toISOString(),
      });
    }

    const totalUsd = Math.round(holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0) * 100) / 100;
    if (sleeveStale) overallStale = true;

    sleeves.push({
      name: def.name,
      address,
      type: def.type,
      totalUsd,
      stale: sleeveStale,
      holdings,
      observedAt: sleeveNewestMs > 0 ? new Date(sleeveNewestMs).toISOString() : null,
    });
  }

  const asOf = new Date(newestSampleTime > 0 ? newestSampleTime : now).toISOString();

  const value: WalletSleeves = {
    wallets: sleeves,
    asOf,
    source,
    stale: overallStale || sleeves.length === 0,
  };

  cache = { at: now, value };
  return value;
}

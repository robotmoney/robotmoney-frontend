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
  QUARANTINED_PROVENANCE,
  readChainAmountsBatched,
  SLEEVE_DEFS,
  type ChainAmount,
  type KeyedAssetRead,
  type Provenance,
  type WalletPriceReader,
} from "./wallet-valuation.ts";
import { ASSET_PRICE_TIME_BASIS } from "../ops/asset-prices.ts";
import { ttlCached } from "./ttl-cache.ts";

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

// SLEEVE_DEFS now lives in wallet-valuation.ts — the same module that already
// owns everything that must stay identical between the sleeve feeds, and now
// also the backfill (ops/wallet-backfill.ts). It was duplicated here.

export const WALLET_SLEEVES_FRESHNESS_BUDGET_MS = 5 * 60_000;

const CACHE_TTL_MS = 30_000;

async function computeWalletSleeves(
  _readers: WalletSleeveReaders = defaultWalletSleeveReaders,
): Promise<WalletSleeves> {
  const now = Date.now();

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

    // D41 phase 3 (issue #850): a CLOSED day's price is a read-time join
    // against `asset_prices`; today's own row keeps its fused price/value —
    // see the extended rationale on wallet-balances.ts::loadHistory, which
    // this mirrors exactly (same LEFT JOIN, same COALESCE-shaped fallback for
    // #849's known cleanly-sampled-day gap, same JS-side multiplication so a
    // covered day reproduces the ORIGINAL value_usd bit-for-bit rather than
    // Postgres `numeric` arithmetic's differently-rounded product).
    const rows = await sql<
      {
        symbol: string;
        amount: string | null;
        price_usd: string | null;
        value_usd: string | null;
        provenance: string;
        sampled_at: Date;
        asset_price_usd: string | null;
        is_closed: boolean;
      }[]
    >`
      SELECT DISTINCT ON (wss.symbol) wss.symbol, wss.amount, wss.price_usd, wss.value_usd,
             wss.provenance, wss.sampled_at,
             ap.price_usd AS asset_price_usd,
             (wss.sample_date < (now() AT TIME ZONE 'UTC')::date) AS is_closed
        FROM wallet_sleeve_samples wss
        LEFT JOIN asset_prices ap
          ON ap.symbol = wss.symbol
         AND ap.price_date = wss.sample_date
         AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
       WHERE lower(wss.wallet_address) = lower(${address})
         AND wss.provenance <> ${QUARANTINED_PROVENANCE}
       ORDER BY wss.symbol, wss.sample_date DESC, wss.sampled_at DESC
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

      const amountNum = row.amount == null ? null : Number(row.amount);
      const useJoin = row.is_closed && row.asset_price_usd != null && amountNum != null;
      const priceUsd = useJoin ? Number(row.asset_price_usd) : row.price_usd == null ? null : Number(row.price_usd);
      const valueUsd = useJoin
        ? amountNum! * Number(row.asset_price_usd)
        : row.value_usd == null ? null : Number(row.value_usd);

      holdings.push({
        symbol: a.symbol,
        amount: amountNum,
        priceUsd,
        valueUsd,
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

  return {
    wallets: sleeves,
    asOf,
    source,
    stale: overallStale || sleeves.length === 0,
  };
}

export const getWalletSleeves = ttlCached(computeWalletSleeves, CACHE_TTL_MS);

export function _resetWalletSleevesCacheForTests(): void {
  getWalletSleeves._resetForTests();
}

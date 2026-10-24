// Backfill asset_prices for cleanly-sampled closed days (issue #927), run by
// the pipeline worker as the scheduled `ops.backfill_asset_prices` job.
//
// A "cleanly-sampled closed day" is a day that:
// - Is fully closed (before today UTC)
// - Has a complete wallet_balance_samples snapshot (all expected symbols present, no quarantined rows)
// - Has a complete wallet_sleeve_samples snapshot
// - Is missing from asset_prices for one or more priced symbols
//
// This closes the coverage gap described in docs/technical/markets-asset-pricing-ingest.md §8.1:
// the live sampler never dual-writes, and repairResolvedDay only writes for incomplete days.
// So a day that was sampled cleanly never gets asset_prices rows unless it falls inside
// migration 0046's one-time seed window.
//
// THE DATABASE STEPS ARE THE API'S (issue 1034, D75). The worker loads the
// historical prices from the network; the candidate days, each day's
// completeness and every price write go through `AssetPriceBackfillStore`,
// which by default is the api's pipeline operations (ops/asset-prices.ts
// assetPriceBackfillDbStore runs them).
import { loadHistoricalPrices, resolvePoolForToken, type HistoricalPriceTable } from "../chain/historical-prices.ts";
import { pinnedPoolForToken, resolvePropWallets, resolveTrackedAssets, type TrackedAsset } from "../config.ts";
import { pipelineIngest, pipelineRead } from "../worker/pipeline-client.ts";
import type { AssetPriceDisagreement, AssetPriceSource, AssetPriceWrite } from "./asset-price-types.ts";
import { resolveWalletSnapshotManifest } from "./wallet-snapshot-manifest.ts";

/** The three database steps the backfill takes. */
export interface AssetPriceBackfillStore {
  /** Closed days before `cutoff` with a priced symbol's sample but no price row, oldest first, at most `limit`. */
  candidateDays(cutoff: string, pricedSymbols: readonly string[], limit: number): Promise<string[]>;
  /** The balance symbols and `wallet|symbol` sleeve keys the day's live snapshot holds. */
  dayCompleteness(date: string, wallets: readonly string[]): Promise<{ balanceSymbols: string[]; sleeveKeys: string[] }>;
  /** Write one price row; returns a disagreement with what the table already held. */
  writePrice(row: AssetPriceWrite): Promise<AssetPriceDisagreement | null>;
}

/** The store, through the api (pipeline/ops.ts `asset_prices.*`). */
export const pipelineAssetPriceBackfillStore: AssetPriceBackfillStore = {
  candidateDays: (cutoff, pricedSymbols, limit) =>
    pipelineRead<string[]>("asset_prices.backfill_candidate_days", cutoff, [...pricedSymbols], limit),
  dayCompleteness: (date, wallets) =>
    pipelineRead<{ balanceSymbols: string[]; sleeveKeys: string[] }>("asset_prices.day_completeness", date, [...wallets]),
  writePrice: (row) => pipelineIngest<AssetPriceDisagreement | null>("asset_prices.write", row),
};

export interface AssetPriceBackfillResult {
  daysProcessed: number;
  rowsWritten: number;
  rowsSkipped: number;
  errors: { date: string; symbol: string; error: string }[];
}

export interface AssetPriceBackfillDeps {
  /** Load historical prices for assets over a date range. */
  loadPrices(assets: readonly TrackedAsset[], fromDate: string, toDate: string): Promise<HistoricalPriceTable>;
}

const defaultBackfillDeps: AssetPriceBackfillDeps = {
  loadPrices: loadHistoricalPrices,
};

// Bounds one run's work the same way wallet backfill's own per-run day cap
// (ops/wallet-backfill.ts::maxDaysPerRun) does: this job is scheduled (issue
// #927; db/seed.ts's `ops.backfill_asset_prices` row), so an unbounded
// backlog converges over successive runs instead of one run trying to walk
// the whole history — and never blocking the shared analytics lane while it
// does.
const ASSET_PRICE_BACKFILL_MAX_DAYS_PER_RUN = 30;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The newest day fully CLOSED as of `now` — today's price is not settled yet. */
function lastClosedPriceDay(now: Date): string {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return isoDay(t - 86_400_000);
}

function dayCloseInstant(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
}

/** Backfill asset_prices for cleanly-sampled closed days. Returns a summary of what was backfilled. */
export async function backfillAssetPricesForCleanDays(
  store: AssetPriceBackfillStore = pipelineAssetPriceBackfillStore,
  now: Date = new Date(),
  deps: AssetPriceBackfillDeps = defaultBackfillDeps,
): Promise<AssetPriceBackfillResult> {
  const assets = resolveTrackedAssets();
  const wallets = resolvePropWallets();
  const pricedAssets = assets.filter((a) => a.priceKind !== "yahoo");
  const pricedSymbols = pricedAssets.map((a) => a.symbol);
  const cutoff = lastClosedPriceDay(now);

  // Find closed days that have at least one PRICED symbol's
  // wallet_balance_samples row with no matching asset_prices row yet — the
  // actual coverage gap, not merely "every day that has ever been sampled".
  const candidateDays = await store.candidateDays(cutoff, pricedSymbols, ASSET_PRICE_BACKFILL_MAX_DAYS_PER_RUN);

  const result: AssetPriceBackfillResult = {
    daysProcessed: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    errors: [],
  };

  for (const date of candidateDays) {
    result.daysProcessed += 1;

    // Check if this day has a complete snapshot (both balance and sleeve)
    const manifest = resolveWalletSnapshotManifest(assets, wallets, date);
    const { balanceSymbols, sleeveKeys } = await store.dayCompleteness(date, wallets);

    const missingBalance = manifest.balanceAssets
      .map((a) => a.symbol)
      .filter((s) => !balanceSymbols.includes(s));
    const missingSleeve = manifest.sleeveKeys
      .map((k) => `${k.walletAddress.toLowerCase()}|${k.asset.symbol}`)
      .filter((k) => !sleeveKeys.includes(k));

    if (missingBalance.length > 0 || missingSleeve.length > 0) {
      // Day is incomplete, skip — repairResolvedDay will handle it when/if it runs
      result.rowsSkipped += manifest.balanceAssets.length + manifest.sleeveKeys.length;
      continue;
    }

    // Day is complete — load historical prices for this date
    let prices;
    try {
      prices = await deps.loadPrices(pricedAssets, date, date);
    } catch (err) {
      for (const asset of pricedAssets) {
        result.errors.push({ date, symbol: asset.symbol, error: String(err) });
      }
      continue;
    }

    // Write asset_prices rows for each priced symbol that has a price
    for (const asset of pricedAssets) {
      const price = prices.get(asset.symbol)?.get(date);
      if (price === undefined) {
        // No price available for this symbol on this day (thin candle or pool refusal)
        result.rowsSkipped += 1;
        continue;
      }
      if (!Number.isFinite(price) || price <= 0) {
        result.errors.push({ date, symbol: asset.symbol, error: `non-finite or non-positive price: ${price}` });
        continue;
      }

      const source: AssetPriceSource = asset.priceKind === "usdc" ? "pinned" : "geckoterminal";
      let poolKey: string | null = null;
      if (source === "geckoterminal" && asset.address) {
        const pinned = pinnedPoolForToken(asset.address);
        if (pinned) {
          poolKey = pinned;
        } else {
          try {
            poolKey = await resolvePoolForToken(asset.address);
          } catch {
            poolKey = null;
          }
        }
      }

      try {
        await store.writePrice({
          priceDate: date,
          symbol: asset.symbol,
          priceUsd: price,
          source,
          poolKey,
          tokenAddress: source === "pinned" ? null : asset.address,
          observedAt: dayCloseInstant(date),
          fetchedAt: now,
          configIdentity: source === "pinned"
            ? "pinned:usd:1.00"
            : `geckoterminal:pool:${poolKey ?? "unresolved"}`,
        });
        result.rowsWritten += 1;
      } catch (err) {
        result.errors.push({ date, symbol: asset.symbol, error: String(err) });
      }
    }
  }

  return result;
}

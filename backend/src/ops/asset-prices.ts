// The asset_prices table (D41 phases 1, 2, 5; issue #849;
// docs/decisions.md D41; docs/technical/markets-asset-pricing-ingest.md §5.6).
//
// THREE THINGS LIVE HERE, kept together because they are the three ways
// anything else in this repo touches the price series:
//
//   1. `writeAssetPrice` — the dual-write the window executor calls alongside
//      every `wallet_balance_samples` insert (ops/wallet-backfill.ts's
//      repairResolvedDay), with a disagreement check against whatever this
//      table already held for that (date, symbol).
//   2. `assetPriceFloorCache` — the Postgres-backed store for
//      chain/asset-price-floor.ts's per-symbol first-priceable day, following
//      the same injected-cache shape ops/wallet-backfill.ts already uses for
//      `chain_day_blocks` and `chain_address_floors`.
//   3. `detectAssetPriceGaps` — the price-side gap report: expected days minus
//      distinct persisted days, PER SYMBOL, bounded by that symbol's floor. No
//      manifest, no per-slot expected-key AND-logic — markets §5.6 is explicit
//      that this is a DIFFERENT, simpler shape than ops/gap-detector.ts's
//      generic detector, which answers "is this slot complete across every
//      expected key" rather than "which days is this one symbol missing".
//      Deliberately NOT wired into any dispatcher here: D41's phase 5 is the
//      driver SHAPE (no manifest, no attempt accounting for price failures),
//      not a new scheduled job, which stays a later issue's scope.
//
// UPDATE (issue #927): the live BALANCE sampler now calls `writeAssetPrice`
// too, alongside its ordinary `wallet_balance_samples` write — see
// `worker/handlers/wallet.ts::sampleWalletBalances`. This is still not the
// live/close substitution D41 exists to refuse (markets §5.6 point 1): the
// sampler stamps `observed_at` at the UTC daily candle close for the date it
// just sampled (one day after that date's midnight), not the wall-clock
// instant of the sample — see `dayCloseInstant` in that file. Before #927,
// this file's only callers were the repair path (`ops/wallet-backfill.ts`)
// and this file's own retroactive backfill (`backfillAssetPricesForCleanDays`,
// below) — see backend/tests/asset-prices-dual-write.test.ts's "the live
// sampler never writes a LIVE-SPOT price under today's date" case, which the
// distinction above still holds.
import { sql as defaultSql, type DbHandle } from "../db/client.ts";
import type { TrackedAsset } from "../config.ts";
import type { AssetPriceFloor, AssetPriceFloorCache } from "../chain/asset-price-floor.ts";
import { loadHistoricalPrices, resolvePoolForToken, type HistoricalPriceTable } from "../chain/historical-prices.ts";
import { resolveTrackedAssets, resolvePropWallets, pinnedPoolForToken } from "../config.ts";
import { resolveWalletSnapshotManifest } from "./wallet-snapshot-manifest.ts";
import { QUARANTINED_PROVENANCE } from "../chain/wallet-valuation.ts";

export type AssetPriceSource = "geckoterminal" | "pinned";
export const ASSET_PRICE_TIME_BASIS = "utc-daily-close" as const;

export interface AssetPriceWrite {
  priceDate: string;
  symbol: string;
  priceUsd: number;
  source: AssetPriceSource;
  /** Which pool answered; null when pinned or unresolved (markets §5.6). */
  poolKey: string | null;
  /** What `token=` named; null when pinned. */
  tokenAddress: string | null;
  observedAt: Date;
  fetchedAt: Date;
  configIdentity: string;
}

export interface AssetPriceDisagreement {
  priceDate: string;
  symbol: string;
  previousPriceUsd: number;
  freshPriceUsd: number;
  /** What the disagreeing value came from. `writeAssetPrice` always reports
   *  `'asset_prices'` (a value this table already held); a caller may report
   *  `'sample_row'` for a disagreement against the wallet_balance_samples row
   *  a prior pass wrote for the same (date, symbol) — the literal
   *  "sample row vs. price row" reading of D41 phase 2's verify step. */
  against: "asset_prices" | "sample_row";
}

// A relative tolerance, not an exact-equality check: the same numeric value
// can arrive through `numeric` round-tripping with a different string
// representation (e.g. trailing zeros), and that is not a disagreement worth
// reporting. Anything past this tolerance is a genuine reconciliation finding.
const DISAGREEMENT_RELATIVE_TOLERANCE = 1e-9;

export function assetPricesDisagree(previous: number, fresh: number): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(fresh)) return true;
  const scale = Math.max(Math.abs(previous), Math.abs(fresh), 1e-12);
  return Math.abs(previous - fresh) / scale > DISAGREEMENT_RELATIVE_TOLERANCE;
}

/**
 * Dual-write one (date, symbol) price row, verifying against whatever this
 * table already held.
 *
 * WHY A DISAGREEMENT IS REPORTED, NEVER REFUSED. This is the EXPAND half of
 * the cutover (issue #849) — nothing reads this table yet, so overwriting with
 * the freshly-verified repair value can never regress a live read path. A
 * disagreement is a reconciliation finding (D41: "prices can be reconciled...
 * diffable against what is persisted"), surfaced to the caller so it lands in
 * the day's result/log, not a reason to leave stale data in place.
 */
export async function writeAssetPrice(db: DbHandle, row: AssetPriceWrite): Promise<AssetPriceDisagreement | null> {
  const [existing] = await db<{ price_usd: string }[]>`
    SELECT price_usd FROM asset_prices
     WHERE price_date = ${row.priceDate} AND symbol = ${row.symbol} AND time_basis = ${ASSET_PRICE_TIME_BASIS}
  `;
  let disagreement: AssetPriceDisagreement | null = null;
  if (existing) {
    const previousPriceUsd = Number(existing.price_usd);
    if (assetPricesDisagree(previousPriceUsd, row.priceUsd)) {
      disagreement = {
        priceDate: row.priceDate,
        symbol: row.symbol,
        previousPriceUsd,
        freshPriceUsd: row.priceUsd,
        against: "asset_prices",
      };
    }
  }
  await db`
    INSERT INTO asset_prices
      (price_date, symbol, time_basis, price_usd, currency, source,
       pool_key, token_address, observed_at, fetched_at, config_identity)
    VALUES
      (${row.priceDate}, ${row.symbol}, ${ASSET_PRICE_TIME_BASIS}, ${row.priceUsd}, 'USD', ${row.source},
       ${row.poolKey}, ${row.tokenAddress}, ${row.observedAt}, ${row.fetchedAt}, ${row.configIdentity})
    ON CONFLICT (price_date, symbol, time_basis) DO UPDATE SET
      price_usd       = EXCLUDED.price_usd,
      source          = EXCLUDED.source,
      pool_key        = EXCLUDED.pool_key,
      token_address   = EXCLUDED.token_address,
      observed_at     = EXCLUDED.observed_at,
      fetched_at      = EXCLUDED.fetched_at,
      config_identity = EXCLUDED.config_identity
  `;
  return disagreement;
}

// ── The permanent per-symbol floor cache, backed by Postgres (D41) ──────────

export function assetPriceFloorCache(db: DbHandle): AssetPriceFloorCache {
  return {
    async get(symbol) {
      const [row] = await db<{ first_priceable_date: Date; proven: boolean }[]>`
        SELECT first_priceable_date, proven FROM asset_price_floors WHERE symbol = ${symbol}
      `;
      if (!row) return null;
      return {
        symbol,
        firstPriceableDate: new Date(row.first_priceable_date).toISOString().slice(0, 10),
        proven: row.proven,
      };
    },
    async set(floor: AssetPriceFloor) {
      await db`
        INSERT INTO asset_price_floors (symbol, first_priceable_date, proven)
        VALUES (${floor.symbol}, ${floor.firstPriceableDate}, ${floor.proven})
        ON CONFLICT (symbol) DO UPDATE SET
          first_priceable_date = EXCLUDED.first_priceable_date,
          proven               = EXCLUDED.proven,
          resolved_at          = now()
      `;
    },
  };
}

// ── Price-side gap detection (D41 phase 5; markets §5.6) ────────────────────

export interface AssetPriceGapReport {
  symbol: string;
  /** The bound gap detection will never report a day before. Falls back to
   *  `TrackedAsset.deployedAt` when no floor has been proven yet — the same
   *  conservative default the amounts side already applies, never a date
   *  earlier than the asset's own tracking start. */
  floorDate: string;
  floorProven: boolean;
  expectedDays: number;
  persistedDays: number;
  missingDays: string[];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function utcMidnightMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}
/** The newest day fully CLOSED as of `now` — today's price is not settled yet
 *  and is not this detector's concern (mirrors ops/wallet-backfill.ts's
 *  `lastClosedDay`, duplicated rather than imported to keep this module
 *  independent of the amounts-side executor). */
function lastClosedPriceDay(now: Date): string {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return isoDay(t - 86_400_000);
}

/**
 * Expected days minus distinct persisted days, PER SYMBOL, bounded below by
 * that symbol's first-priceable floor. No manifest, no per-slot expected-key
 * set, no attempt accounting — a pure read-and-compute report (markets §5.6).
 *
 * SP500 (`priceKind: 'yahoo'`) is never in this report: it is not part of the
 * price series at all (markets §3.2).
 */
export async function detectAssetPriceGaps(
  assets: readonly TrackedAsset[],
  db: DbHandle = defaultSql,
  now: Date = new Date(),
): Promise<AssetPriceGapReport[]> {
  const priced = assets.filter((a) => a.priceKind !== "yahoo");
  if (priced.length === 0) return [];
  const cutoff = lastClosedPriceDay(now);
  const cache = assetPriceFloorCache(db);

  const symbols = priced.map((a) => a.symbol);
  const rows = await db<{ symbol: string; price_date: Date }[]>`
    SELECT symbol, price_date FROM asset_prices
     WHERE symbol = ANY(${symbols}) AND time_basis = ${ASSET_PRICE_TIME_BASIS}
  `;
  const persistedBySymbol = new Map<string, Set<string>>();
  for (const row of rows) {
    const day = isoDay(new Date(row.price_date).getTime());
    let set = persistedBySymbol.get(row.symbol);
    if (!set) {
      set = new Set();
      persistedBySymbol.set(row.symbol, set);
    }
    set.add(day);
  }

  const out: AssetPriceGapReport[] = [];
  for (const asset of priced) {
    const floor = await cache.get(asset.symbol);
    const floorDate = floor?.firstPriceableDate ?? asset.deployedAt;
    const floorProven = floor?.proven ?? false;
    const persisted = persistedBySymbol.get(asset.symbol) ?? new Set<string>();
    const missingDays: string[] = [];
    if (floorDate <= cutoff) {
      for (let t = utcMidnightMs(floorDate); t <= utcMidnightMs(cutoff); t += 86_400_000) {
        const day = isoDay(t);
        if (!persisted.has(day)) missingDays.push(day);
      }
    }
    const expectedDays = floorDate <= cutoff
      ? Math.floor((utcMidnightMs(cutoff) - utcMidnightMs(floorDate)) / 86_400_000) + 1
      : 0;
    out.push({
      symbol: asset.symbol,
      floorDate,
      floorProven,
      expectedDays,
      persistedDays: persisted.size,
      missingDays,
    });
  }
  return out;
}

function dayCloseInstant(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
}

/**
 * Backfill asset_prices for cleanly-sampled closed days.
 *
 * A "cleanly-sampled closed day" is a day that:
 * - Is fully closed (before today UTC)
 * - Has a complete wallet_balance_samples snapshot (all expected symbols present, no quarantined rows)
 * - Has a complete wallet_sleeve_samples snapshot
 * - Is missing from asset_prices for one or more priced symbols
 *
 * This closes the coverage gap described in docs/technical/markets-asset-pricing-ingest.md §8.1:
 * the live sampler never dual-writes, and repairResolvedDay only writes for incomplete days.
 * So a day that was sampled cleanly never gets asset_prices rows unless it falls inside
 * migration 0046's one-time seed window.
 *
 * Returns a summary of what was backfilled.
 */
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

export async function backfillAssetPricesForCleanDays(
  db: DbHandle = defaultSql,
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
  // An anti-join (rather than "every closed day, always") keeps a caught-up
  // deployment's run cheap: once a day is covered it is never re-selected,
  // re-fetched, or re-written on a later tick.
  const candidateDays = await db<{ sample_date: Date }[]>`
    SELECT DISTINCT wbs.sample_date
      FROM wallet_balance_samples wbs
     WHERE wbs.sample_date < ${cutoff}
       AND wbs.symbol = ANY(${pricedSymbols})
       AND wbs.provenance <> ${QUARANTINED_PROVENANCE}
       AND NOT EXISTS (
             SELECT 1 FROM asset_prices ap
              WHERE ap.symbol = wbs.symbol
                AND ap.price_date = wbs.sample_date
                AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
           )
     ORDER BY wbs.sample_date ASC
     LIMIT ${ASSET_PRICE_BACKFILL_MAX_DAYS_PER_RUN}
  `;

  const result: AssetPriceBackfillResult = {
    daysProcessed: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    errors: [],
  };

  for (const { sample_date } of candidateDays) {
    const date = sample_date.toISOString().slice(0, 10);
    result.daysProcessed += 1;

    // Check if this day has a complete snapshot (both balance and sleeve)
    const manifest = resolveWalletSnapshotManifest(assets, wallets, date);
    const [balanceResult] = await db<{
      balance_symbols: string[];
      balance_rows: number;
    }[]>`
      SELECT
        ARRAY_AGG(DISTINCT symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS balance_symbols,
        COUNT(DISTINCT symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS balance_rows
      FROM wallet_balance_samples
      WHERE sample_date = ${date}
    `;
    const [sleeveResult] = await db<{
      sleeve_keys: string[];
      sleeve_rows: number;
    }[]>`
      SELECT
        ARRAY_AGG(DISTINCT wallet_address || '|' || symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS sleeve_keys,
        COUNT(DISTINCT wallet_address || '|' || symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS sleeve_rows
      FROM wallet_sleeve_samples
      WHERE sample_date = ${date}
        AND lower(wallet_address) = ANY(${wallets.map((w) => w.toLowerCase())}::text[])
    `;

    const balanceSymbols = balanceResult?.balance_symbols ?? [];
    const sleeveKeys = sleeveResult?.sleeve_keys ?? [];

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
        await writeAssetPrice(db, {
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

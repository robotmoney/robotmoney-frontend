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
import { on, registerQuery } from "../db/registry.ts";
import { ASSET_PRICE_TIME_BASIS } from "./asset-price-basis.ts";
import { assetPricesDisagree, type AssetPriceDisagreement, type AssetPriceWrite } from "./asset-price-types.ts";
import type { TrackedAsset } from "../config.ts";
import type { AssetPriceFloor, AssetPriceFloorCache } from "../chain/asset-price-floor.ts";
import type { AssetPriceBackfillStore } from "./asset-price-backfill.ts";
import { QUARANTINED_PROVENANCE } from "../chain/wallet-valuation.ts";

// Every statement here runs in the api as rm_app (issue 1034, D75). The price
// dual-write belongs to the wallet samplers and the repair pass, and the
// coverage backfill is a scheduled job (db/seed.ts's `ops.backfill_asset_prices`);
// the pipeline worker runs all three and reaches these statements over
// /api/pipeline/** (pipeline/ops.ts).
const PIPELINE_ROUTE = "src/api/routes/pipeline";

const readExistingPrice = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:writeAssetPrice.readExisting",
  purpose: "Read the price a (date, symbol) already holds, so a disagreeing dual-write is reported.",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: `SELECT price_usd FROM asset_prices
     WHERE price_date = $1 AND symbol = $2 AND time_basis = $3`,
    params: ["2000-01-01", "probe", "probe"],
  },
});

const upsertPrice = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  // SELECT as well: ON CONFLICT (price_date, symbol, time_basis) reads its arbiter columns.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/ops/asset-prices:writeAssetPrice.upsert",
  purpose: "Dual-write one (date, symbol) price row at the utc-daily-close time basis (D41).",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: `INSERT INTO asset_prices
      (price_date, symbol, time_basis, price_usd, currency, source,
       pool_key, token_address, observed_at, fetched_at, config_identity)
    SELECT
      $1::date, $2, $3, $4::numeric, 'USD', $5,
       $6, $7, $8::timestamptz, $9::timestamptz, $10 WHERE false
    ON CONFLICT (price_date, symbol, time_basis) DO UPDATE SET
      price_usd       = EXCLUDED.price_usd,
      source          = EXCLUDED.source,
      pool_key        = EXCLUDED.pool_key,
      token_address   = EXCLUDED.token_address,
      observed_at     = EXCLUDED.observed_at,
      fetched_at      = EXCLUDED.fetched_at,
      config_identity = EXCLUDED.config_identity`,
    params: ["2000-01-01", "probe", "probe", 1, "probe", null, null, "2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z", "probe"],
  },
});

const readFloor = registerQuery({
  role: "rm_app",
  object: "asset_price_floors",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:assetPriceFloorCache.get",
  purpose: "Read a symbol's permanent first-priceable day.",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: "SELECT first_priceable_date, proven FROM asset_price_floors WHERE symbol = $1",
    params: ["probe"],
  },
});

const upsertFloor = registerQuery({
  role: "rm_app",
  object: "asset_price_floors",
  // SELECT as well: ON CONFLICT (symbol) reads its arbiter column.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/ops/asset-prices:assetPriceFloorCache.set",
  purpose: "Record or advance a symbol's first-priceable day.",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: `INSERT INTO asset_price_floors (symbol, first_priceable_date, proven)
        SELECT $1, $2::date, $3::boolean WHERE false
        ON CONFLICT (symbol) DO UPDATE SET
          first_priceable_date = EXCLUDED.first_priceable_date,
          proven               = EXCLUDED.proven,
          resolved_at          = now()`,
    params: ["probe", "2000-01-01", false],
  },
});

const readPersistedPrices = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:detectAssetPriceGaps.persisted",
  purpose: "Read the persisted price days per symbol for the price-side gap report.",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: `SELECT symbol, price_date FROM asset_prices
     WHERE symbol = ANY($1::text[]) AND time_basis = $2`,
    params: ["{}", "probe"],
  },
});

const CANDIDATE_DAYS_PROBE = {
  statement: `SELECT DISTINCT wbs.sample_date
      FROM wallet_balance_samples wbs
     WHERE wbs.sample_date < $1
       AND wbs.symbol = ANY($2::text[])
       AND wbs.provenance <> $3
       AND wbs.superseded_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM asset_prices ap
              WHERE ap.symbol = wbs.symbol
                AND ap.price_date = wbs.sample_date
                AND ap.time_basis = $4
           )
     ORDER BY wbs.sample_date ASC
     LIMIT $5`,
  params: ["2000-01-01", "{}", QUARANTINED_PROVENANCE, "probe", 1],
} as const;

const readCandidateDays = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:backfillAssetPricesForCleanDays.candidateDays",
  purpose: "Find closed, cleanly sampled days that lack an asset_prices row for a priced symbol.",
  callers: [PIPELINE_ROUTE],
  probe: CANDIDATE_DAYS_PROBE,
});

const readCandidateDayPrices = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:backfillAssetPricesForCleanDays.candidateDayPrices",
  purpose: "Anti-join the candidate days against the prices already persisted.",
  callers: [PIPELINE_ROUTE],
  probe: CANDIDATE_DAYS_PROBE,
});

const readBalanceCompleteness = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:backfillAssetPricesForCleanDays.balanceSymbols",
  purpose: "Read which symbols a day's live balance snapshot holds, to prove the day complete.",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: `SELECT
        ARRAY_AGG(DISTINCT symbol) FILTER (WHERE provenance <> $1) AS balance_symbols,
        COUNT(DISTINCT symbol) FILTER (WHERE provenance <> $1) AS balance_rows
      FROM wallet_balance_samples
      WHERE sample_date = $2
        AND superseded_at IS NULL`,
    params: [QUARANTINED_PROVENANCE, "2000-01-01"],
  },
});

const readSleeveCompleteness = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["SELECT"],
  site: "src/ops/asset-prices:backfillAssetPricesForCleanDays.sleeveKeys",
  purpose: "Read which sleeve keys a day's live snapshot holds, to prove the day complete.",
  callers: [PIPELINE_ROUTE],
  probe: {
    statement: `SELECT
        ARRAY_AGG(DISTINCT wallet_address || '|' || symbol) FILTER (WHERE provenance <> $1) AS sleeve_keys,
        COUNT(DISTINCT wallet_address || '|' || symbol) FILTER (WHERE provenance <> $1) AS sleeve_rows
      FROM wallet_sleeve_samples
      WHERE sample_date = $2
        AND superseded_at IS NULL
        AND lower(wallet_address) = ANY($3::text[])`,
    params: [QUARANTINED_PROVENANCE, "2000-01-01", "{}"],
  },
});

export type { AssetPriceDisagreement, AssetPriceSource, AssetPriceWrite } from "./asset-price-types.ts";
export { assetPricesDisagree } from "./asset-price-types.ts";
export { ASSET_PRICE_TIME_BASIS };

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
  const [existing] = await on(db, readExistingPrice)<{ price_usd: string }>`
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
  await on(db, upsertPrice)`
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
      const [row] = await on(db, readFloor)<{ first_priceable_date: Date; proven: boolean }>`
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
      await on(db, upsertFloor)`
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
  const rows = await on(db, readPersistedPrices)<{ symbol: string; price_date: Date }>`
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

// ── The coverage backfill's reads and write (issue #927) ────────────────────
//
// The backfill itself (ops/asset-price-backfill.ts) loads historical prices
// from the network, so it runs in the pipeline worker. These are the three
// database steps it takes, run by the api (issue 1034, D75).

/** Closed days before `cutoff` with a priced symbol's balance sample but no asset_prices row, oldest first. */
export async function assetPriceBackfillCandidateDays(
  db: DbHandle,
  cutoff: string,
  pricedSymbols: readonly string[],
  limit: number,
): Promise<string[]> {
  // An anti-join (rather than "every closed day, always") keeps a caught-up
  // deployment's run cheap: once a day is covered it is never re-selected,
  // re-fetched, or re-written on a later tick.
  const candidateDays = await on(db, readCandidateDays, readCandidateDayPrices)<{ sample_date: Date }>`
    SELECT DISTINCT wbs.sample_date
      FROM wallet_balance_samples wbs
     WHERE wbs.sample_date < ${cutoff}
       AND wbs.symbol = ANY(${[...pricedSymbols]})
       AND wbs.provenance <> ${QUARANTINED_PROVENANCE}
       -- D55 (6): a row the wallet repair superseded (migration 0104) is not
       -- a sample any more; it neither makes a day a candidate nor covers it.
       AND wbs.superseded_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM asset_prices ap
              WHERE ap.symbol = wbs.symbol
                AND ap.price_date = wbs.sample_date
                AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
           )
     ORDER BY wbs.sample_date ASC
     LIMIT ${limit}
  `;
  return candidateDays.map(({ sample_date }) => sample_date.toISOString().slice(0, 10));
}

/** Which balance symbols and `wallet|symbol` sleeve keys a day's live snapshot holds. */
export async function assetPriceDayCompleteness(
  db: DbHandle,
  date: string,
  wallets: readonly string[],
): Promise<{ balanceSymbols: string[]; sleeveKeys: string[] }> {
  const [balanceResult] = await on(db, readBalanceCompleteness)<{
    balance_symbols: string[];
    balance_rows: number;
  }>`
    SELECT
      ARRAY_AGG(DISTINCT symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS balance_symbols,
      COUNT(DISTINCT symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS balance_rows
    FROM wallet_balance_samples
    WHERE sample_date = ${date}
      AND superseded_at IS NULL
  `;
  const [sleeveResult] = await on(db, readSleeveCompleteness)<{
    sleeve_keys: string[];
    sleeve_rows: number;
  }>`
    SELECT
      ARRAY_AGG(DISTINCT wallet_address || '|' || symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS sleeve_keys,
      COUNT(DISTINCT wallet_address || '|' || symbol) FILTER (WHERE provenance <> ${QUARANTINED_PROVENANCE}) AS sleeve_rows
    FROM wallet_sleeve_samples
    WHERE sample_date = ${date}
      AND superseded_at IS NULL
      AND lower(wallet_address) = ANY(${wallets.map((w) => w.toLowerCase())}::text[])
  `;
  return { balanceSymbols: balanceResult?.balance_symbols ?? [], sleeveKeys: sleeveResult?.sleeve_keys ?? [] };
}

/** The backfill's store on a database handle: the api's operations, and a test's direct one. */
export function assetPriceBackfillDbStore(db: DbHandle = defaultSql): AssetPriceBackfillStore {
  return {
    candidateDays: (cutoff, pricedSymbols, limit) => assetPriceBackfillCandidateDays(db, cutoff, pricedSymbols, limit),
    dayCompleteness: (date, wallets) => assetPriceDayCompleteness(db, date, wallets),
    writePrice: (row) => writeAssetPrice(db, row),
  };
}

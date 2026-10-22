// The live wallet samplers' writes, run by the api for the pipeline worker
// (issue 1034, decision D75). worker/handlers/wallet.ts reads the chain and the
// prices and sends a day's rows; each write here is the statement that handler
// used to run on its own pool, in one transaction under the wallet snapshot
// date lock (D55 (6) supersession and D41 phase 4 dual-write included).
import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";
import { writeAssetPrice } from "../../ops/asset-prices.ts";
import type { AssetPriceWrite } from "../../ops/asset-price-types.ts";
import { lockWalletSnapshotDate } from "./wallet-snapshot-lock.ts";

const upsertBalanceSample = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target and
  // EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet:writeBalanceSamples",
  purpose: "Upsert the day's balance sample per tracked asset on (sample_date, symbol).",
  callers: ["src/api/routes/pipeline"],
  probe: {
    statement: `INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, value_usd, provenance, strategy_nav_idle_only, sampled_at)
      VALUES ($1::date, $2, $3::numeric, $4::numeric, $5, $6::boolean, now())
      ON CONFLICT (sample_date, symbol) DO UPDATE SET
        amount = EXCLUDED.amount, value_usd = EXCLUDED.value_usd, provenance = EXCLUDED.provenance,
        strategy_nav_idle_only = EXCLUDED.strategy_nav_idle_only, sampled_at = EXCLUDED.sampled_at,
        id = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.id ELSE EXCLUDED.id END,
        price_usd = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.price_usd ELSE EXCLUDED.price_usd END,
        snapshot_run_id = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.snapshot_run_id ELSE EXCLUDED.snapshot_run_id END,
        amount_observed_at = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.amount_observed_at ELSE EXCLUDED.amount_observed_at END,
        price_observed_at = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.price_observed_at ELSE EXCLUDED.price_observed_at END,
        recorded_at = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.recorded_at ELSE EXCLUDED.recorded_at END,
        superseded_at = NULL`,
    params: ["2026-01-01", "PROBE", "1", "1", "live", false],
  },
});

const upsertSleeveSample = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target and
  // EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet:writeSleeveSamples",
  purpose: "Upsert the day's sample per sleeve wallet and asset on (sample_date, wallet_address, symbol).",
  callers: ["src/api/routes/pipeline"],
  probe: {
    statement: `INSERT INTO wallet_sleeve_samples
        (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
      VALUES ($1::date, $2, $3, $4::numeric, $5::numeric, $6, now())
      ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
        amount = EXCLUDED.amount, value_usd = EXCLUDED.value_usd, provenance = EXCLUDED.provenance,
        sampled_at = EXCLUDED.sampled_at,
        id = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.id ELSE EXCLUDED.id END,
        price_usd = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.price_usd ELSE EXCLUDED.price_usd END,
        snapshot_run_id = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.snapshot_run_id ELSE EXCLUDED.snapshot_run_id END,
        amount_observed_at = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.amount_observed_at ELSE EXCLUDED.amount_observed_at END,
        price_observed_at = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.price_observed_at ELSE EXCLUDED.price_observed_at END,
        recorded_at = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.recorded_at ELSE EXCLUDED.recorded_at END,
        superseded_at = NULL`,
    params: ["2026-01-01", "0x0000000000000000000000000000000000000001", "PROBE", "1", "1", "live"],
  },
});

/** One live balance sample: an aggregate leg's amount and value, and its price row when it priced fresh this tick. */
export interface BalanceSampleRow {
  symbol: string;
  amount: number | null;
  valueUsd: number;
  provenance: string;
  strategyNavIdleOnly: boolean | null;
  assetPrice: AssetPriceWrite | null;
}

/** One live sleeve sample, and its price row when this tick is the symbol's first fresh read. */
export interface SleeveSampleRow {
  walletAddress: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  provenance: string;
  assetPrice: AssetPriceWrite | null;
}

/**
 * Write a day's balance samples and their price rows, in `tx`, under the
 * wallet snapshot date lock. Returns how many samples it wrote.
 *
 * D41 phase 4 (issue #927): price_usd is NOT written to wallet_balance_samples.
 * asset_prices is the sole write target for price data now that #850 switched
 * every read site to the join; leaving this column NULL on a live-sampled row
 * is deliberate, and value_usd still carries the fused amount*price product.
 *
 * D55 (6): a key the wallet repair pass superseded (ops/wallet-backfill.ts,
 * migration 0104) is live again once the sampler writes it, as the row the old
 * delete-and-insert would have let this INSERT create fresh. "Fresh" is every
 * column, not just the tombstone. A superseded row was archived to evidence
 * under its id while it was live, and the evidence tables hold UNIQUE
 * (original_id), so the revived row takes EXCLUDED's new id: keeping the old
 * one would make the day's next rewrite archive that id a second time and fail
 * 23505. Its price_usd and snapshot identity (snapshot_run_id and the three
 * *_observed_at / recorded_at columns) are the old version's too, so they reset
 * to what the INSERT gives a fresh row. A LIVE row keeps every column this
 * upsert never wrote. SET expressions read the pre-update row, so each CASE
 * sees the tombstone this statement clears.
 */
export async function writeBalanceSamples(tx: RegistryDb, sampleDate: string, rows: readonly BalanceSampleRow[]): Promise<number> {
  await lockWalletSnapshotDate(tx, sampleDate);
  for (const r of rows) {
    await on(tx, upsertBalanceSample)`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, value_usd, provenance, strategy_nav_idle_only, sampled_at)
      VALUES
        (${sampleDate}, ${r.symbol}, ${r.amount}, ${r.valueUsd}, ${r.provenance}, ${r.strategyNavIdleOnly}, now())
      ON CONFLICT (sample_date, symbol) DO UPDATE SET
        amount     = EXCLUDED.amount,
        value_usd  = EXCLUDED.value_usd,
        provenance = EXCLUDED.provenance,
        strategy_nav_idle_only = EXCLUDED.strategy_nav_idle_only,
        sampled_at = EXCLUDED.sampled_at,
        id = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.id ELSE EXCLUDED.id END,
        price_usd = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.price_usd ELSE EXCLUDED.price_usd END,
        snapshot_run_id = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.snapshot_run_id ELSE EXCLUDED.snapshot_run_id END,
        amount_observed_at = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.amount_observed_at ELSE EXCLUDED.amount_observed_at END,
        price_observed_at = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.price_observed_at ELSE EXCLUDED.price_observed_at END,
        recorded_at = CASE WHEN wallet_balance_samples.superseded_at IS NULL THEN wallet_balance_samples.recorded_at ELSE EXCLUDED.recorded_at END,
        superseded_at = NULL
    `;
    if (r.assetPrice) await writeAssetPrice(tx, r.assetPrice);
  }
  return rows.length;
}

/**
 * Write a day's sleeve samples and their price rows, in `tx`, under the wallet
 * snapshot date lock. Returns how many samples it wrote. price_usd and the D55
 * (6) revival follow writeBalanceSamples above.
 */
export async function writeSleeveSamples(tx: RegistryDb, sampleDate: string, rows: readonly SleeveSampleRow[]): Promise<number> {
  await lockWalletSnapshotDate(tx, sampleDate);
  for (const r of rows) {
    await on(tx, upsertSleeveSample)`
      INSERT INTO wallet_sleeve_samples
        (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
      VALUES
        (${sampleDate}, ${r.walletAddress}, ${r.symbol}, ${r.amount}, ${r.valueUsd}, ${r.provenance}, now())
      ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
        amount     = EXCLUDED.amount,
        value_usd  = EXCLUDED.value_usd,
        provenance = EXCLUDED.provenance,
        sampled_at = EXCLUDED.sampled_at,
        id = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.id ELSE EXCLUDED.id END,
        price_usd = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.price_usd ELSE EXCLUDED.price_usd END,
        snapshot_run_id = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.snapshot_run_id ELSE EXCLUDED.snapshot_run_id END,
        amount_observed_at = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.amount_observed_at ELSE EXCLUDED.amount_observed_at END,
        price_observed_at = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.price_observed_at ELSE EXCLUDED.price_observed_at END,
        recorded_at = CASE WHEN wallet_sleeve_samples.superseded_at IS NULL THEN wallet_sleeve_samples.recorded_at ELSE EXCLUDED.recorded_at END,
        superseded_at = NULL
    `;
    if (r.assetPrice) await writeAssetPrice(tx, r.assetPrice);
  }
  return rows.length;
}

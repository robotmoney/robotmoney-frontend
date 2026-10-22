// Every /api/pipeline/** read and ingestion operation, by name (issue 1034,
// decision D75).
//
// The pipeline worker names an operation in the path (`/api/pipeline/read/<name>`
// or `/api/pipeline/ingest/<name>`) and passes its arguments as a JSON array.
// Each entry runs a store function the api owns, as rm_app, on the batch pool:
// the worker never sends a statement, only a name from this table and values.
import { checkDomainParity, recordParityObservation } from "../analytics/cutover/parity.ts";
import { isParityDomain } from "../analytics/cutover/parity-domains.ts";
import type { RegistryDb } from "../db/registry.ts";
import { ingestOp, readOp, rowsAt, type PipelineOp } from "./op.ts";
import { assetPriceBackfillCandidateDays, assetPriceDayCompleteness, writeAssetPrice } from "../ops/asset-prices.ts";
import { lastPersistedHolding, walletHistoryRows } from "../chain/wallet-balances-store.ts";
import { recentPersistedPrice } from "../chain/wallet-persisted-price.ts";
import { buybackScanState, recordBuybackWindow } from "./stores/buybacks.ts";
import {
  activeCoins,
  activeDiscoveredCount,
  activeWallets,
  agentSnapshotsSince,
  deactivateMissing,
  discoveredRowCount,
  liveVaults,
  recomputeCoverageScores,
  recordVaultReads,
  snapshotDailyRollup,
  updateCoins,
  updateWalletBalances,
  upsertDiscovered,
  upsertRevenueRows,
  virtualsAgents,
} from "./stores/projects.ts";
import type { DiscoveredProject } from "../projects/access/data-source.ts";
import { upsertTokenMarketSample } from "./stores/token-market.ts";
import {
  addressFloorGet,
  addressFloorSet,
  bumpDeferStreak,
  dayBlockGet,
  dayBlockSet,
  deferDayUpdate,
  gapReports,
  inspectSnapshot,
  planState,
  priorState,
  readAttemptCount,
  recordState,
  writeRepairedDay,
} from "./stores/wallet-backfill.ts";
import { livePayloadField } from "./queue-store.ts";
import type { ManifestKeys, RepairedDayWrite } from "../ops/wallet-backfill.ts";
import { writeBalanceSamples, writeSleeveSamples } from "./stores/wallet.ts";
import { upsertAdapterSamples, upsertSharePriceSample } from "./stores/vault.ts";

/** analytics.parity_sweep: one domain's set-based comparison and its observation (issue 1375). */
async function paritySweepDomain(tx: RegistryDb, domain: unknown): Promise<unknown> {
  if (!isParityDomain(domain)) throw new Error(`analytics.parity_sweep: unknown domain ${JSON.stringify(domain)}`);
  const started = performance.now();
  const result = await checkDomainParity(domain, tx);
  await recordParityObservation(result, tx);
  return {
    domain,
    matched: result.matched,
    legacyRowCount: result.legacyRowCount,
    ledgerRowCount: result.ledgerRowCount,
    mismatchCount: result.mismatchCount,
    durationMs: Math.round(performance.now() - started),
  };
}

export const PIPELINE_OPS: Readonly<Record<string, PipelineOp>> = Object.freeze({
  "analytics.parity_sweep": ingestOp(paritySweepDomain),
  "asset_prices.backfill_candidate_days": readOp(assetPriceBackfillCandidateDays),
  "asset_prices.day_completeness": readOp(assetPriceDayCompleteness),
  "asset_prices.write": ingestOp(writeAssetPrice),
  "buybacks.record_window": ingestOp(recordBuybackWindow, rowsAt(0)),
  "buybacks.scan_state": readOp(buybackScanState),
  "gaps.reports": readOp(gapReports),
  "projects.active_coins": readOp(activeCoins),
  "projects.active_discovered_count": readOp(activeDiscoveredCount),
  "projects.active_wallets": readOp(activeWallets),
  "projects.agent_snapshots_since": readOp(agentSnapshotsSince),
  // The keep list names the roster; it writes no row of its own (op.ts).
  "projects.deactivate_missing": ingestOp(deactivateMissing, () => 0),
  "projects.live_vaults": readOp(liveVaults),
  // Rolls up persisted state in one transaction; the request carries no rows.
  "projects.recompute_coverage": ingestOp(recomputeCoverageScores, () => 0),
  "projects.record_vault_reads": ingestOp(recordVaultReads, (args) => rowsAt(1)(args) + rowsAt(2)(args)),
  "projects.snapshot_daily": ingestOp(snapshotDailyRollup, () => 0),
  "projects.update_coins": ingestOp(updateCoins, rowsAt(0)),
  "projects.update_wallet_balances": ingestOp(updateWalletBalances, rowsAt(0)),
  "projects.upsert_discovered": ingestOp(upsertDiscovered, (args) =>
    Array.isArray(args[0]) ? discoveredRowCount(args[0] as DiscoveredProject[]) : 0,
  ),
  "projects.upsert_revenue": ingestOp(upsertRevenueRows, rowsAt(0)),
  "projects.virtuals_agents": readOp(virtualsAgents),
  "queue.live_payload_field": readOp(livePayloadField),
  "token_market.sample": ingestOp(upsertTokenMarketSample),
  "vault.share_price": ingestOp(upsertSharePriceSample),
  "vault.adapter_samples": ingestOp(upsertAdapterSamples, rowsAt(0)),
  "wallet.balance_samples": ingestOp(writeBalanceSamples, rowsAt(1)),
  "wallet_backfill.address_floor_get": readOp(addressFloorGet),
  "wallet_backfill.address_floor_set": ingestOp(addressFloorSet),
  "wallet_backfill.bump_defer_streak": ingestOp(bumpDeferStreak),
  "wallet_backfill.day_block_get": readOp(dayBlockGet),
  "wallet_backfill.day_block_set": ingestOp(dayBlockSet),
  "wallet_backfill.defer_day": ingestOp(deferDayUpdate),
  // Unlocked: the locked read runs only inside the day write.
  "wallet_backfill.inspect": readOp((db, date: string, keys: ManifestKeys) => inspectSnapshot(db, date, keys)),
  "wallet_backfill.plan_state": readOp(planState),
  "wallet_backfill.prior_state": readOp(priorState),
  "wallet_backfill.read_attempts": readOp(readAttemptCount),
  "wallet_backfill.record_state": ingestOp(recordState),
  "wallet_backfill.write_day": ingestOp(writeRepairedDay, (args) => {
    const input = args[0] as Partial<RepairedDayWrite> | undefined;
    return (input?.balances?.length ?? 0) + (input?.sleeves?.length ?? 0);
  }),
  "wallet.history_rows": readOp(walletHistoryRows),
  "wallet.last_persisted_holding": readOp(lastPersistedHolding),
  "wallet.recent_persisted_price": readOp(recentPersistedPrice),
  "wallet.sleeve_samples": ingestOp(writeSleeveSamples, rowsAt(1)),
});

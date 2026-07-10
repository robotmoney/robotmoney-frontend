// Thin HTTP adapters for the dashboard surfaces. All query + DTO logic lives in
// the analytics report stage (analytics/report/projections.ts); these handlers
// only parse/clamp request params and forward. API paths, DTOs, and response
// shapes are unchanged.
import { fetchRegimeSnapshots, fetchLatestResearchSignal } from "../../analytics/report/projections.ts";
import { fetchVaultEconomics } from "../../chain/vault-economics.ts";
import { fetchWalletBalances } from "../../chain/wallet-balances.ts";
// Live-data contract (#50 honesty): each chain/db module owns its own short-TTL
// cache + degrade-to-stale/seed logic, so these handlers stay thin adapters.
// The module functions share names with our handlers, so import them aliased.
import { getBuybacks as fetchBuybacks } from "../../chain/buyback-logs.ts";
import { getTokenMetrics as fetchTokenMetrics } from "../../chain/token-metrics.ts";
import { getWalletSleeves as fetchWalletSleeves } from "../../chain/wallet-sleeves.ts";
import { getAllocationFramework } from "../../chain/allocation-framework.ts";

// GET /api/dashboards/research-signals/:key → latest research signal payload
export async function getResearchSignal(key: string) {
  return fetchLatestResearchSignal(key);
}

// GET /api/dashboards/vault-economics → live Base RPC vault economics (TVL,
// share price, adapters, 7-day APY), degraded/stale on RPC failure.
export async function getVaultEconomics() {
  return fetchVaultEconomics();
}

// GET /api/dashboards/wallet-balances → live Base RPC + keyless-price prop-wallet
// valuation (issue #84): per-holding value/provenance + continuous history. A
// single failing leg degrades to 'stale', never a 5xx.
export async function getWalletBalances() {
  return fetchWalletBalances();
}

// GET /api/dashboards/regime-snapshots?range=<n days> → { latest, history }
export async function getRegimeSnapshots(url: URL) {
  const n = Math.trunc(Number(url.searchParams.get("range") ?? 180));
  const range = Number.isFinite(n) ? Math.min(3650, Math.max(1, n)) : 180;
  return fetchRegimeSnapshots(range);
}

// GET /api/dashboards/buybacks → token buyback history (ROBOTMONEY Transfer logs
// into the primary prop wallet + WETH/USD swap legs). Live eth_getLogs read;
// degrades to persisted 'stale' rows / 'seed' backfill, never a fabricated total.
export async function getBuybacks() {
  return fetchBuybacks();
}

// GET /api/dashboards/token-metrics → ROBOTMONEY price/supply/marketCap +
// fixed Clanker-pool fee split. A failed supply/price leg → that field null +
// stale:true, never a fabricated price.
export async function getTokenMetrics() {
  return fetchTokenMetrics();
}

// GET /api/dashboards/wallet-sleeves → per-prop-wallet holdings breakdown (fresh
// per-wallet balance reads; the aggregate wallet-balances table has no wallet
// dimension). Per-holding provenance mirrors #50; a failed leg → value null.
export async function getWalletSleeves() {
  return fetchWalletSleeves();
}

// GET /api/dashboards/allocation → admin/committee-managed strategy + bucket
// target weights from the allocation_framework table (managed:true, no chain
// read, no AI enrichment). Static until an admin rewrites the row.
export async function getAllocation() {
  return getAllocationFramework();
}

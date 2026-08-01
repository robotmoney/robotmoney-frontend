// Thin HTTP adapters for the dashboard surfaces. All query + DTO logic lives in
// the analytics report stage (analytics/report/projections.ts); these handlers
// only parse/clamp request params and forward. API paths, DTOs, and response
// shapes are unchanged.
import { fetchRegimeSnapshots, fetchLatestResearchSignal } from "../../analytics/report/projections.ts";
import { fetchVaultEconomics } from "../../chain/vault-economics.ts";
import { fetchPersistedWalletBalances } from "../../chain/wallet-balances.ts";
// Live-data contract (#50 honesty): each chain/db module owns its own short-TTL
// cache + degrade-to-stale/seed logic, so these handlers stay thin adapters.
// The module functions share names with our handlers, so import them aliased.
import { getBuybacks as fetchBuybacks } from "../../chain/buyback-logs.ts";
import { getTokenMetrics as fetchTokenMetrics } from "../../chain/token-metrics.ts";
import { getWalletSleeves as fetchWalletSleeves } from "../../chain/wallet-sleeves.ts";
import { getAllocationFramework } from "../../chain/allocation-framework.ts";
import { fetchEntities, fetchMarketOverview } from "../../projects/entities-projections.ts";
import { fetchList2 } from "../../projects/list2-projections.ts";
import { fetchLeaderboard } from "../../projects/leaderboard-projections.ts";
import { fetchActivityLog } from "../../projects/activity-log-projections.ts";
import { fetchAgentsDirectory } from "../../projects/agents-projections.ts";

// GET /api/dashboards/research-signals/:key → latest research signal payload
export async function getResearchSignal(key: string) {
  return fetchLatestResearchSignal(key);
}

// GET /api/dashboards/vault-economics → live Base RPC vault economics (TVL,
// share price, adapters, 7-day APY), degraded/stale on RPC failure.
export async function getVaultEconomics() {
  return fetchVaultEconomics();
}

// GET /api/dashboards/wallet-balances → prop-wallet valuation (issue #84) served
// PURELY from persisted samples (issue #118): ZERO RPC on the request path. Chain
// reads happen only on the backend schedule (worker/handlers/wallet.ts), so a
// client request never hits the rate-limited public RPC. Per-holding value/
// provenance reflects the last scheduled sample exactly (live/stub/stale/seed);
// a symbol with no sample yet is 'stale' with null values, never a 5xx.
export async function getWalletBalances() {
  return fetchPersistedWalletBalances();
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

// GET /api/dashboards/allocation → admin/swarm-managed strategy + bucket
// target weights from the allocation_framework table (managed:true, no chain
// read, no AI enrichment). Static until an admin rewrites the row.
export async function getAllocation() {
  return getAllocationFramework();
}

// GET /api/dashboards/entities → the /list "Total Market" unified table feed
// (issue #384, docs/bot-analytics-ui-port-plan.md §5.1): one row per tracked
// agent/coin/vault/wallet, spanning every project (not the /projects
// directory's MIN_SCORE gate — see entities-projections.ts header). Never
// synthetic: a fresh DB with empty facet tables returns `{ entities: [] }`.
export async function getEntities() {
  return fetchEntities();
}

// GET /api/dashboards/overview → /list's TotalMarketOverview summary (counts,
// vault TVL + 7d sparkline, total AUM, per-type leaders, avg agent
// productivity, and the ROBOTMONEY ticker card sourced from the same
// getTokenMetrics() as /allocation — no new price feed).
export async function getMarketOverview() {
  return fetchMarketOverview();
}

// GET /api/dashboards/list2 → "List v2 (WIP)" per-facet-tab table feed
// (issue #387, docs/bot-analytics-ui-port-plan.md §5.2, P2.6). Never
// synthetic: a fresh DB with empty facet tables returns empty arrays per tab.
export async function getList2() {
  return fetchList2();
}

// GET /api/dashboards/leaderboard → "List v3 · Money Agents" leaderboard +
// evidence (issue #387, §5.3, P2.7). Computed per-request over real facet
// data (D8: no materialized view here) — see leaderboard-projections.ts for
// the scoring formula and its documented fidelity notes.
export async function getLeaderboard() {
  return fetchLeaderboard();
}

// GET /api/dashboards/activity → the /market + /dashboard TerminalFeed
// (issue #392, docs/bot-analytics-ui-port-plan.md §5.6): agent activity log
// feed. Never synthetic: a fresh DB with an empty agent_activity_log table
// returns `{ entries: [] }` until a pipeline writer lands (P1.6).
export async function getActivityLog() {
  return fetchActivityLog();
}

// GET /api/dashboards/agents → the /agents "OpenClaw Agents" directory feed
// (issue #385, docs/bot-analytics-ui-port-plan.md §5.7, P2.2): one row per
// tracked agent with all three selectable sparkline series precomputed, plus
// the summary strip (active/idle counts, x402 txns/volume, total balance).
// Never synthetic: a fresh DB with an empty openclaw_agents table returns
// `{ agents: [], summary: { active: 0, idle: 0, x402Txns: 0, x402VolumeUsd: 0, totalBalanceUsd: 0 } }`.
export async function getAgentsDirectory() {
  return fetchAgentsDirectory();
}

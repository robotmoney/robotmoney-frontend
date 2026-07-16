// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { makeAnalyticsHandlers } from "./analytics.ts";
import { refreshBuybacks } from "./buybacks.ts";
import * as committee from "./committee.ts";
import * as projects from "./projects.ts";
import { sampleSharePrice } from "./vault.ts";
import { sampleWalletBalances } from "./wallet.ts";

// `jobId` is the claimed job's row id (loop.ts passes `job.id`). It is optional
// and source-compatible: existing handlers that only take `payload` remain
// valid JobHandlers (JS ignores the extra arg), while handlers that need to
// link their output back to the originating job (e.g. analytics telemetry,
// issue #179) can accept it as a second parameter.
export type JobHandler = (payload: Record<string, unknown>, jobId?: number) => Promise<unknown>;

const analytics = makeAnalyticsHandlers();

export const handlers: Record<string, JobHandler> = {
  // smoke-test handler
  noop: async (payload) => ({ noop: true, echo: payload }),
  // regime-only classification → regime_snapshots (analytics lane). The old
  // combined `analytics.run` kind is RETIRED (issue #107): regime and research
  // are distinct kinds so a slow research fetch can never starve regime work.
  "regime.classify": analytics.regimeClassify,
  // research signals only → research_signals (research lane)
  "research.refresh": analytics.researchRefresh,
  // hourly vault share-price sample (feeds the 7-day APY calc)
  "vault.sample_share_price": sampleSharePrice,
  // daily prop-wallet balance sample (feeds the /performance history + last-live fallback)
  "wallet.sample_balances": sampleWalletBalances,
  // periodic buyback refresh — eth_getLogs indexer upserting buyback_swaps (no-op under a non-live source)
  "buybacks.refresh": refreshBuybacks,
  // committee session lifecycle
  "committee.open_session": committee.openSession,
  "committee.publish_brief": committee.publishBrief,
  "committee.close_window": committee.closeWindow,
  "committee.aggregate": committee.aggregateSession,
  "committee.publish": committee.publishSession,
  // projects "Agentic Economy Ecosystem" data pipelines (issue #87). Ported from
  // the deprecated bot-analytics edge functions onto the kind→handler pattern.
  // discover/refreshCoins/refreshWallets/syncRevenue/fetchVaults each already
  // declare their OWN second parameter — a `ProjectsDataSource` test-injection
  // seam (default `selectProjectsDataSource()`), unrelated to the job id — so
  // they are wrapped down to single-arity here rather than passed directly:
  // registering them as-is would let loop.ts's `job.id` (a number) flow into
  // that `source` slot, which is both a type error against the widened
  // `JobHandler` and a runtime miswiring.
  "projects.discover": (payload) => projects.discover(payload),
  "projects.refresh_coins": (payload) => projects.refreshCoins(payload),
  "projects.refresh_wallets": (payload) => projects.refreshWallets(payload),
  "projects.sync_revenue": (payload) => projects.syncRevenue(payload),
  "projects.snapshot_daily": projects.snapshotDaily,
  "projects.fetch_vaults": (payload) => projects.fetchVaults(payload),
  "projects.recompute_coverage": projects.recomputeCoverage,
};

export function getHandler(kind: string): JobHandler | undefined {
  return handlers[kind];
}

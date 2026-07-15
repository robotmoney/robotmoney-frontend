// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { makeAnalyticsHandlers } from "./analytics.ts";
import { refreshBuybacks } from "./buybacks.ts";
import * as committee from "./committee.ts";
import * as projects from "./projects.ts";
import { sampleSharePrice } from "./vault.ts";
import { sampleWalletBalances } from "./wallet.ts";

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

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
  "projects.discover": projects.discover,
  "projects.refresh_coins": projects.refreshCoins,
  "projects.refresh_wallets": projects.refreshWallets,
  "projects.sync_revenue": projects.syncRevenue,
  "projects.snapshot_daily": projects.snapshotDaily,
  "projects.fetch_vaults": projects.fetchVaults,
  "projects.recompute_coverage": projects.recomputeCoverage,
};

export function getHandler(kind: string): JobHandler | undefined {
  return handlers[kind];
}

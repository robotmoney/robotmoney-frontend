// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { makeAnalyticsHandlers } from "./analytics.ts";
import { refreshBuybacks } from "./buybacks.ts";
import * as swarm from "./swarm.ts";
import * as projects from "./projects.ts";
import { backfillWalletDay, backfillWalletWindow, repairGaps } from "./repair.ts";
import { sampleSharePrice, sampleVaultAdapters } from "./vault.ts";
import { sampleWalletBalances, sampleWalletSleeves } from "./wallet.ts";

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
  "vault.sample_adapters": sampleVaultAdapters,
  // daily prop-wallet balance sample (feeds the /performance history + last-live fallback)
  "wallet.sample_balances": sampleWalletBalances,
  "wallet.sample_sleeves": sampleWalletSleeves,
  // The self-healing pair (issue #709). `ops.repair_gaps` is the dispatcher of
  // docs/technical/markets-asset-pricing-ingest.md §4.1 — it asks the gap detector what is
  // missing and dispatches by remediationClass, which is what turns that field
  // from a label into behaviour. `wallet.backfill_window` is the Class C
  // executor: a window of days per job, each read at its OWN block and written
  // only if that whole day read honestly.
  //
  // The window is a BATCHING unit, not a blast radius — the provider meters HTTP
  // hits, so a window resolves its blocks in lockstep and loads its price range
  // once, while each day keeps its own transaction, its own checkpoint and its
  // own failure. `wallet.backfill_day` is retained (unchanged, and now the N=1
  // case of the same executor) so rows enqueued by a pre-upgrade dispatcher
  // still drain.
  "ops.repair_gaps": repairGaps,
  "wallet.backfill_window": backfillWalletWindow,
  "wallet.backfill_day": backfillWalletDay,
  // periodic buyback refresh — eth_getLogs indexer upserting buyback_swaps (no-op under a non-live source)
  "buybacks.refresh": refreshBuybacks,
  // swarm session lifecycle
  "swarm.open_session": swarm.openSession,
  "swarm.publish_brief": swarm.publishBrief,
  "swarm.close_window": swarm.closeWindow,
  "swarm.aggregate": swarm.aggregateSession,
  "swarm.judge": swarm.judgeSession,
  "swarm.publish": swarm.publishSession,
  // Three notification kinds, one delivery body. They stay separate registry
  // entries rather than collapsing into a shared "swarm.send_notification"
  // because `kind` is what an operator greps in `jobs`/`job_runs` when a mail
  // did not arrive, and "the receipt lane is backed up" is a different incident
  // from "approvals are not going out".
  "swarm.send_application_received_notification": swarm.sendApplicationReceivedNotification,
  "swarm.send_activation_notification": swarm.sendActivationNotification,
  "swarm.send_seat_open_notification": swarm.sendSeatOpenNotification,
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

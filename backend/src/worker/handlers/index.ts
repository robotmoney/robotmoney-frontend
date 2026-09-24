// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { makeAnalyticsHandlers } from "./analytics.ts";
import { refreshBuybacks } from "./buybacks.ts";
import * as projects from "./projects.ts";
import { backfillWalletDay, backfillWalletWindow, repairGaps } from "./repair.ts";
import { sampleSharePrice, sampleVaultAdapters } from "./vault.ts";
import { sampleWalletBalances, sampleWalletSleeves } from "./wallet.ts";
import { backfillAssetPricesForCleanDays } from "../../ops/asset-prices.ts";
// Issue #979 fix: NEVER import analytics/cutover/parity.ts here — it imports
// db/client.ts (the rm_app-credentialed API pool), and worker/** must never
// hold that pool, even transitively (see db migration 0060's REVOKE + the
// analytics-api-boundary transitive-reachability test). triggerParitySweep()
// is the authenticated-HTTP call to the API process instead, the same
// worker→API pattern analyticsApiClient() already uses for #977/#978.
import { triggerParitySweep } from "../../analytics/api-client.ts";

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
  // Retroactive asset_prices coverage backfill (issue #927): the live
  // sampler's dual-write (below) only covers days sampled AFTER this ships,
  // so existing history still has the #849 coverage gap until something
  // walks it. SELF-HEALING MEANS SCHEDULED, NOT MANUAL, same as
  // `ops.repair_gaps` above — a one-shot script run by hand would never
  // reach a day added by a future rebuild or an outage backfill, so this is
  // a cron row (db/seed.ts) instead. Bounded per run
  // (ops/asset-prices.ts::ASSET_PRICE_BACKFILL_MAX_DAYS_PER_RUN); an
  // already-covered day is never re-selected, so a caught-up deployment's
  // run is just the anti-join query.
  "ops.backfill_asset_prices": () => backfillAssetPricesForCleanDays(),
  // Issue #979 AC2: the dual-write parity sweep. recordParityObservation()/
  // runParitySweep() (analytics/cutover/parity.ts) are the ONLY thing that
  // populates analytics_parity_observations, which is the evidence
  // analytics-ledger-cutover-gate.ts later reads — that CLI only evaluates
  // existing observations and flips analytics_read_mode, it never records
  // one. Without a real recurring caller here, that table stays permanently
  // empty and ledger-mode reads can never be armed. Same
  // self-healing-means-scheduled shape as `ops.backfill_asset_prices` above:
  // every domain's check both re-derives its own row counts/checksums from
  // Postgres AND inserts a fresh observation row each tick, so this is cheap
  // and safe to run often — hourly is far more than the gate's default
  // 12-observation / 24h window needs, which lets the window close in about
  // half a day instead of waiting on a slower cadence.
  //
  // WIRING (issue #979 fix): this handler never touches Postgres itself. It
  // calls POST /api/analytics/parity-sweep (triggerParitySweep(),
  // analytics/api-client.ts) over the SAME authenticated HTTP boundary the
  // retained analytics handlers above already use — runParitySweep() runs
  // INSIDE the API process, which legitimately holds the rm_app pool.
  "analytics.parity_sweep": () => triggerParitySweep(),
  // periodic buyback refresh — eth_getLogs indexer upserting buyback_swaps (no-op under a non-live source)
  "buybacks.refresh": refreshBuybacks,
  // NO SESSION-LIFECYCLE KINDS ARE REGISTERED HERE. Session work is not queue
  // work any more: system-scheduler-spec.md §4 gives the lifecycle a different
  // shape — the `system-scheduler` container drives a subject's epoch through
  // the API, and §1/§7 put every step that needs a model in a participant
  // container, because the scheduler "calls no model, so it has no model key".
  // A registration here would put one back inside a process that holds the
  // database credential.
  // The three swarm email delivery kinds (application receipt, activation
  // approval, waitlist seat-open) were REMOVED with the swarm email feature
  // itself — issue #1026 W5, decision D50 reversing D30. Nothing enqueues them
  // any more and migration 0066 drops the outbox they delivered from; 0066 is
  // also the one place their names still appear, because it settles any row a
  // pre-0066 deployment left queued. Leaving the kinds unregistered is the right
  // end state: loop.ts fails a job whose kind has no handler.
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

// Idempotent seed of the consumer worker's queue schedules. Analytics production
// cadence moved to the independent producer (D25); regime.classify and
// research.refresh rows remain disabled compatibility markers and every seed
// run also dead-letters legacy pending/running jobs. UPSERTs on the natural key
// (kind, cron) from migration 0005, so repeated runs never duplicate rows.
//
// Dev-safe: every seeded schedule's handler upserts on natural keys, so an
// extra firing is harmless. We DO NOT touch next_run_at / enabled on an
// existing row — that lets the scheduler own slot bookkeeping and lets an
// operator disable a schedule without the seed re-enabling it.
import { sql, closeDb, jsonValue } from "./client.ts";
import { on, registerQuery, type RegistryDb } from "./registry.ts";
import { requireRehearsalTarget } from "../deploy-policy.ts";
import { populatedTables, readIdentityKind, loadSnapshot } from "./schema-snapshot.ts";
import { withMutationFence } from "./target-lock.ts";
import { seedLiveRoster, pruneToLiveRoster, backfillMemberHandles } from "../swarm/roster-seed.ts";
import { seedSmokeProjects } from "../projects/smoke-seed.ts";
import { walletHistorySeedRows } from "../chain/wallet-history-seed.ts";
import { ALLOCATION_FRAMEWORK_SEED } from "../chain/allocation-framework.ts";

// ─────────────────────────────────────────────────────────────────────────────
// EVERY STATEMENT BELOW IS A REGISTERED QUERY (smoke-production-spec.md §7.1),
// AND ITS ROLE IS `rm_owner` — DECIDED, NOT A PLACEHOLDER (#1026 w3-lifecycle-db).
//
// Three entry modules run the seed, and every one of them holds `rm_owner`:
//   - `bun smoke --seed` (scripts/lib/smoke-main.ts) runs it from the HOST as
//     authorized preparation, through backend/scripts/smoke-prepare.ts, logged
//     in as `rm_owner` (the password smoke generated for a local instance, the
//     typed one on a remote rehearsal) and INSIDE the §2 mutation fence
//     (`withMutationFence`): "Every mutation (migration, grant reconciliation,
//     seed, …) runs in a transaction that first takes `pg_advisory_xact_lock`".
//     It no longer runs inside the `api` container on that container's `rm_app`
//     credential: backend/schema/grants.sql gives `rm_app` no DELETE on
//     ordinary tables, so the two `job_schedules` retirement DELETEs below were
//     refused there on a snapshot-built database.
//   - `bun run src/db/seed.ts [--smoke-schedules]`, run directly with an
//     `rm_owner` DATABASE_URL, also fenced (the block at the bottom).
//   - scripts/prod-bootstrap's seed step, on the credential that also migrates.
// An UPDATE or DELETE declares SELECT too, because Postgres checks a WHERE
// clause's columns as a read.
//
// THE GATE. `--seed` "creates demo data on a blank database. It is explicit,
// refuses a populated database, requires `rehearsal`, and is never implied by
// any mode" (spec §5). `assertSeedable` below is that gate, and the smoke runs it
// in the same fenced transaction as the seed, so nothing can populate the
// database between the check and the write.
// ─────────────────────────────────────────────────────────────────────────────
const SEED_CALLERS = ["src/db/seed", "scripts/prod-bootstrap", "scripts/smoke-prepare"];
const SMOKE_CALLERS = ["src/db/seed", "scripts/smoke-prepare"];

const insertSchedule = registerQuery({
  role: "rm_owner",
  object: "job_schedules",
  privileges: ["INSERT"],
  site: "src/db/seed:seedJobSchedules.insert",
  purpose: "Insert each canonical schedule once, never overwriting the scheduler-managed columns of an existing row.",
  callers: SEED_CALLERS,
});

const disableProducerSchedules = registerQuery({
  role: "rm_owner",
  object: "job_schedules",
  privileges: ["UPDATE", "SELECT"],
  site: "src/db/seed:seedJobSchedules.disableProducer",
  purpose: "Disable the retired consumer-DB regime/research schedules an older deployment left enabled.",
  callers: SEED_CALLERS,
});

const deadLetterProducerJobs = registerQuery({
  role: "rm_owner",
  object: "jobs",
  privileges: ["UPDATE", "SELECT"],
  site: "src/db/seed:seedJobSchedules.deadLetterProducer",
  purpose: "Dead-letter pending or running regime/research jobs the independent producer now owns.",
  callers: SEED_CALLERS,
});

const deleteAnalyticsRunSchedule = registerQuery({
  role: "rm_owner",
  object: "job_schedules",
  privileges: ["DELETE", "SELECT"],
  site: "src/db/seed:seedJobSchedules.deleteAnalyticsRun",
  purpose: "Delete the retired combined analytics.run schedule rows (issue #107).",
  callers: SEED_CALLERS,
});

const deadLetterAnalyticsRunJobs = registerQuery({
  role: "rm_owner",
  object: "jobs",
  privileges: ["UPDATE", "SELECT"],
  site: "src/db/seed:seedJobSchedules.deadLetterAnalyticsRun",
  purpose: "Dead-letter not-yet-terminal jobs of the retired analytics.run kind (issue #107).",
  callers: SEED_CALLERS,
});

const deleteHourlyRepairSchedule = registerQuery({
  role: "rm_owner",
  object: "job_schedules",
  privileges: ["DELETE", "SELECT"],
  site: "src/db/seed:seedJobSchedules.deleteHourlyRepair",
  purpose: "Delete the superseded hourly ops.repair_gaps row so exactly one repair cadence remains.",
  callers: SEED_CALLERS,
});

const insertSmokeSchedule = registerQuery({
  role: "rm_owner",
  object: "job_schedules",
  privileges: ["INSERT"],
  site: "src/db/seed:seedSmokeJobSchedules.insert",
  purpose: "Insert the smoke's quota-safe schedule rows once, idempotently.",
  callers: SMOKE_CALLERS,
});

const disableSmokeSchedule = registerQuery({
  role: "rm_owner",
  object: "job_schedules",
  privileges: ["UPDATE", "SELECT"],
  site: "src/db/seed:seedSmokeJobSchedules.disable",
  purpose: "Disable the per-minute samplers, the superseded fast rows and coverage recompute on a smoke database.",
  callers: SMOKE_CALLERS,
});

const enqueueColdStart = registerQuery({
  role: "rm_owner",
  object: "jobs",
  privileges: ["INSERT"],
  site: "src/db/seed:seed.coldStart",
  purpose: "Enqueue one cold-start job per sampler and the gap repair, at most once per database via a constant dedupe_key.",
  callers: SEED_CALLERS,
});

const insertWalletHistorySeed = registerQuery({
  role: "rm_owner",
  object: "wallet_balance_samples",
  privileges: ["INSERT"],
  site: "src/db/seed:backfillWalletHistory",
  purpose: "Insert the pre-launch prop-wallet history, provenance 'seed', never clobbering a live sample.",
  callers: SEED_CALLERS,
});

const insertAllocationFramework = registerQuery({
  role: "rm_owner",
  object: "allocation_framework",
  privileges: ["INSERT"],
  site: "src/db/seed:seed.allocationFramework",
  purpose: "Fill the single allocation_framework row on an empty table, never overwriting an admin rewrite.",
  callers: SEED_CALLERS,
});

type CatchupPolicy = "all" | "collapse-per-bucket";

interface SeedSchedule {
  kind: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  enabled: boolean;
  // Issue #651: defaults to 'all' (every missed slot gets its own catch-up
  // job — current behaviour) when omitted. Only the wallet samplers below
  // opt into 'collapse-per-bucket' — see migration 0034's header for why.
  catchupPolicy?: CatchupPolicy;
}

// Keep this list small and harmless. Each kind MUST have a handler registered in
// backend/src/worker/handlers/index.ts and be idempotent on natural keys.
//
// Session scheduling is NOT in this list and has no row here at all. Per
// docs/technical/system-scheduler-spec.md §2.2 a subject's epoch duration is
// its entire schedule, so the cadence lives on the subject and is driven by
// `system-scheduler` — there is nothing in job_schedules to seed for it.
// Exported so tests can assert the production seed is byte-for-byte this list.
export const SCHEDULES: SeedSchedule[] = [
  // Retired consumer-queue compatibility rows. The independent producer owns
  // these cadences; seedJobSchedules() enforces enabled=false even on rows
  // left enabled by an older deployment.
  { kind: "regime.classify", cron: "30 22 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "research.refresh", cron: "0 23 * * *", payload: {}, timezone: "UTC", enabled: false },
  // Hourly vault share-price sample (issue #40) — dense enough for a 7-day APY
  // lookback, cheap on RPC (3 eth_calls/hour). Handler: worker/handlers/vault.ts.
  { kind: "vault.sample_share_price", cron: "0 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "vault.sample_adapters", cron: "0 * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Prop-wallet balance sample (issues #84/#118) — the ONLY place a chain read
  // happens for wallet balances now (the request path serves persisted data with
  // ZERO RPC). Runs EVERY MINUTE so the served payload is near-real-time; the
  // (sample_date, symbol) upsert refreshes today's row each tick (idempotent, no
  // row growth within a day). Handler: worker/handlers/wallet.ts.
  //
  // catchupPolicy 'collapse-per-bucket' (issue #651): every missed same-day
  // slot would upsert the SAME (sample_date, symbol) row via its own live
  // chain read — a per-minute schedule down for hours does dozens of
  // redundant RPC reads on restart for one day's worth of data. Collapsing to
  // the last due slot per UTC day keeps the result identical (same row, same
  // upsert) at a fraction of the chain reads.
  { kind: "wallet.sample_balances", cron: "* * * * *", payload: {}, timezone: "UTC", enabled: true, catchupPolicy: "collapse-per-bucket" },
  { kind: "wallet.sample_sleeves", cron: "* * * * *", payload: {}, timezone: "UTC", enabled: true, catchupPolicy: "collapse-per-bucket" },
  // Buyback refresh (live-data contract §1) — eth_getLogs indexer that upserts
  // NEW WETH->ROBOTMONEY buyback swaps into buyback_swaps (keyed on tx_hash). No-op
  // under a non-live source; degrade-safe on RPC failure. Handler: handlers/buybacks.ts.
  { kind: "buybacks.refresh", cron: "15 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Self-healing dispatcher (issue #709). Asks the gap detector what is missing
  // and enqueues ONE wallet.backfill_window job carrying the days it picked,
  // bounded per run (#739 — the provider meters HTTP hits, so a window that
  // resolves its days in lockstep costs a fraction of one job per day).
  // EVERY 5 MINUTES so a gap converges in minutes instead of hours, and cheap
  // when there is nothing to do (two detector queries and no chain read). Since
  // the transport now paces from a conservative default
  // (chain/base-rpc-client.ts), this DOES dispatch on an ordinary live
  // deployment — that is the point of the feature — and is a NO-OP only where
  // an operator has set BASE_RPC_MAX_CALLS_PER_SEC=0. A hermetic smoke/CI boot
  // reads BASE_RPC_SOURCE=stub, so its sweep costs no provider budget.
  // Handler: worker/handlers/repair.ts.
  { kind: "ops.repair_gaps", cron: "*/5 * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Retroactive asset_prices coverage backfill (issue #927, markets §8.1). The
  // live sampler's forward dual-write (worker/handlers/wallet.ts) only covers
  // days sampled after that change deployed; this cron is what closes the gap
  // for history that predates it, and for any day whose forward dual-write
  // failed (e.g. a pool-resolution hiccup) — same "converges over successive
  // runs, bounded per run" shape as ops.repair_gaps, not a one-shot script.
  // Every 15 minutes: less urgent than chain-derived wallet gaps above (a
  // day's asset_prices row does not block a read — the three join sites still
  // fall back to the sample row's own price/value while it is missing), and
  // the anti-join query is cheap to run against a caught-up deployment.
  // Handler: worker/handlers/index.ts → ops/asset-prices.ts::backfillAssetPricesForCleanDays.
  { kind: "ops.backfill_asset_prices", cron: "*/15 * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Issue #979 AC2: dual-write parity sweep — the ONLY production caller of
  // recordParityObservation()/runParitySweep() (analytics/cutover/parity.ts),
  // which is what populates analytics_parity_observations. That table is the
  // evidence backend/scripts/analytics-ledger-cutover-gate.ts reads before
  // ledger-mode reads can ever be armed; the CLI itself only evaluates
  // existing observations, it never records one. Hourly (staggered to minute
  // 20 so it never fires in the same minute as vault.sample_share_price /
  // vault.sample_adapters above): comfortably clears the gate's default
  // 12-observation minimum inside its default 24h window, and each tick's
  // cost is a handful of read queries plus one small insert per domain — not
  // proportional to how often it runs. Handler: worker/handlers/index.ts →
  // analytics/cutover/parity.ts::runParitySweep.
  { kind: "analytics.parity_sweep", cron: "20 * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Projects "Agentic Economy Ecosystem" pipelines (issue #87). Ordered so a
  // day's chain is coherent: discover identity → refresh live metrics → snapshot
  // today → roll revenue up → recompute coverage. Daily cadence (not the fast
  // smoke cadence), so a short smoke run never races SMOKE_SEED_PROJECTS. Each kind
  // has a handler in worker/handlers/index.ts and upserts on natural keys, so an
  // extra firing is harmless. In prod the worker needs PROJECTS_SOURCE=live
  // (select.ts fails closed rather than serving fixture data as production).
  { kind: "projects.discover", cron: "0 2 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.refresh_coins", cron: "10 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.refresh_wallets", cron: "20 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.fetch_vaults", cron: "30 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.snapshot_daily", cron: "40 0 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.sync_revenue", cron: "50 1 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Kept enabled here (byte-for-byte prod/CI shape); the explicit smoke schedule
  // step disables this row (issue #399) so curated scores are not overwritten.
  { kind: "projects.recompute_coverage", cron: "0 3 * * *", payload: {}, timezone: "UTC", enabled: true },
];

// Fast smoke schedules — added only by seedSmokeJobSchedules(), which the smoke
// CLI invokes explicitly. Production, smoke, and CI never call that step.
//
// Retired smoke cadence rows remain as disabled compatibility markers so an
// upgraded database cannot resurrect the old consumer producer. The independent
// producer's own cron configuration replaces both these rows and the superseded
// ~2-minute rows below.
const FAST_DEMO_SCHEDULES: SeedSchedule[] = [
  { kind: "regime.classify", cron: "7 * * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "research.refresh", cron: "37 * * * *", payload: {}, timezone: "UTC", enabled: false },
];

// The pre-#287 smoke analytics rows, superseded by FAST_DEMO_SCHEDULES above and
// disabled (never deleted — job_runs history and operator intent stay legible)
// on any database that already holds them.
const SUPERSEDED_FAST_DEMO_SCHEDULES: { kind: string; cron: string }[] = [
  { kind: "regime.classify", cron: "*/2 * * * *" },
  { kind: "research.refresh", cron: "1-59/2 * * * *" },
];

// Slow smoke samplers — also owned by the explicit smoke schedule step. The standing local smoke and
// the self-hosted CI runner share ONE host IP, and the every-minute
// wallet.sample_balances baseline (~3 GeckoTerminal price calls + several Base
// RPC eth_calls per tick) exhausts both providers' per-IP quotas, starving CI
// jobs on the same host. Demo decision: token prices refreshing once an hour
// is fine there, so the smoke samples wallet balances HOURLY — staggered to
// minute 3 so it never fires in the same minute as vault.sample_share_price
// ("0 * * * *"). The conflict key is (kind, cron), so this row merely COEXISTS
// with the per-minute baseline; seedSmokeJobSchedules() additionally DISABLES
// that baseline row — that is what actually switches the cadence.
const SLOW_DEMO_SAMPLER_SCHEDULES: SeedSchedule[] = [
  { kind: "wallet.sample_balances", cron: "3 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "wallet.sample_sleeves", cron: "3 * * * *", payload: {}, timezone: "UTC", enabled: true },
];

// Seeds the canonical job_schedules rows (+ retires the combined analytics.run
// kind) WITHOUT the heavier wallet-history/allocation-framework/smoke-project
// seeding below. Extracted so any test that TRUNCATEs the shared job_schedules
// table (worker-lanes/worker-lease/queue/analytics-job-isolation/
// worker-shutdown — see their `afterAll`) can cheaply restore the production
// baseline for later test files sharing the same ephemeral Postgres, instead
// of every truncating file needing to know the full seed() cost (e.g. the
// wallet_balance_samples backfill loop).
export async function seedJobSchedules(db: RegistryDb = sql): Promise<void> {
  const schedules = SCHEDULES;
  for (const s of schedules) {
    // ON CONFLICT DO NOTHING keeps this purely additive/idempotent: the row is
    // inserted once and never overwritten, so the scheduler-managed columns
    // (next_run_at, last_enqueued_at, enabled) survive untouched.
    await on(db, insertSchedule)`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled, catchup_policy)
      VALUES (${s.kind}, ${s.cron}, ${db.json(jsonValue(s.payload))}, ${s.timezone}, ${s.enabled}, ${s.catchupPolicy ?? "all"})
      ON CONFLICT (kind, cron) DO NOTHING
    `;
  }
  console.log(`seeded job_schedules (${schedules.length} definition(s), idempotent)`);

  // Phase 4: regime/research production moved to the independent producer.
  // Disable any legacy consumer-DB schedules left by an older deployment.
  await on(db, disableProducerSchedules)`
    UPDATE job_schedules SET enabled = false
     WHERE kind IN ('regime.classify', 'research.refresh') AND enabled
  `;
  await on(db, deadLetterProducerJobs)`
    UPDATE jobs
       SET status = 'dead', locked_at = NULL, locked_by = NULL,
           last_error = 'retired consumer job: independent analytics-producer owns this execution',
           updated_at = now()
     WHERE kind IN ('regime.classify', 'research.refresh') AND status IN ('pending', 'running')
  `;

  // Retire the combined `analytics.run` kind (issue #107). This seed is
  // otherwise purely additive, so an existing deployment would keep enqueuing a
  // kind that no longer has a handler or lane. Drop its schedule rows and
  // dead-letter any not-yet-terminal jobs (job_runs history is preserved).
  await on(db, deleteAnalyticsRunSchedule)`DELETE FROM job_schedules WHERE kind = 'analytics.run'`;
  await on(db, deadLetterAnalyticsRunJobs)`
    UPDATE jobs
       SET status = 'dead',
           locked_at = NULL, locked_by = NULL,
           last_error = 'retired kind: analytics.run was split into regime.classify + research.refresh (issue #107)',
           updated_at = now()
     WHERE kind = 'analytics.run' AND status IN ('pending', 'running')
  `;

  // Retire the superseded hourly ops.repair_gaps row. The cadence moved from
  // `25 * * * *` to `*/5 * * * *`, and the additive loop above conflicts on
  // (kind, cron) — so an existing deployment would keep its old row AND gain
  // the new one, dispatching the same backfill twice against a metered RPC
  // budget. Deleted rather than disabled: postflight's repair-schedule check
  // requires exactly ONE row for the kind (the procedure release.ts documents
  // at NEW_SCHEDULE_CRON). Jobs are untouched — the kind survives, only its
  // cadence moved.
  await on(db, deleteHourlyRepairSchedule)`DELETE FROM job_schedules WHERE kind = 'ops.repair_gaps' AND cron = '25 * * * *'`;
}

/** Apply the smoke's quota-safe schedule changes explicitly and idempotently. */
export async function seedSmokeJobSchedules(db: RegistryDb = sql): Promise<void> {
  for (const s of [...FAST_DEMO_SCHEDULES, ...SLOW_DEMO_SAMPLER_SCHEDULES]) {
    await on(db, insertSmokeSchedule)`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
      VALUES (${s.kind}, ${s.cron}, ${db.json(jsonValue(s.payload))}, ${s.timezone}, ${s.enabled})
      ON CONFLICT (kind, cron) DO NOTHING
    `;
  }

  await on(db, disableSmokeSchedule)`
    UPDATE job_schedules SET enabled = false
     WHERE kind IN ('wallet.sample_balances', 'wallet.sample_sleeves') AND cron = '* * * * *' AND enabled
  `;
  console.log("smoke schedules: disabled per-minute wallet samplers (hourly cadence owns sampling)");

  for (const s of SUPERSEDED_FAST_DEMO_SCHEDULES) {
    await on(db, disableSmokeSchedule)`
      UPDATE job_schedules SET enabled = false
       WHERE kind = ${s.kind} AND cron = ${s.cron} AND enabled
    `;
  }
  console.log("smoke schedules: confirmed retired consumer analytics schedules disabled");

  await on(db, disableSmokeSchedule)`
    UPDATE job_schedules SET enabled = false
     WHERE kind = 'projects.recompute_coverage' AND cron = '0 3 * * *' AND enabled
  `;
  console.log("smoke schedules: disabled projects.recompute_coverage (curated scores are preserved)");
}

/**
 * The canonical seed, on `db` (the process pool by default).
 *
 * Handed a caller's TRANSACTION — the smoke's fenced `--seed`
 * (backend/scripts/smoke-prepare.ts) — every statement below runs in it. The
 * three helpers that live in other modules and write through the process pool
 * cannot: seedSmokeProjects, backfillMemberHandles and the roster seed. Their
 * writes would land outside the caller's transaction, which is unfenced work
 * (§2). So on a caller's handle the handle backfill is skipped — the fenced seed
 * only ever runs past `assertSeedable`, on a database with no member rows for
 * it to derive — and the two opt-in flags refuse rather than run unfenced.
 */
export async function seed(db: RegistryDb = sql): Promise<void> {
  const onCallerHandle = db !== sql;
  if (onCallerHandle && (process.env.SMOKE_SEED_PROJECTS === "1" || process.env.SWARM_SEED_ROSTER === "1")) {
    throw new Error(
      "seed: SMOKE_SEED_PROJECTS / SWARM_SEED_ROSTER write through the process pool, outside the fenced " +
        "transaction this seed was handed, and unfenced work is refused (spec §2). Run them without --seed.",
    );
  }
  await seedJobSchedules(db);

  // Cold start (issue #118): enqueue ONE immediate wallet.sample_balances job so
  // the endpoint has a fresh scheduled sample within seconds of boot instead of
  // waiting up to a minute for the first cron tick. A CONSTANT dedupe_key fires it
  // at most once per database; the every-minute cron owns steady-state sampling,
  // and the (sample_date, symbol) upsert makes any overlap with the first cron
  // slot idempotent. On the smoke's LIVE data path (issue #147) this also
  // guarantees the sampler issues at least one real aggregate3 eth_call within
  // seconds of boot, rather than waiting on the cron. ON CONFLICT mirrors the
  // scheduler's partial unique index on dedupe_key.
  await on(db, enqueueColdStart)`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_balances', ${db.json(jsonValue({}))}, 'wallet.sample_balances:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  await on(db, enqueueColdStart)`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_sleeves', ${db.json(jsonValue({}))}, 'wallet.sample_sleeves:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  await on(db, enqueueColdStart)`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('vault.sample_adapters', ${db.json(jsonValue({}))}, 'vault.sample_adapters:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  await on(db, enqueueColdStart)`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('vault.sample_share_price', ${db.json(jsonValue({}))}, 'vault.sample_share_price:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  // Cold start for the gap repair, same mechanism and same reason — but the wait
  // it removes is longer. ops.repair_gaps runs at `*/5 * * * *`, and
  // worker/scheduler.ts seeds a brand-new schedule's next_run_at to the next
  // FUTURE occurrence, so a fresh boot does no repair work for up to five
  // minutes. On the cutover boot specifically that means the release's headline
  // feature does nothing at all until the next slot — including through §9's
  // postflight, which is where an operator looks for evidence it works.
  //
  // The cron owns every run after this one. Overlap is a no-op rather
  // than double work: the dispatcher declines while a window job is in flight
  // (worker/handlers/repair.ts), and a CONSTANT dedupe_key fires this at most
  // once per database.
  await on(db, enqueueColdStart)`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('ops.repair_gaps', ${db.json(jsonValue({}))}, 'ops.repair_gaps:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  console.log("enqueued cold-start sampler jobs (idempotent on dedupe_key)");

  // One-time prop-wallet history backfill (issue #84): seed the pre-launch
  // series carried forward from the baked views.js data so GET
  // /api/dashboards/wallet-balances returns a continuous /performance history in
  // every env (including CI/e2e). Idempotent (ON CONFLICT DO NOTHING on
  // (sample_date, symbol)), so a later live daily sample is never clobbered.
  const backfilled = await backfillWalletHistory(db);
  console.log(`seeded wallet_balance_samples backfill (${backfilled} row candidate(s), idempotent)`);

  // Allocation framework (live-data contract §4): seed the single admin/swarm
  // -managed row (id=1) from the swarm source-of-truth (allocation.json,
  // copied into ALLOCATION_FRAMEWORK_SEED). ON CONFLICT DO NOTHING so a later
  // admin rewrite is NEVER clobbered by a re-boot ("projects overviews
  // admin-managed" policy) — this seed only fills an empty table.
  await on(db, insertAllocationFramework)`
    INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
    VALUES (1, ${ALLOCATION_FRAMEWORK_SEED.asof}, ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
            ${db.json(jsonValue(ALLOCATION_FRAMEWORK_SEED.buckets))})
    ON CONFLICT (id) DO NOTHING
  `;
  console.log("seeded allocation_framework (id=1, idempotent — admin edits preserved)");

  // Demo-only: populate the "Agentic Economy Ecosystem" projects directory so
  // GET /api/projects returns a full table instead of "No projects yet.". Gated
  // behind SMOKE_SEED_PROJECTS so prod/CI seeds stay byte-for-byte unchanged (the
  // flag is set ONLY on the smoke migrate/seed run in scripts/lib/smoke-main.ts).
  // Idempotent (upsert-on-slug + delete/re-insert facets), so safe on every boot.
  if (process.env.SMOKE_SEED_PROJECTS === "1") {
    await seedSmokeProjects();
  }

  // Public-deployment only: seat the house swarm (Athena, Robot Money) with
  // the profile copy robotmoney.net publishes, from the committed manifests
  // (see ../swarm/roster-seed.ts). Gated behind SWARM_SEED_ROSTER so every
  // other seed — CI, the smoke stack, a local dev database — stays byte-for-byte
  // what it was; the smoke's own roster comes from backend/src/smoke/e2e.ts and
  // must not gain two extra members.
  //
  // Seating is additive only: it upserts the roster and leaves every other
  // member alone. SWARM_SEED_ROSTER_PRUNE additionally retires (status=
  // 'inactive', never deletes) every other ACTIVE member, which is how a
  // deployment the smoke drivers populated converges to the real roster.
  //
  // The prune is a SECOND flag, and deliberately nested INSIDE the seed gate
  // (issue #530): it is the only half that can sweep away an operator
  // legitimately admitted through the apply flow, and nesting it means a stray
  // SWARM_SEED_ROSTER_PRUNE=1 alone can never retire the whole roster and seat
  // nothing in its place. Set it for the one convergence run, not in the
  // standing config.
  // Every member whose handle is still the 0030 default gets the handle its
  // display name derives to. UNGATED and unconditional, unlike the roster
  // seeding below: this is not a deployment-shaping choice, it is the reader of
  // a signal 0030 already writes, and a member without a readable handle is
  // simply an unfinished migration. Nothing else will ever fill these in — the
  // other derivation sites fire on acceptance/registration events that a
  // long-admitted member has already passed. Idempotent, so a boot with nothing
  // to do stays silent.
  const derivedHandles = onCallerHandle ? 0 : await backfillMemberHandles();
  if (derivedHandles > 0) {
    console.log(`derived ${derivedHandles} swarm member handle(s) that were still at migration 0030's default`);
  }

  if (process.env.SWARM_SEED_ROSTER === "1") {
    const seated = await seedLiveRoster();
    console.log(`seeded swarm live roster (${seated} member(s), profile copy from the committed manifests)`);
    if (process.env.SWARM_SEED_ROSTER_PRUNE === "1") {
      const retired = await pruneToLiveRoster();
      console.log(
        retired.length
          ? `retired ${retired.length} off-roster swarm member(s) to inactive: ${retired.join(", ")}`
          : "no off-roster swarm members to retire",
      );
    }
  }
}

/**
 * The `--seed` gate (spec §5, §4.3). `--seed` "creates demo data on a blank
 * database. It is explicit, refuses a populated database, requires
 * `rehearsal`, and is never implied by any mode."
 *
 * Refusals, in order, each naming what it saw:
 *   - the rehearsal-only gate (`requireRehearsalTarget`, the one shared with
 *     `--migrate` and `--spoof-keys`): `RM_ENV=prod`, a value that is not a
 *     policy, a seed nobody asked for, and a `production`, missing or
 *     unreadable enrollment;
 *   - a POPULATED database: any table holding rows a blank bootstrap did not
 *     write, counted exactly (`populatedTables`, ./schema-snapshot.ts). Rows,
 *     not tables: a snapshot bootstrap has every table and is still blank.
 *
 * Run in the SAME fenced transaction as the seed it guards, so nothing can
 * populate or re-enroll the database between the check and the write.
 */
export async function assertSeedable(
  db: RegistryDb,
  request: { readonly rmEnv: string | undefined; readonly explicitlyRequested: boolean },
): Promise<void> {
  const identity = await readIdentityKind(db);
  const gate = requireRehearsalTarget({
    preparation: "seed",
    rmEnv: request.rmEnv,
    identity,
    explicitlyRequested: request.explicitlyRequested,
  });
  if (!gate.allow) throw new Error(`Refusing --seed: ${gate.reason} Nothing was written.`);
  const populated = await populatedTables(db, await loadSnapshot());
  if (populated.length > 0) {
    const named = populated
      .map((t) => `${t.table} (${t.rows} row(s)${t.bootstrapRows > 0 ? `, ${t.bootstrapRows} from bootstrap data` : ""})`)
      .join(", ");
    throw new Error(
      `Refusing --seed: the database is populated — ${named}. --seed creates demo data on a blank database and ` +
        "refuses a populated one (spec §5): its demo rows are written over whatever is there. Nothing was written.",
    );
  }
}

/**
 * `bun smoke --seed`: the gate, the canonical seed and the smoke's quota-safe
 * schedule changes, on the caller's fenced transaction (see the header).
 */
export async function seedDemo(
  tx: RegistryDb,
  request: { readonly rmEnv: string | undefined },
): Promise<void> {
  await assertSeedable(tx, { rmEnv: request.rmEnv, explicitlyRequested: true });
  await seed(tx);
  await seedSmokeJobSchedules(tx);
}

// Run directly: `bun run src/db/seed.ts [--smoke-schedules]`, with an rm_owner
// DATABASE_URL. The canonical seed is idempotent and not demo data, so it is
// not gated; it IS a mutation, so it runs inside the §2 fence like every other
// one, on a connection of its own from the same URL.
if (import.meta.url === `file://${process.argv[1]}`) {
  withMutationFence({ databaseUrl: process.env.DATABASE_URL ?? "", label: "seed" }, async (tx) => {
    await seed(tx);
    if (process.argv.includes("--smoke-schedules")) await seedSmokeJobSchedules(tx);
  })
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
// Idempotent backfill of the pre-launch prop-wallet history (issue #84).
// ON CONFLICT DO NOTHING so a later live sample for the same (date, symbol) is
// never clobbered by a re-run. Rows are labelled provenance 'seed' — these are
// ported baked UI constants (chain/wallet-history-seed.ts), not live chain
// reads, so they must NEVER carry 'live' (honesty invariant, migration
// 0014_wallet_balance_samples.sql).
//
// Lives HERE (not in worker/handlers/wallet.ts) because it is migrate/seed
// tooling on the migration pool: issue #106 gave the worker its own
// queue-scoped pool (db/worker-client.ts), and a seed that queried through that
// second pool would leave `bun run migrate` with open sockets it never closes
// (the smoke's migrate one-shot would hang forever).
export async function backfillWalletHistory(db: RegistryDb = sql): Promise<number> {
  const rows = walletHistorySeedRows();
  for (const r of rows) {
    await on(db, insertWalletHistorySeed)`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance)
      VALUES
        (${r.date}, ${r.symbol}, NULL, NULL, ${r.valueUsd}, 'seed')
      ON CONFLICT (sample_date, symbol) DO NOTHING
    `;
  }
  return rows.length;
}

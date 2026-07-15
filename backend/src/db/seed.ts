// Idempotent seed of job_schedules so the worker runs the analytics suite on its
// own — no manual admin trigger needed. UPSERTs on the natural key (kind, cron)
// from migration 0005, so repeated runs (every boot / migrate) never duplicate
// rows. Runs as part of `bun run migrate` (migrate.ts calls seed() after DDL).
//
// Dev-safe: every seeded schedule's handler upserts on natural keys, so an
// extra firing is harmless. We DO NOT touch next_run_at / enabled on an
// existing row — that lets the scheduler own slot bookkeeping and lets an
// operator disable a schedule without the seed re-enabling it.
import { sql, closeDb, jsonValue } from "./client.ts";
import { seedDemoProjects } from "../projects/demo-seed.ts";
import { backfillWalletHistory } from "../worker/handlers/wallet.ts";
import { ALLOCATION_FRAMEWORK_SEED } from "../chain/allocation-framework.ts";

interface SeedSchedule {
  kind: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  enabled: boolean;
}

// Keep this list small and harmless. Each kind MUST have a handler registered in
// backend/src/worker/handlers/index.ts and be idempotent on natural keys.
//
// Committee schedules are intentionally no-cron (never auto-enqueued by the
// scheduler). The demo script enqueues lifecycle jobs explicitly via the
// admin enqueue-job endpoint, which lets the demo control the pace while still
// exercising the real worker claim loop + handler path. Scheduled cron
// triggering (e.g. daily open_session) is a future addition.
const SCHEDULES: SeedSchedule[] = [
  // Daily 22:30 UTC: regime-only classification. After the US equity close
  // (21:00 UTC) + FRED's daily refresh, mirroring the original scripts/regime
  // cron so the fetched raw is the settled end-of-day data. Regime and research
  // are DISTINCT kinds on independent cadences/lanes (issue #107) — the old
  // combined `analytics.run` kind is retired below.
  { kind: "regime.classify", cron: "30 22 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Daily 23:00 UTC: research-signals refresh (channel-divergence + late-cycle),
  // AFTER the regime job so the STABLES raw floor it reads is fresh. Runs in the
  // research lane, so a slow fetch here can never starve committee/regime work.
  { kind: "research.refresh", cron: "0 23 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Hourly vault share-price sample (issue #40) — dense enough for a 7-day APY
  // lookback, cheap on RPC (3 eth_calls/hour). Handler: worker/handlers/vault.ts.
  { kind: "vault.sample_share_price", cron: "0 * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Prop-wallet balance sample (issues #84/#118) — the ONLY place a chain read
  // happens for wallet balances now (the request path serves persisted data with
  // ZERO RPC). Runs EVERY MINUTE so the served payload is near-real-time; the
  // (sample_date, symbol) upsert refreshes today's row each tick (idempotent, no
  // row growth within a day). Handler: worker/handlers/wallet.ts.
  { kind: "wallet.sample_balances", cron: "* * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Buyback refresh (live-data contract §1) — eth_getLogs indexer that upserts
  // NEW WETH->ROBOTMONEY buyback swaps into buyback_swaps (keyed on tx_hash). No-op
  // under a non-live source; degrade-safe on RPC failure. Handler: handlers/buybacks.ts.
  { kind: "buybacks.refresh", cron: "15 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Committee lifecycle — disabled by default; the demo enqueues these explicitly
  // via the admin enqueue-job endpoint, exercising the real worker claim loop +
  // handler path. Enable manually or change to a real cron for auto-scheduling.
  { kind: "committee.open_session", cron: "0 6 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.publish_brief", cron: "0 7 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.close_window", cron: "0 8 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.aggregate", cron: "0 9 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.publish", cron: "0 10 * * *", payload: {}, timezone: "UTC", enabled: false },
  // Projects "Agentic Economy Ecosystem" pipelines (issue #87). Ordered so a
  // day's chain is coherent: discover identity → refresh live metrics → snapshot
  // today → roll revenue up → recompute coverage. Daily cadence (not the fast
  // demo cadence), so a short demo run never races DEMO_SEED_PROJECTS. Each kind
  // has a handler in worker/handlers/index.ts and upserts on natural keys, so an
  // extra firing is harmless. In prod the worker needs PROJECTS_SOURCE=live
  // (select.ts fails closed rather than serving fixture data as production).
  { kind: "projects.discover", cron: "0 2 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.refresh_coins", cron: "10 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.refresh_wallets", cron: "20 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.fetch_vaults", cron: "30 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.snapshot_daily", cron: "40 0 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.sync_revenue", cron: "50 1 * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "projects.recompute_coverage", cron: "0 3 * * *", payload: {}, timezone: "UTC", enabled: true },
];

// Fast demo schedules — ONLY added when DEMO_FAST_SCHEDULES is set (the demo
// script sets it on the migrate/seed run). Prod/CI leave the flag unset, so the
// default seed above is byte-for-byte unchanged there.
//
// These drive the worker's scheduler at a ~2-minute cadence and are STAGGERED by
// different cron minute offsets (cron is minute-granularity) so the two analytics
// action types never fire in the same minute:
//   - regime.classify  (regime-only, analytics lane)   → even minutes (*/2)
//   - research.refresh (research-only, research lane)  → odd minutes  (1-59/2)
// New (kind, cron) combos, so ON CONFLICT DO NOTHING inserts them once and lets
// the scheduler own next_run_at/enabled bookkeeping thereafter.
const FAST_DEMO_SCHEDULES: SeedSchedule[] = [
  { kind: "regime.classify", cron: "*/2 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "research.refresh", cron: "1-59/2 * * * *", payload: {}, timezone: "UTC", enabled: true },
];

export async function seed(): Promise<void> {
  const schedules = process.env.DEMO_FAST_SCHEDULES
    ? [...SCHEDULES, ...FAST_DEMO_SCHEDULES]
    : SCHEDULES;
  for (const s of schedules) {
    // ON CONFLICT DO NOTHING keeps this purely additive/idempotent: the row is
    // inserted once and never overwritten, so the scheduler-managed columns
    // (next_run_at, last_enqueued_at, enabled) survive untouched.
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
      VALUES (${s.kind}, ${s.cron}, ${sql.json(jsonValue(s.payload))}, ${s.timezone}, ${s.enabled})
      ON CONFLICT (kind, cron) DO NOTHING
    `;
  }
  console.log(`seeded job_schedules (${schedules.length} definition(s), idempotent)`);

  // Retire the combined `analytics.run` kind (issue #107). This seed is
  // otherwise purely additive, so an existing deployment would keep enqueuing a
  // kind that no longer has a handler or lane. Drop its schedule rows and
  // dead-letter any not-yet-terminal jobs (job_runs history is preserved).
  await sql`DELETE FROM job_schedules WHERE kind = 'analytics.run'`;
  await sql`
    UPDATE jobs
       SET status = 'dead',
           locked_at = NULL, locked_by = NULL,
           last_error = 'retired kind: analytics.run was split into regime.classify + research.refresh (issue #107)',
           updated_at = now()
     WHERE kind = 'analytics.run' AND status IN ('pending', 'running')
  `;

  // Cold start (issue #118): enqueue ONE immediate wallet.sample_balances job so
  // the endpoint has a fresh scheduled sample within seconds of boot instead of
  // waiting up to a minute for the first cron tick. A CONSTANT dedupe_key fires it
  // at most once per database; the every-minute cron owns steady-state sampling,
  // and the (sample_date, symbol) upsert makes any overlap with the first cron
  // slot idempotent. In the hermetic demo this also guarantees the sampler routes
  // at least one aggregate3 eth_call to the stub so demo-rpc-guard sees ethCall > 0
  // (the request path no longer issues RPC). ON CONFLICT mirrors the scheduler's
  // partial unique index on dedupe_key.
  await sql`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_balances', ${sql.json(jsonValue({}))}, 'wallet.sample_balances:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  console.log("enqueued cold-start wallet.sample_balances job (idempotent on dedupe_key)");

  // One-time prop-wallet history backfill (issue #84): seed the pre-launch
  // series carried forward from the baked views.js data so GET
  // /api/dashboards/wallet-balances returns a continuous /performance history in
  // every env (including CI/e2e). Idempotent (ON CONFLICT DO NOTHING on
  // (sample_date, symbol)), so a later live daily sample is never clobbered.
  const backfilled = await backfillWalletHistory();
  console.log(`seeded wallet_balance_samples backfill (${backfilled} row candidate(s), idempotent)`);

  // Allocation framework (live-data contract §4): seed the single admin/committee
  // -managed row (id=1) from the committee source-of-truth (allocation.json,
  // copied into ALLOCATION_FRAMEWORK_SEED). ON CONFLICT DO NOTHING so a later
  // admin rewrite is NEVER clobbered by a re-boot ("projects overviews
  // admin-managed" policy) — this seed only fills an empty table.
  await sql`
    INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
    VALUES (1, ${ALLOCATION_FRAMEWORK_SEED.asof}, ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
            ${sql.json(jsonValue(ALLOCATION_FRAMEWORK_SEED.buckets))})
    ON CONFLICT (id) DO NOTHING
  `;
  console.log("seeded allocation_framework (id=1, idempotent — admin edits preserved)");

  // Demo-only: populate the "Agentic Economy Ecosystem" projects directory so
  // GET /api/projects returns a full table instead of "No projects yet.". Gated
  // behind DEMO_SEED_PROJECTS so prod/CI seeds stay byte-for-byte unchanged (the
  // flag is set ONLY on the demo migrate/seed run in scripts/lib/demo-main.ts).
  // Idempotent (upsert-on-slug + delete/re-insert facets), so safe on every boot.
  if (process.env.DEMO_SEED_PROJECTS === "1") {
    await seedDemoProjects();
  }
}

// Run directly: `bun run src/db/seed.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}

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
import { seedLiveRoster, pruneToLiveRoster } from "../swarm/roster-seed.ts";
import { seedDemoProjects } from "../projects/demo-seed.ts";
import { walletHistorySeedRows } from "../chain/wallet-history-seed.ts";
import { ALLOCATION_FRAMEWORK_SEED } from "../chain/allocation-framework.ts";
import { resolveSwarmSchedules } from "../config.ts";

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
// Swarm lifecycle schedules are NOT in this list — they are seeded by
// seedSwarmSchedules() below, which is environment-configurable (issue
// #208): SWARM_SCHEDULES_ENABLED (disabled by default) switches the whole
// swarm.* cron sequence on/off, SWARM_*_CRON / SWARM_WINDOW_MINUTES
// tune it, and changed values are applied to EXISTING job_schedules rows on
// every seed run. The demo pins SWARM_SCHEDULES_ENABLED=0 and instead
// enqueues lifecycle jobs explicitly via the admin enqueue-job endpoint, which
// lets it control the pace while still exercising the real worker claim loop +
// handler path.
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
  { kind: "wallet.sample_balances", cron: "* * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "wallet.sample_sleeves", cron: "* * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Buyback refresh (live-data contract §1) — eth_getLogs indexer that upserts
  // NEW WETH->ROBOTMONEY buyback swaps into buyback_swaps (keyed on tx_hash). No-op
  // under a non-live source; degrade-safe on RPC failure. Handler: handlers/buybacks.ts.
  { kind: "buybacks.refresh", cron: "15 */6 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Self-healing dispatcher (issue #709). Asks the gap detector what is missing
  // and enqueues one wallet.backfill_day job per missing day, bounded per run.
  // HOURLY rather than daily so a wide gap converges in hours instead of weeks
  // under the per-run cap, and cheap when there is nothing to do (two detector
  // queries and no chain read). It is a NO-OP unless the deployment has
  // configured its shared RPC rate budget (BASE_RPC_MAX_CALLS_PER_SEC), so a
  // demo/CI boot never starts sweeping months of history — see
  // worker/handlers/repair.ts. Handler: worker/handlers/repair.ts.
  { kind: "ops.repair_gaps", cron: "25 * * * *", payload: {}, timezone: "UTC", enabled: true },
  // Swarm lifecycle rows are seeded SEPARATELY below (seedSwarmSchedules)
  // — issue #208 made their enabled/cron/window environment-configurable via
  // resolveSwarmSchedules(), and (unlike every other row here) their
  // enabled/cron ARE overwritten on every seed run so a changed
  // SWARM_*_CRON / SWARM_SCHEDULES_ENABLED is actually applied to an
  // existing deployment, not just a fresh database.
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
  // Kept enabled here (byte-for-byte prod/CI shape); the explicit demo schedule
  // step disables this row (issue #399) so curated scores are not overwritten.
  { kind: "projects.recompute_coverage", cron: "0 3 * * *", payload: {}, timezone: "UTC", enabled: true },
];

// Fast demo schedules — added only by seedDemoJobSchedules(), which the demo
// CLI invokes explicitly. Production, smoke, and CI never call that step.
//
// Retired demo cadence rows remain as disabled compatibility markers so an
// upgraded database cannot resurrect the old consumer producer. The independent
// producer's own cron configuration replaces both these rows and the superseded
// ~2-minute rows below.
const FAST_DEMO_SCHEDULES: SeedSchedule[] = [
  { kind: "regime.classify", cron: "7 * * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "research.refresh", cron: "37 * * * *", payload: {}, timezone: "UTC", enabled: false },
];

// The pre-#287 demo analytics rows, superseded by FAST_DEMO_SCHEDULES above and
// disabled (never deleted — job_runs history and operator intent stay legible)
// on any database that already holds them.
const SUPERSEDED_FAST_DEMO_SCHEDULES: { kind: string; cron: string }[] = [
  { kind: "regime.classify", cron: "*/2 * * * *" },
  { kind: "research.refresh", cron: "1-59/2 * * * *" },
];

// Slow demo samplers — also owned by the explicit demo schedule step. The standing local demo and
// the self-hosted CI runner share ONE host IP, and the every-minute
// wallet.sample_balances baseline (~3 GeckoTerminal price calls + several Base
// RPC eth_calls per tick) exhausts both providers' per-IP quotas, starving CI
// jobs on the same host. Demo decision: token prices refreshing once an hour
// is fine there, so the demo samples wallet balances HOURLY — staggered to
// minute 3 so it never fires in the same minute as vault.sample_share_price
// ("0 * * * *"). The conflict key is (kind, cron), so this row merely COEXISTS
// with the per-minute baseline; seedDemoJobSchedules() additionally DISABLES
// that baseline row — that is what actually switches the cadence.
const SLOW_DEMO_SAMPLER_SCHEDULES: SeedSchedule[] = [
  { kind: "wallet.sample_balances", cron: "3 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "wallet.sample_sleeves", cron: "3 * * * *", payload: {}, timezone: "UTC", enabled: true },
];

// Seeds the canonical job_schedules rows (+ retires the combined analytics.run
// kind) WITHOUT the heavier wallet-history/allocation-framework/demo-project
// seeding below. Extracted so any test that TRUNCATEs the shared job_schedules
// table (worker-lanes/worker-lease/queue/analytics-job-isolation/
// worker-shutdown — see their `afterAll`) can cheaply restore the production
// baseline for later test files sharing the same ephemeral Postgres, instead
// of every truncating file needing to know the full seed() cost (e.g. the
// wallet_balance_samples backfill loop).
// Swarm lifecycle schedule rows (issue #208): a DELIBERATE exception to
// the "never touch enabled/cron on an existing row" rule below. Their
// enabled/cron/window are environment-configuration (resolveSwarmSchedules,
// backend/src/config.ts), not operator-toggled state — an operator changing
// SWARM_OPEN_SESSION_CRON (or flipping SWARM_SCHEDULES_ENABLED) and
// re-running the migrate/seed step must see that value actually applied to the
// existing deployment, so this is an explicit UPDATE-by-kind (not the
// (kind, cron) natural key the general loop above uses — the cron itself is
// exactly what may change here, so conflicting on it would leave a stale
// duplicate row under the old cron instead of updating in place).
export async function seedSwarmSchedules(): Promise<void> {
  for (const s of resolveSwarmSchedules()) {
    const updated = await sql`
      UPDATE job_schedules
         SET cron = ${s.cron}, enabled = ${s.enabled}, payload = ${sql.json(jsonValue(s.payload))}, timezone = ${s.timezone}
       WHERE kind = ${s.kind}
       RETURNING id`;
    if (updated.length === 0) {
      await sql`
        INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
        VALUES (${s.kind}, ${s.cron}, ${sql.json(jsonValue(s.payload))}, ${s.timezone}, ${s.enabled})
      `;
    }
  }
  console.log("seeded swarm.* job_schedules (5 definition(s), env-configured, applied to existing rows)");
}

export async function seedJobSchedules(): Promise<void> {
  const schedules = SCHEDULES;
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
  await seedSwarmSchedules();

  // Phase 4: regime/research production moved to the independent producer.
  // Disable any legacy consumer-DB schedules left by an older deployment.
  await sql`
    UPDATE job_schedules SET enabled = false
     WHERE kind IN ('regime.classify', 'research.refresh') AND enabled
  `;
  await sql`
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
  await sql`DELETE FROM job_schedules WHERE kind = 'analytics.run'`;
  await sql`
    UPDATE jobs
       SET status = 'dead',
           locked_at = NULL, locked_by = NULL,
           last_error = 'retired kind: analytics.run was split into regime.classify + research.refresh (issue #107)',
           updated_at = now()
     WHERE kind = 'analytics.run' AND status IN ('pending', 'running')
  `;
}

/** Apply the demo's quota-safe schedule changes explicitly and idempotently. */
export async function seedDemoJobSchedules(): Promise<void> {
  for (const s of [...FAST_DEMO_SCHEDULES, ...SLOW_DEMO_SAMPLER_SCHEDULES]) {
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
      VALUES (${s.kind}, ${s.cron}, ${sql.json(jsonValue(s.payload))}, ${s.timezone}, ${s.enabled})
      ON CONFLICT (kind, cron) DO NOTHING
    `;
  }

  await sql`
    UPDATE job_schedules SET enabled = false
     WHERE kind IN ('wallet.sample_balances', 'wallet.sample_sleeves') AND cron = '* * * * *' AND enabled
  `;
  console.log("demo schedules: disabled per-minute wallet samplers (hourly cadence owns sampling)");

  for (const s of SUPERSEDED_FAST_DEMO_SCHEDULES) {
    await sql`
      UPDATE job_schedules SET enabled = false
       WHERE kind = ${s.kind} AND cron = ${s.cron} AND enabled
    `;
  }
  console.log("demo schedules: confirmed retired consumer analytics schedules disabled");

  await sql`
    UPDATE job_schedules SET enabled = false
     WHERE kind = 'projects.recompute_coverage' AND cron = '0 3 * * *' AND enabled
  `;
  console.log("demo schedules: disabled projects.recompute_coverage (curated scores are preserved)");
}

export async function seed(): Promise<void> {
  await seedJobSchedules();

  // Cold start (issue #118): enqueue ONE immediate wallet.sample_balances job so
  // the endpoint has a fresh scheduled sample within seconds of boot instead of
  // waiting up to a minute for the first cron tick. A CONSTANT dedupe_key fires it
  // at most once per database; the every-minute cron owns steady-state sampling,
  // and the (sample_date, symbol) upsert makes any overlap with the first cron
  // slot idempotent. On the demo's LIVE data path (issue #147) this also
  // guarantees the sampler issues at least one real aggregate3 eth_call within
  // seconds of boot, rather than waiting on the cron. ON CONFLICT mirrors the
  // scheduler's partial unique index on dedupe_key.
  await sql`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_balances', ${sql.json(jsonValue({}))}, 'wallet.sample_balances:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  await sql`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_sleeves', ${sql.json(jsonValue({}))}, 'wallet.sample_sleeves:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  await sql`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('vault.sample_adapters', ${sql.json(jsonValue({}))}, 'vault.sample_adapters:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  await sql`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('vault.sample_share_price', ${sql.json(jsonValue({}))}, 'vault.sample_share_price:coldstart')
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `;
  console.log("enqueued cold-start sampler jobs (idempotent on dedupe_key)");

  // One-time prop-wallet history backfill (issue #84): seed the pre-launch
  // series carried forward from the baked views.js data so GET
  // /api/dashboards/wallet-balances returns a continuous /performance history in
  // every env (including CI/e2e). Idempotent (ON CONFLICT DO NOTHING on
  // (sample_date, symbol)), so a later live daily sample is never clobbered.
  const backfilled = await backfillWalletHistory();
  console.log(`seeded wallet_balance_samples backfill (${backfilled} row candidate(s), idempotent)`);

  // Allocation framework (live-data contract §4): seed the single admin/swarm
  // -managed row (id=1) from the swarm source-of-truth (allocation.json,
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

  // Public-deployment only: seat the house swarm (Athena, Robot Money) with
  // the profile copy robotmoney.net publishes, from the committed manifests
  // (see ../swarm/roster-seed.ts). Gated behind SWARM_SEED_ROSTER so every
  // other seed — CI, the demo stack, a local dev database — stays byte-for-byte
  // what it was; the demo's own roster comes from backend/src/demo/e2e.ts and
  // must not gain two extra members.
  //
  // Seating is additive only: it upserts the roster and leaves every other
  // member alone. SWARM_SEED_ROSTER_PRUNE additionally retires (status=
  // 'inactive', never deletes) every other ACTIVE member, which is how a
  // deployment the demo drivers populated converges to the real roster.
  //
  // The prune is a SECOND flag, and deliberately nested INSIDE the seed gate
  // (issue #530): it is the only half that can sweep away an operator
  // legitimately admitted through the apply flow, and nesting it means a stray
  // SWARM_SEED_ROSTER_PRUNE=1 alone can never retire the whole roster and seat
  // nothing in its place. Set it for the one convergence run, not in the
  // standing config.
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
// (the demo's migrate one-shot would hang forever).
export async function backfillWalletHistory(): Promise<number> {
  const rows = walletHistorySeedRows();
  for (const r of rows) {
    await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance)
      VALUES
        (${r.date}, ${r.symbol}, NULL, NULL, ${r.valueUsd}, 'seed')
      ON CONFLICT (sample_date, symbol) DO NOTHING
    `;
  }
  return rows.length;
}

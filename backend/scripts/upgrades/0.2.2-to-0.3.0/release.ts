// Facts about the v0.3.0 release itself that the GATE SCRIPTS execute against.
//
// Same split as 0.2.1-to-0.2.2/release.ts, and for the same reason: `depends-on`
// in steps.ts must name what a step EXECUTES, so a constant the checks read
// lives here and a label a human reads lives in the manifest. Nothing in this
// file may import from steps.ts, or the split is undone.

/**
 * Every migration this release applies, in runner order (readdir + JS sort,
 * src/db/migrate.ts:39-41). THE single source: preflight.ts and postflight.ts
 * both import this.
 *
 * ⚠ TWO OF THESE REUSE A NUMBER PRODUCTION HAS ALREADY APPLIED. v0.2.2 shipped
 * `0032_append_only_history.sql` and `0033_swarm_member_uuid_ids.sql`; this
 * release adds a SECOND `0032_` and a SECOND `0033_`. That is safe — the runner
 * keys `schema_migrations` on the full filename (`name text PRIMARY KEY`, and
 * the skip test is `applied.has(file)`), so neither is silently skipped, and
 * v0.2.2 already shipped a duplicate `0029_*` pair to production the same way.
 *
 * It does have one visible consequence, and it is EXPECTED rather than wrong:
 * `0032_wallet_...` sorts before the newest already-applied file
 * (`0033_swarm_member_uuid_ids.sql`), so preflight's `schema-migrations` check
 * reports it as out-of-order and returns WARN. See the runbook §6 for why that
 * warning is the correct output here and what makes it safe — in short, the
 * append-only guard is already installed by then, and none of the four touches
 * a protected table.
 */
export const THIS_RELEASE_MIGRATIONS = [
  "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
  "0033_wallet_backfill.sql",
  "0034_job_schedules_catchup_policy.sql",
  "0035_swarm_member_avatar_bytes.sql",
] as const;

/**
 * The migrations v0.2.2 left behind, which production MUST already have.
 * preflight asserts these are present: a database missing any of them is not
 * at v0.2.2 and this upgrade's premise does not hold.
 */
export const PRIOR_RELEASE_MIGRATIONS = [
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0033_swarm_member_uuid_ids.sql",
] as const;

/**
 * Tables each new migration creates or alters, and whether the append-only
 * guard protects them. Checked rather than asserted in prose: if a future edit
 * adds a migration that DOES touch a protected table, the check fails instead
 * of the runbook quietly going stale.
 */
export const NEW_TABLES = ["chain_day_blocks", "wallet_backfill_state", "swarm_member_avatars"] as const;
export const NEW_COLUMNS = [
  { table: "wallet_balance_samples", column: "strategy_nav_idle_only" },
  { table: "job_schedules", column: "catchup_policy" },
] as const;

/**
 * The two schedules migration 0034 rewrites in place
 * (`UPDATE job_schedules SET catchup_policy = 'collapse-per-bucket'`). Captured
 * before and verified after — this is the one data write in the migration set.
 */
export const COLLAPSE_PER_BUCKET_KINDS = ["wallet.sample_balances", "wallet.sample_sleeves"] as const;

/** The schedule seed() adds on the first boot of this release. Inert until
 *  BASE_RPC_MAX_CALLS_PER_SEC is set — see the runbook §5.2. */
export const NEW_SCHEDULE_KIND = "ops.repair_gaps";

/** Selects this release's tags and no others (the runbook cuts `v0.3.0-rc.N`). */
export const TAG_GLOB = "v0.3.0*";

/** The release tracking issue whose Phase tasklist gates preflight. */
export const TRACKING_ISSUE = 661;

/**
 * BYTE-IDENTICAL COPY of APPEND_ONLY_MIGRATION
 * (backend/src/db/append-only-guard.ts).
 *
 * Not imported. That module imports ./client.ts, which calls
 * required("DATABASE_URL") at module load and constructs the application's
 * shared writer pool — and these gate scripts must open exactly ONE connection,
 * on the read-only role, assembled from .env.readonly. Importing it would make
 * a read-only preflight demand the writer credential to start.
 *
 * Same trade the v0.2.1-to-0.2.2 preflight made for its namespace predicate,
 * with the same mitigation: backend/tests/upgrade-0-2-2-to-0-3-0.test.ts holds
 * the two in agreement mechanically, so this cannot drift silently.
 */
export const APPEND_ONLY_MIGRATION = "0032_append_only_history.sql";

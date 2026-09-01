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
 * append-only guard is already installed by then, and none of the eleven
 * REMOVES a row from a protected table. Three of them LOCK one (0035's foreign
 * key on `swarm_members`, 0039's constraint swap on `swarm_sessions`, 0042's
 * two foreign keys on `swarm_sessions` and `swarm_session_judgements`); the
 * guard fires BEFORE DELETE OR TRUNCATE only, so none can trip it. preflight's
 * append-only-safety check does not yet draw that distinction — see
 * MIGRATION_TOUCHED_TABLES below and runbook §2.2.1.
 */
export const THIS_RELEASE_MIGRATIONS = [
  "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
  "0033_wallet_backfill.sql",
  "0034_job_schedules_catchup_policy.sql",
  "0035_swarm_member_avatar_bytes.sql",
  "0036_quarantine_backfilled_samples.sql",
  "0037_aum_repairable_quarantine.sql",
  "0038_wallet_aum_snapshot_foundation.sql",
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
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
export const NEW_TABLES = [
  "chain_day_blocks",
  "wallet_backfill_state",
  "swarm_member_avatars",
  "wallet_balance_sample_evidence",
  "wallet_sleeve_sample_evidence",
  "wallet_aum_snapshot_runs",
  // 0039. `swarm_judge_config` is NOT EMPTY after the migration — 0039 seeds
  // its single operator-switch row (`INSERT … VALUES (1) ON CONFLICT DO
  // NOTHING`), so postflight's `new-tables` check reports it as present-but-not-
  // empty by design. It is listed here anyway because preflight's clean-targets
  // check is the half that matters: a `swarm_judge_config` that already exists
  // on a database claiming to be at v0.2.2 is an out-of-band change.
  "swarm_judge_config",
  "swarm_session_judgements",
  // 0042 (issue #754's published consensus receipt). Unlike `swarm_judge_config`
  // above this one IS empty after the migration — 0042 seeds nothing, a receipt
  // exists only once an operator publishes one — so both halves apply as
  // written: preflight's clean-targets check refuses a database that already
  // has the table, and postflight's new-tables check requires it present and
  // empty.
  "swarm_consensus_receipts",
] as const;
export const NEW_COLUMNS = [
  { table: "wallet_balance_samples", column: "strategy_nav_idle_only" },
  { table: "job_schedules", column: "catchup_policy" },
  { table: "wallet_balance_samples", column: "snapshot_run_id" },
  { table: "wallet_balance_samples", column: "amount_observed_at" },
  { table: "wallet_balance_samples", column: "price_observed_at" },
  { table: "wallet_balance_samples", column: "recorded_at" },
  { table: "wallet_sleeve_samples", column: "snapshot_run_id" },
  { table: "wallet_sleeve_samples", column: "amount_observed_at" },
  { table: "wallet_sleeve_samples", column: "price_observed_at" },
  { table: "wallet_sleeve_samples", column: "recorded_at" },
  { table: "wallet_balance_sample_evidence", column: "snapshot_run_id" },
  { table: "wallet_balance_sample_evidence", column: "amount_observed_at" },
  { table: "wallet_balance_sample_evidence", column: "price_observed_at" },
  { table: "wallet_balance_sample_evidence", column: "recorded_at" },
  { table: "wallet_sleeve_sample_evidence", column: "snapshot_run_id" },
  { table: "wallet_sleeve_sample_evidence", column: "amount_observed_at" },
  { table: "wallet_sleeve_sample_evidence", column: "price_observed_at" },
  { table: "wallet_sleeve_sample_evidence", column: "recorded_at" },
  { table: "chain_day_blocks", column: "block_hash" },
  { table: "chain_day_blocks", column: "boundary_next_block_number" },
  { table: "chain_day_blocks", column: "boundary_next_block_hash" },
  { table: "chain_day_blocks", column: "boundary_next_block_timestamp" },
  // 0041, on the table 0039 creates earlier in this release — the same
  // create-then-alter-within-one-release shape as the chain_day_blocks rows
  // above, which checkCleanTargets already handles by skipping a NEW_TABLES
  // target that does not exist yet.
  { table: "swarm_session_judgements", column: "applied" },
  { table: "swarm_session_judgements", column: "applied_skipped_reason" },
  { table: "swarm_session_judgements", column: "dropped_positions" },
  { table: "swarm_session_judgements", column: "dropped_disagreements" },
] as const;

/** Every table this release creates, alters, locks, or writes. Preflight checks
 * this complete set against the live append-only trigger catalog. */
export const MIGRATION_TOUCHED_TABLES = [
  ...NEW_TABLES,
  "wallet_balance_samples",
  "wallet_sleeve_samples",
  "job_schedules",
  "swarm_members",
  // 0039 swaps swarm_sessions' state CHECK constraint to admit 'judged', and
  // 0042 adds a foreign key to it (and another to `swarm_session_judgements`,
  // already covered by the NEW_TABLES spread above). Like `swarm_members` above
  // these are LOCKS, not writes — an ALTER TABLE ADD CONSTRAINT removes no row,
  // so rm_append_only_guard() (BEFORE DELETE OR TRUNCATE) cannot fire on them.
  // Both tables ARE append-only protected, and
  // preflight's append-only-safety check does not currently distinguish
  // "locks" from "writes", so it reports them as collisions; that over-broad
  // rule is a defect in the check, not a reason to under-declare the roster
  // this constant exists to keep honest. See the PR for issue #807.
  "swarm_sessions",
] as const;

/**
 * The two schedules migration 0034 rewrites in place
 * (`UPDATE job_schedules SET catchup_policy = 'collapse-per-bucket'`). Captured
 * before and verified after. Migrations 0036/0037 also write existing wallet
 * sample rows, but they do not alter schedule policy.
 */
export const COLLAPSE_PER_BUCKET_KINDS = ["wallet.sample_balances", "wallet.sample_sleeves"] as const;

/** The schedule seed() adds on the first boot of this release. Live on arrival:
 *  the transport paces from a built-in default, so this dispatches unless the
 *  deployment sets BASE_RPC_MAX_CALLS_PER_SEC=0 — see the runbook §5.2. */
export const NEW_SCHEDULE_KIND = "ops.repair_gaps";

/** The migration that adds `wallet_balance_samples.strategy_nav_idle_only`.
 *  postflight reads its `applied_at` to separate rows that PREDATE the column
 *  (which must all be NULL) from rows the sampler wrote afterwards (which
 *  legitimately carry a value). */
export const NEW_COLUMN_MIGRATION = "0032_wallet_balance_samples_strategy_nav_idle_only.sql";

/** Its cron, as `seed()` writes it (backend/src/db/seed.ts). Held here so the
 *  postflight check and the §7.1 dispatch observation grade against ONE copy —
 *  and, more importantly, so a future cadence change has a single place to
 *  land. seed()'s ON CONFLICT key is `(kind, cron)`, so changing this string
 *  INSERTS a second enabled row rather than updating the first; whoever changes
 *  it must retire the old row in `seedJobSchedules()` the way `analytics.run`
 *  is retired, and postflight's `repair-schedule` check will FAIL until they
 *  do — it compares job_schedules.cron against this constant directly. (That
 *  was an aspiration rather than a fact until 2026-08-23: the check read only
 *  kind/enabled/next_run_at, so a schedule seeded on the wrong cadence was a
 *  clean PASS.) */
export const NEW_SCHEDULE_CRON = "*/5 * * * *";

/** The kind `ops.repair_gaps` enqueues: ONE job carrying `{dates: [...]}` for
 *  the whole window it decides to repair, not one job per day.
 *
 *  Changed by #739 (`79063ab`), which batches on the axis the provider actually
 *  meters — a window resolves its days' blocks in lockstep, one HTTP hit per
 *  round, instead of paying ~5 hits per day to locate blocks alone. The §7.1
 *  dispatch observation asserts THIS kind: a dispatcher that reverted to one
 *  job per day would be a regression, and must fail rather than pass quietly. */
export const BACKFILL_WINDOW_JOB_KIND = "wallet.backfill_window";

/** The pre-#739 per-day kind. Still registered as a handler so rows enqueued by
 *  a pre-upgrade dispatcher drain after the cutover
 *  (`backend/src/worker/handlers/repair.ts`), but nothing enqueues it any more —
 *  which is why §7.1 does not grade it. */
export const BACKFILL_JOB_KIND = "wallet.backfill_day";

/** What a repaired row's `provenance` column reads
 *  (backend/src/ops/wallet-backfill.ts). The §7.1 observation asserts this
 *  rather than trusting that a completed job wrote anything. */
export const BACKFILL_PROVENANCE = "backfilled";

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

/**
 * BYTE-IDENTICAL COPY of APPEND_ONLY_TABLES from src/db/append-only-guard.ts,
 * for the same reason as the constant above: that module imports db/client.ts,
 * which demands DATABASE_URL at module load and builds the app's WRITER pool.
 *
 * postflight's `append-only-intact` check needs the roster, not the guard. It
 * used to pass on ANY non-zero trigger count, so losing all but one of these
 * tables reported "guard live on 1 table(s)" and read as green — which
 * is precisely the silent partial loss the check exists to catch. Comparing
 * against a list is what makes it able to fail.
 *
 * Held in agreement with the guard by backend/tests/rollout-steps-0-3-0.test.ts.
 */
export const APPEND_ONLY_TABLES = [
  "swarm_members",
  "swarm_recommendations",
  "swarm_memos",
  "swarm_sessions",
  "swarm_briefs",
  "swarm_subjects",
  "swarm_session_events",
  "swarm_session_members",
  "swarm_subject_snapshots",
  // Opted in by migration 0040, not 0032 (issue #752's judgement record). The
  // roster is a roster of TABLES, not of migrations, so it does not care which
  // file installed the triggers — postflight compares live triggers against
  // this list.
  "swarm_session_judgements",
  // Opted in by migration 0042 (issue #754's published consensus receipt),
  // for the same reason and on the same terms as the judgement record above.
  "swarm_consensus_receipts",
  "swarm_applications",
  "audit_log",
  "agent_activity_log",
  "regime_snapshots",
  "schema_migrations",
] as const;

/** Exact custom guards added by the AUM P0/P1 migrations. Unlike the shared
 * append-only roster above, these triggers have table-specific names and
 * functions, so postflight verifies the catalog contract explicitly. `A`
 * means ENABLE ALWAYS: replication-role writes must not bypass evidence or
 * published-snapshot immutability. */
export const AUM_GUARD_TRIGGERS = [
  { table: "wallet_balance_samples", trigger: "wallet_balance_samples_snapshot_final_guard" },
  { table: "wallet_sleeve_samples", trigger: "wallet_sleeve_samples_snapshot_final_guard" },
  { table: "wallet_balance_sample_evidence", trigger: "wallet_balance_sample_evidence_immutable" },
  { table: "wallet_balance_sample_evidence", trigger: "wallet_balance_sample_evidence_immutable_row" },
  { table: "wallet_balance_sample_evidence", trigger: "wallet_balance_sample_evidence_snapshot_final_guard" },
  { table: "wallet_sleeve_sample_evidence", trigger: "wallet_sleeve_sample_evidence_immutable" },
  { table: "wallet_sleeve_sample_evidence", trigger: "wallet_sleeve_sample_evidence_immutable_row" },
  { table: "wallet_sleeve_sample_evidence", trigger: "wallet_sleeve_sample_evidence_snapshot_final_guard" },
  { table: "wallet_aum_snapshot_runs", trigger: "wallet_aum_snapshot_runs_immutable" },
  { table: "wallet_aum_snapshot_runs", trigger: "wallet_aum_snapshot_runs_immutable_row" },
  { table: "wallet_aum_snapshot_runs", trigger: "wallet_aum_snapshot_runs_finalize" },
] as const;

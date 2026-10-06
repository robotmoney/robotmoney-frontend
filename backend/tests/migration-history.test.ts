// Production's migration history and the files it has not recorded meet
// cleanly.
//
// Migrations are tracked by filename, and the runner applies every unrecorded
// file in filename order. Production runs v0.5.x, cut from releases-0.5.x, and
// has recorded the files below. Main also carries files production has never
// seen (its judge migrations 0056-0059, a second 0062, and 0099), so on
// production's first boot from main those run INTERLEAVED BEHIND files applied
// weeks earlier — an order no fresh database ever sees.
//
// This proves, against a real Postgres, that:
//   1. a database migrated with exactly production's recorded set, carrying
//      production's judge config (enforce, `opencode/deepseek-v4-flash` from
//      0063), then migrated with everything on disk, SUCCEEDS; and
//   2. it ends with the SAME schema (tables, columns, constraints, indexes,
//      triggers, functions, grants) as a database migrated fresh from 0001.
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrationFile } from "../src/db/migrate.ts";
import { adminConnection, adminUrl } from "./support/cluster.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

/**
 * Every file production has recorded, as of v0.5.2 (v0.5.3 added none):
 * `git ls-tree --name-only v0.5.2 backend/migrations/`. Written out, not
 * derived, so a new migration on either branch has to be looked at.
 */
const PRODUCTION_RECORDED = [
  "0001_backends.sql",
  "0002_dashboards.sql",
  "0003_task_queue.sql",
  "0004_committee.sql",
  "0005_job_schedules_seed.sql",
  "0006_committee_reconcile.sql",
  "0007_committee_rls_stub.sql",
  "0008_committee_memos.sql",
  "0009_analytics_v2.sql",
  "0010_backtest_correlations.sql",
  "0011_regime_dashboard_extras.sql",
  "0012_vault_share_price_history.sql",
  "0013_projects.sql",
  "0014_projects_pipelines.sql",
  "0014_wallet_balance_samples.sql",
  "0015_buyback_swaps.sql",
  "0016_worker_role.sql",
  "0017_admin_surface.sql",
  "0018_research_telemetry.sql",
  "0019_committee_self_serve_claim.sql",
  "0020_committee_agent_health.sql",
  "0021_chain_indexer_samples.sql",
  "0021_committee_waitlist.sql",
  "0022_committee_application_received_notification.sql",
  "0022_committee_session_convened_at.sql",
  "0023_agent_activity_log.sql",
  "0023_analytics_submissions.sql",
  "0023_list2_leaderboard.sql",
  "0024_analytics_provenance_source.sql",
  "0025_swarm_rename.sql",
  "0026_swarm_sessions_legacy_takes.sql",
  "0027_drop_swarm_sessions_legacy_takes.sql",
  "0028_admin_credential.sql",
  "0028_swarm_briefs_session_key.sql",
  "0028_swarm_take_revisions.sql",
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
  "0033_swarm_member_uuid_ids.sql",
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
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
  "0045_chain_address_floors.sql",
  "0046_asset_prices.sql",
  "0047_swarm_session_subject_name_backfill.sql",
  "0048_swarm_judge_third_party_flag.sql",
  "0049_swarm_recommendations_signing_key.sql",
  "0050_swarm_member_keys_append_only.sql",
  "0051_swarm_vault_recommendation_type_repair.sql",
  "0052_swarm_judgement_digest_scheme.sql",
  "0053_database_role_taxonomy.sql",
  "0054_rm_worker_allowlist.sql",
  "0055_swarm_recommendations_member_received_idx.sql",
  "0056_analytics_overwrite_events.sql",
  "0057_source_acquisition_ledger.sql",
  "0058_analytics_run_ledger.sql",
  "0059_analytics_output_and_report_snapshots.sql",
  "0059_swarm_framework_subject_snapshot_cleanup.sql",
  "0060_analytics_ledger_cutover.sql",
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0061_source_value_provenance.sql",
  "0062_rm_readonly_sequence_select.sql",
  "0063_swarm_judge_model_default.sql",
  "0080_analytics_ledger_compaction.sql",
] as const;

/** The files on disk production has NOT recorded; its next boot applies them. */
const NOT_IN_PRODUCTION = [
  "0056_swarm_judge_requires_model.sql",
  "0057_swarm_judge_policy_stamp.sql",
  "0058_swarm_judge_fault_injection.sql",
  "0059_swarm_judgement_completion_usage.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
  "0081_deployment_identity.sql",
  "0082_schema_manifest.sql",
  "0083_append_only_grant_transition.sql",
  "0084_drop_swarm_notifications.sql",
  "0085_subject_epoch_duration.sql",
  "0086_session_epoch_lifecycle.sql",
  "0087_automation_tokens.sql",
  "0088_swarm_scheduler_jobs.sql",
  "0089_drop_swarm_schedules.sql",
  "0090_subject_grid_columns.sql",
  "0091_session_judging_duration.sql",
  "0092_swarm_recommendations_final.sql",
  "0093_ledger_write_revoke.sql",
  "0094_immutable_ledger_grants.sql",
  "0095_automation_token_holders.sql",
  "0096_drop_swarm_scheduler_jobs.sql",
  "0097_stream_events_grant_only.sql",
  "0098_stream_event_counter.sql",
  "0099_swarm_judge_model_bare_id.sql",
  "0100_judge_config_two_modes.sql",
  "0101_clear_forged_member_operator.sql",
  "0102_admin_revocation_tombstones.sql",
  "0103_webauthn_challenge_consumed_at.sql",
  "0104_wallet_sample_superseded_at.sql",
  "0105_member_key_spoof_generation.sql",
  "0106_webauthn_challenge_slots.sql",
  "0107_revoke_runtime_delete.sql",
  "0108_stream_events_retention_comment.sql",
  "0109_rm_worker_wallet_evidence_insert.sql",
  "0110_drop_swarm_judge_fault_injection.sql",
  "0111_swarm_judge_model_deepseek_v4_1_flash.sql",
  "0112_rm_app_overwrite_events_read.sql",
] as const;

useCleanDatabase(import.meta.file);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const DB_URL = process.env.DATABASE_URL;
// Loud, never skipped: without tests/preload.ts there is no Postgres to migrate.
if (!DB_URL) throw new Error("DATABASE_URL is unset — tests/preload.ts must provision the ephemeral Postgres first");

type Db = ReturnType<typeof postgres>;
let admin: Db;
const made: { name: string; db: Db }[] = [];
let onDisk: string[] = [];
let production: string[] = [];

// The test's own DATABASE_URL role may not CREATE DATABASE (CI's is rm_app), so
// the throw-away databases are made and used as the cluster admin.

async function freshDatabase(label: string): Promise<Db> {
  const name = `tmp_mig_hist_${label}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const db = postgres(adminUrl(name), { max: 1, onnotice: () => {} });
  made.push({ name, db });
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  return db;
}

/** What migrate() does: every file on disk not yet recorded, in filename order. */
async function migrateRemaining(db: Db): Promise<string[]> {
  const applied = new Set((await db<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const now: string[] = [];
  for (const file of onDisk) {
    if (applied.has(file)) continue;
    await applyMigrationFile(db, file);
    now.push(file);
  }
  return now;
}

/** The schema, as sorted text rows, with nothing a database name or an OID leaks into. */
async function schemaOf(db: Db): Promise<Record<string, string[]>> {
  const rows = async (q: Promise<Record<string, unknown>[]>) =>
    (await q).map((r) => Object.values(r).map((v) => String(v)).join(" | ")).sort();
  return {
    tables: await rows(db`
      SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public'`),
    columns: await rows(db`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default, '') AS d,
             coalesce(character_maximum_length::text, '') AS len
        FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await rows(db`
      SELECT c.conrelid::regclass::text AS rel, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'`),
    indexes: await rows(db`
      SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`),
    triggers: await rows(db`
      SELECT event_object_table, trigger_name, event_manipulation, action_timing, action_statement
        FROM information_schema.triggers WHERE trigger_schema = 'public'`),
    functions: await rows(db`
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`),
    grants: await rows(db`
      SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee LIKE 'rm\\_%'`),
    sequenceGrants: await rows(db`
      SELECT c.relname, a.privilege_type, r.rolname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
             LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
       WHERE n.nspname = 'public' AND c.relkind = 'S' AND r.rolname LIKE 'rm\\_%'`),
  };
}

let upgraded: Db;
let fresh: Db;
let appliedOnUpgrade: string[] = [];

beforeAll(async () => {
  admin = adminConnection("postgres");
  onDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  production = onDisk.filter((f) => (PRODUCTION_RECORDED as readonly string[]).includes(f));

  // Production at v0.5.2, then what it looked like on 2026-09-25: the judge on
  // with 0063's provider-qualified model.
  upgraded = await freshDatabase("prod");
  for (const file of production) await applyMigrationFile(upgraded, file);
  await upgraded`UPDATE swarm_judge_config SET mode = 'enforce', model = 'opencode/deepseek-v4-flash' WHERE id = 1`;
  appliedOnUpgrade = await migrateRemaining(upgraded);

  fresh = await freshDatabase("fresh");
  await migrateRemaining(fresh);
}, 300_000);

afterAll(async () => {
  for (const { name, db } of made) {
    await db.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
  await admin?.end({ timeout: 5 });
});

describe("production's migration history meets the files it has not recorded", () => {
  test("production's recorded set is on disk, and exactly the named files are not in it", () => {
    for (const f of PRODUCTION_RECORDED) expect(onDisk).toContain(f);
    expect(onDisk.filter((f) => !production.includes(f))).toEqual([...NOT_IN_PRODUCTION]);
  });

  test("the upgrade applies exactly the files production lacks, in filename order", () => {
    expect(appliedOnUpgrade).toEqual([...NOT_IN_PRODUCTION]);
  });

  test("both databases record every file on disk", async () => {
    for (const db of [upgraded, fresh]) {
      const names = (await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((r) => r.name);
      expect(names).toEqual(onDisk);
    }
  });

  test("the upgraded database has the same schema as a fresh one", async () => {
    const [a, b] = [await schemaOf(upgraded), await schemaOf(fresh)];
    for (const key of Object.keys(b)) {
      expect({ [key]: a[key] }).toEqual({ [key]: b[key] });
    }
    // Not vacuous: the judge columns main added are present in both.
    expect(a.columns.some((c) => c.startsWith("swarm_judge_config | policy_updated_at"))).toBe(true);
    expect(a.columns.some((c) => c.startsWith("swarm_session_judgements | usage_cost_usd"))).toBe(true);
  });

  test("the judge keeps its mode and ends on the bare model id, on both paths", async () => {
    const [u] = await upgraded`SELECT mode, model FROM swarm_judge_config WHERE id = 1`;
    expect(u).toEqual({ mode: "enforce", model: "deepseek-v4.1-flash" });
    const [f] = await fresh`SELECT model FROM swarm_judge_config WHERE id = 1`;
    expect(f!.model).toBe("deepseek-v4.1-flash");
  });
});

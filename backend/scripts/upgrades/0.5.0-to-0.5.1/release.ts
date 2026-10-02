/** Facts unique to the v0.5.0 -> v0.5.1 upgrade. */
export const TAG_GLOB = "v0.5.1*";

/**
 * v0.5.1 APPLIES TWO MIGRATIONS to production: 0061 and 0063.
 *
 * Production shipped v0.5.1 from the release branch with these two pending
 * (issue 1074 corrected main's earlier record, which named 0062 as the one
 * migration). Both are small repairs, not features:
 *
 * - `0061_rm_worker_wallet_backfill_grant.sql`: rm_worker writes the
 *   wallet-backfill tables (chain_day_blocks, wallet_backfill_state,
 *   chain_address_floors), which 0054's allow-list missed.
 * - `0063_swarm_judge_model_default.sql`: the judge gets the CI model where
 *   none is set.
 *
 * `0062_rm_readonly_sequence_select.sql` is NOT part of this release. It
 * fixed `pg_dump` as `rm_readonly` and production applied it out of band on
 * 2026-09-22, so it is already recorded before v0.5.1 and does not run.
 */
export const RELEASE_MIGRATIONS = [
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0063_swarm_judge_model_default.sql",
] as const;

/**
 * Everything v0.5.1 must find already recorded and must preserve unchanged:
 * v0.4.0's six migrations plus the eighteen v0.5.0 ships (0045-0061; 0059
 * numbers two files), plus the out-of-band 0062 (see RELEASE_MIGRATIONS).
 * The first twenty-four are the union of `0.4.0-to-0.5.0`'s own
 * PRIOR_RELEASE_MIGRATIONS and RELEASE_MIGRATIONS, restated here rather than
 * imported: a release directory is a frozen artefact, and importing across
 * directories would make this release's gate depend on a file its `dependsOn`
 * glob (`backend/scripts/upgrades/0.5.0-to-0.5.1/**`) does not cover -- drift
 * in 0.5.0's copy would silently not invalidate a v0.5.1 receipt.
 */
export const PRIOR_RELEASE_MIGRATIONS = [
  // v0.4.0
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
  // v0.5.0
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
  "0061_source_value_provenance.sql",
  // Applied to production out of band on 2026-09-22, before v0.5.1.
  "0062_rm_readonly_sequence_select.sql",
] as const;

/** The v0.4.0 runtime tables both gates assert remain present. */
export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
  // The tables 0061 grants on.
  "wallet_backfill_state",
  "chain_day_blocks",
] as const;

/**
 * v0.5.1 creates NO table. `0061` is grants only and `0063` sets a default
 * on an existing table. Kept as a named export so the
 * "does this release add tables?" question has the same shape of answer in
 * every release directory instead of being absent where the answer is no.
 */
export const NEW_RELEASE_TABLES_BY_MIGRATION: Readonly<Record<string, readonly string[]>> = {};

/** Every table v0.5.1 adds -- none. */
export const NEW_RELEASE_TABLES: readonly string[] = Object.values(NEW_RELEASE_TABLES_BY_MIGRATION).flat();

/**
 * Every table v0.5.0's migrations created, which v0.5.1 must find intact.
 * A code-only release has no "these must be ABSENT" set, so this is the
 * direction its table checks run in: absence here is drift, not a clean
 * baseline. Derived from 0.4.0-to-0.5.0/release.ts's
 * NEW_RELEASE_TABLES_BY_MIGRATION, flattened.
 */
export const PRESERVED_RELEASE_TABLES: readonly string[] = [
  "chain_address_floors",
  "asset_prices",
  "asset_price_floors",
  "analytics_overwrite_events",
  "source_acquisitions",
  "source_acquisition_events",
  "source_payloads",
  "source_fetches",
  "source_value_versions",
  "analytics_ledger_methodology_versions",
  "analytics_ledger_runs",
  "analytics_ledger_run_events",
  "analytics_data_vintages",
  "analytics_vintage_members",
  "analytics_output_snapshots",
  "analytics_report_snapshots",
  "swarm_brief_revisions",
  "analytics_read_mode",
  "analytics_parity_observations",
];

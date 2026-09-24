/** Facts unique to the v0.5.0 -> v0.5.1 upgrade. */
export const TAG_GLOB = "v0.5.1*";

/**
 * v0.5.1 CARRIES EXACTLY ONE MIGRATION, and it exists to repair a defect the
 * release did not cause.
 *
 * The release began as code-only: the application delta over `v0.5.0-rc.9` is
 * the swarm session lifecycle fixes, the API pool timeouts, the judge-job wait
 * and the e2e verify gates, none of which touches the schema. It stopped being
 * code-only when the stage gates found that `pg_dump` could not run as
 * `rm_readonly` -- twelve of production's forty `public` sequences deny it a
 * read, so P3.backup fails before a rollout can start.
 *
 * `0062` is therefore a GATE REPAIR, not a feature: it is the migration that
 * makes the next backup possible. It ships here rather than in v0.6 because
 * the alternative is a manual `psql` GRANT against the production primary
 * before every release, which is the kind of undocumented hand-step that
 * produced the defect in the first place. Deploying v0.5.1 fixes production;
 * nobody has to remember anything.
 *
 * See `backend/tests/migration-readonly-sequence-grant.test.ts` for the guard
 * that stops the pattern returning, which is the durable half of the fix.
 */
export const RELEASE_MIGRATIONS = ["0062_rm_readonly_sequence_select.sql"] as const;

/**
 * Everything v0.5.1 must find already recorded and must preserve unchanged:
 * v0.4.0's six migrations plus the eighteen v0.5.0 ships (0045-0061; 0059
 * numbers two files). This is the union of `0.4.0-to-0.5.0`'s own
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
] as const;

/** The v0.4.0 runtime tables both gates assert remain present. */
export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
] as const;

/**
 * v0.5.1 creates NO table. `0062` is grants only -- one GRANT over existing
 * sequences and one ALTER DEFAULT PRIVILEGES. Kept as a named export so the
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

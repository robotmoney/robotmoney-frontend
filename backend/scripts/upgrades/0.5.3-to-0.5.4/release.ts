/** Facts unique to the v0.5.3 -> v0.5.4 upgrade: a backend and driver patch with no migration. */
export const TAG_GLOB = "v0.5.4*";

/**
 * Written out, not imported: a release directory must not import across
 * directories (see 0.5.0-to-0.5.1/release.ts).
 * What production records at v0.5.3 (its backend is v0.5.2's): v0.5.1's set plus v0.5.2's 0080.
 */
export const PRIOR_RELEASE_MIGRATIONS = [
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
  "0061_source_value_provenance.sql",
  "0062_rm_readonly_sequence_select.sql",
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0063_swarm_judge_model_default.sql",
  "0080_analytics_ledger_compaction.sql",
] as const;

/** v0.5.4 applies no migration. Anything pending on the dump is drift, not this release. */
export const RELEASE_MIGRATIONS = [] as const;

/** Tables the v0.5.4 changes read or write, which must exist in a v0.5.3 dump. */
export const REQUIRED_TABLES = [
  "swarm_sessions",
  "swarm_brief_revisions",
  "swarm_session_judgements",
  "source_fetches",
  "buyback_swaps",
  "buyback_scan_state",
] as const;

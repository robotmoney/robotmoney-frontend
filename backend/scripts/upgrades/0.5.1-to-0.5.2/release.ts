/** Facts unique to the v0.5.1 -> v0.5.2 upgrade. */
export const TAG_GLOB = "v0.5.2*";

/**
 * Written out, not imported: a release directory must not import across
 * directories (see 0.5.0-to-0.5.1/release.ts).
 * What production records at v0.5.1: v0.5.0's set, the out-of-band 0062, and v0.5.1's 0061 and 0063.
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
] as const;

/**
 * The one migration v0.5.2 applies: the analytics-ledger schema change (issue
 * 1035, PRs 1046 and 1051). It is not reversible: it DROPS source_payloads,
 * which v0.5.1's writer still inserts into. The ledger's data is repaired
 * separately, once, by ledger-repair.ts in this folder (runbook R6.4c), which
 * is not reversible either. Going back to v0.5.1 after either therefore needs
 * a database restore (R3 backup or point-in-time), not only old code.
 */
export const RELEASE_MIGRATIONS = ["0080_analytics_ledger_compaction.sql"] as const;

/** Tables 0080 compacts or drops, which must exist in a v0.5.1 dump. */
export const REQUIRED_TABLES = [
  "source_value_versions",
  "analytics_vintage_members",
  "analytics_overwrite_events",
  "source_payloads",
] as const;

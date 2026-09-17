/** Facts unique to the v0.4.1 -> v0.4.2 upgrade. */
export const TAG_GLOB = "v0.4.2*";

/** Schema facts v0.4.2 must preserve unchanged from v0.4.1 (which added no migrations of its own). */
export const PRIOR_RELEASE_MIGRATIONS = [
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
] as const;

/**
 * The sixteen additive migration files v0.4.2 ships (0045-0059; 0059 numbers
 * two files). Unlike the original four, this set was aligned to the full
 * v0.4.2 merge of main, so it spans every migration the release tree carries
 * beyond PRIOR_RELEASE_MIGRATIONS. None touches the v0.4.0 tables above: it
 * adds the D41 price-series tables and chain address-floor cache (#760/#849,
 * D41), a one-time subject_name backfill (#779), the judge-config column
 * (#796), take/key integrity and subject repairs (#697/#780), the judgement
 * digest scheme (#829, D44), the database role taxonomy and worker
 * allow-list (#692), a take-lookup index (#782), the Phase A research
 * integrity ledgers and output/run snapshots (#974/#976/#977/#978), and the
 * framework-subject snapshot cleanup (#960). All are additive: new tables,
 * new nullable/defaulted columns, new roles and grants, an append-only guard
 * on swarm_member_keys, one index, and idempotent one-time data fixes.
 */
export const RELEASE_MIGRATIONS = [
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
] as const;

export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
] as const;

/** Tables the v0.4.2 migrations create; must be absent before migrating, present after. */
export const NEW_RELEASE_TABLES = [
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
] as const;

/** Facts unique to the v0.4.0 -> v0.5.0 upgrade. */
export const TAG_GLOB = "v0.5.0*";

/** Schema facts v0.5.0 must preserve unchanged from v0.4.0 — the six migrations
 *  0.3.0-to-0.4.0's own postflight certifies. The 0.4.1 and 0.4.2 releases these
 *  gates were first written for were abandoned and never shipped, so v0.4.0 is
 *  the production baseline v0.5.0 upgrades from. */
export const PRIOR_RELEASE_MIGRATIONS = [
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
] as const;

/**
 * The eighteen additive migration files v0.5.0 ships (0045-0061; 0059 numbers
 * two files). The set is aligned to this branch's own tree rather than to any
 * earlier folder's manifest, so it spans every migration the release carries
 * beyond PRIOR_RELEASE_MIGRATIONS. Note that 0.3.0-to-0.4.0's
 * THIS_RELEASE_MIGRATIONS also lists 0053 and 0054: that folder is a frozen
 * artefact of an already-tagged release and is left as it stands, but those two
 * files are this release's, not v0.4.0's. None touches the v0.4.0 tables above: it
 * adds the D41 price-series tables and chain address-floor cache (#760/#849,
 * D41), a one-time subject_name backfill (#779), the judge-config column
 * (#796), take/key integrity and subject repairs (#697/#780), the judgement
 * digest scheme (#829, D44), the database role taxonomy and worker
 * allow-list (#692), a take-lookup index (#782), the Phase A research
 * integrity ledgers and output/run snapshots (#974/#976/#977/#978), the
 * framework-subject snapshot cleanup (#960), and the analytics dual-write
 * parity + cutover switch (#979): the analytics_read_mode operator switch
 * and its immutable analytics_parity_observations evidence, plus
 * source_value_versions provenance (#988). All are additive: new tables,
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
  "0060_analytics_ledger_cutover.sql",
  "0061_source_value_provenance.sql",
] as const;

export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
] as const;

/** Tables the v0.5.0 migrations create; must be absent before migrating, present after. */
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
  "analytics_read_mode",
  "analytics_parity_observations",
] as const;

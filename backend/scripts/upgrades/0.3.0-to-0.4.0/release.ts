/** Facts unique to the v0.3.0 -> v0.4.0 upgrade. */
export const TAG_GLOB = "v0.4.0*";
export const THIS_RELEASE_MIGRATIONS = [
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
] as const;
export const PRIOR_RELEASE_MIGRATIONS = [
  "0032_append_only_history.sql",
  "0033_wallet_backfill.sql",
  "0038_wallet_aum_snapshot_foundation.sql",
] as const;
export const JUDGEMENT_TABLE = "swarm_session_judgements";
export const RECEIPT_TABLE = "swarm_consensus_receipts";
export const JUDGE_CONFIG_TABLE = "swarm_judge_config";

/** Facts unique to the v0.4.0 -> v0.4.1 code-only upgrade. */
export const TAG_GLOB = "v0.4.1*";

/** v0.4.1 adds no migrations. These are the schema facts it must preserve. */
export const PRIOR_RELEASE_MIGRATIONS = [
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
] as const;

export const RELEASE_MIGRATIONS = [] as const;
export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
] as const;

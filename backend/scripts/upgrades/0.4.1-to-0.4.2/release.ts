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
 * Four additive migrations, none of which touch the tables above: a
 * chain-fact cache, the D41 price-series tables (seeded from existing
 * live/seed rows), a one-time subject_name backfill, and a new judge-config
 * column. See docs/decisions.md D41 and issues #760, #779, #796.
 */
export const RELEASE_MIGRATIONS = [
  "0045_chain_address_floors.sql",
  "0046_asset_prices.sql",
  "0047_swarm_session_subject_name_backfill.sql",
  "0048_swarm_judge_third_party_flag.sql",
] as const;

export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
] as const;

/** Tables 0045/0046 create; must be absent before migrating, present after. */
export const NEW_RELEASE_TABLES = [
  "chain_address_floors",
  "asset_prices",
  "asset_price_floors",
] as const;

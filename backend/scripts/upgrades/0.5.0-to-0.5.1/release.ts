/** Facts unique to the v0.5.0 -> v0.5.1 upgrade. */
import { PRIOR_RELEASE_MIGRATIONS as V040, RELEASE_MIGRATIONS as V050 } from "../0.4.0-to-0.5.0/release.ts";

export const TAG_GLOB = "v0.5.1*";

/**
 * What production records before this release: v0.5.0's full set, plus
 * `0062_rm_readonly_sequence_select.sql`, which production applied out of band
 * from the abandoned 0.5.x work (runbook D6). v0.5.1 carries that file
 * unchanged, so on production it is already recorded and does not run.
 */
export const PRIOR_RELEASE_MIGRATIONS = [...V040, ...V050, "0062_rm_readonly_sequence_select.sql"] as const;

/** The migrations v0.5.1 applies to production: exactly these, and nothing else pending. */
export const RELEASE_MIGRATIONS = [
  "0061_rm_worker_wallet_backfill_grant.sql", // D2: rm_worker writes the wallet-backfill tables
  "0063_swarm_judge_model_default.sql", // D1: the judge gets the CI model where none is set
] as const;

/** Tables this release's migrations touch, which must exist in the dump. */
export const REQUIRED_TABLES = [
  "swarm_judge_config",
  "swarm_session_judgements",
  "swarm_consensus_receipts",
  "wallet_backfill_state",
  "chain_day_blocks",
] as const;

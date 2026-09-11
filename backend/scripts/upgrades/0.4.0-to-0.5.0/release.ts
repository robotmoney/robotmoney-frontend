// Facts about the v0.4.0 -> v0.5.0 upgrade itself, that the GATE SCRIPTS
// execute against. Same split as every prior release's release.ts: a
// constant a check reads lives here, a label a human reads lives in the
// runbook.
//
// WHY THIS BOUNDARY, AND NOT ANOTHER ONE. Production, verified directly by a
// fresh replica capture on 2026-09-11 (a `bun run smoke:twin` boot's own
// `migrate()` step, which only ever applies what schema_migrations does not
// already have), is at migration 0048. The seven files below are exactly what
// that boot applied — nothing on disk past 0048 was already there.
//
// `backend/scripts/upgrades/0.3.0-to-0.4.0/release.ts` ALSO lists `0053` and
// `0054` in its own THIS_RELEASE_MIGRATIONS, which looks like an overlap with
// the list below. It is not a second source of truth to reconcile so much as
// a leftover of a process gap: `docs/technical/release-runbooks.md` §9
// documents a rolling `backend/scripts/upgrades/next/` directory for exactly
// this situation — migrations accumulating on a release branch before the
// next version number is decided — and that directory was never created for
// this cycle. Every migration merged after v0.4.0 shipped (0045 through
// 0055) landed by being appended to the already-tagged 0.3.0-to-0.4.0 folder
// instead, which is why that folder's list runs past what v0.4.0 actually
// certified. That folder is left exactly as it stands (an applied migration's
// upgrade record is a frozen artefact — see its own steps.ts header and
// smoke-twin-rehearsal.ts) rather than edited after the fact; this file is
// the first accurate accounting of what is actually still pending, taken
// from the database production is really running rather than from what an
// older folder's manifest claims.
export const THIS_RELEASE_MIGRATIONS = [
  "0049_swarm_recommendations_signing_key.sql",
  "0050_swarm_member_keys_append_only.sql",
  "0051_swarm_vault_recommendation_type_repair.sql",
  "0052_swarm_judgement_digest_scheme.sql",
  "0053_database_role_taxonomy.sql",
  "0054_rm_worker_allowlist.sql",
  "0055_swarm_recommendations_member_received_idx.sql",
] as const;

/**
 * The migrations v0.4.0 actually shipped to production and that this upgrade
 * requires as its starting point — 0.3.0-to-0.4.0's own THIS_RELEASE_MIGRATIONS,
 * TRIMMED to the six files that folder's postflight (postflight-0.4.0)
 * certifies, per the note above: `0053`/`0054` are this release's, not that
 * one's, whatever that folder's own list says.
 */
export const PRIOR_RELEASE_MIGRATIONS = [
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
] as const;

/** 0049's new column: the exact `swarm_member_keys` row that verified a take
 *  at submission time (issue #697). Nullable, no backfill by design — every
 *  row written before this migration keeps resolving through the member's
 *  currently-active key (see the migration's own header). */
export const SIGNING_KEY_COLUMN = { table: "swarm_recommendations", column: "signing_key_id" } as const;

/** 0052's new column: which canonical form produced a judgement's stored
 *  inputs_digest (issue #829, D44). NOT NULL DEFAULT'd, safe because no row
 *  predates it on any deployment that shipped `off` as its default. */
export const DIGEST_SCHEME_COLUMN = { table: "swarm_session_judgements", column: "digest_scheme" } as const;
export const DIGEST_SCHEME_DEFAULT = "derivation-v1";

/** The two subjects 0051 self-heals, and the value they must read afterward. */
export const REPAIRED_SUBJECTS = ["robotmoney-vault", "robotmoney-allocation"] as const;
export const REPAIRED_RECOMMENDATION_TYPE = "bucket_weights";

/** 0053's new roles. `rm_owner` is NOLOGIN — a role that owns schema objects
 *  but that no persistent process may authenticate as. */
export const OWNER_ROLE = "rm_owner";
export const RUNTIME_ROLES = ["rm_app", "rm_worker", "rm_readonly"] as const;

/** 0054's replacement for 0016's broad/default worker grant: the ONLY tables
 *  `rm_worker` may INSERT/UPDATE/DELETE on. Everything else it can only
 *  SELECT — in particular, none of the judge/receipt/append-only tables. */
export const WORKER_WRITABLE_TABLES = [
  "jobs", "job_runs", "job_schedules",
  "vault_share_price_history", "vault_adapter_samples",
  "wallet_balance_samples", "wallet_sleeve_samples",
  "projects", "openclaw_agents", "lobster_coins", "tracked_wallets", "agent_vaults",
  "agent_revenue_daily", "daily_coin_snapshots", "daily_agent_snapshots",
  "daily_wallet_snapshots", "daily_tvl_snapshots",
] as const;

/** 0055's new index — makes getMembers()'s per-member `max(received_at)`
 *  lateral (issue #782, `lastTakeAt`) an index-only walk instead of a scan. */
export const MEMBER_RECEIVED_INDEX = { table: "swarm_recommendations", index: "swarm_recommendations_member_received_idx" } as const;

/** Selects this release's tags and no others. */
export const TAG_GLOB = "v0.5.0*";

-- Issue #1035: the schema the fixed analytics-ledger writers need. Vintage
-- membership gets a representation that does not copy itself on every freeze,
-- and the raw response bodies nothing reads stop being kept.
--
-- WHY. Between the v0.5.0 cutover (2026-09-21) and 2026-09-24 the production
-- database grew from ~40 MB to 6.1 GB, and to 14 GB by 2026-09-28. Nearly all of
-- it was ledger duplication:
--   * source_value_versions — a row per point per fetch, float32 noise recorded
--     as revisions, and a row per 'live'/'seed' relabel.
--   * analytics_vintage_members — ~172k member rows copied per vintage.
--   * analytics_overwrite_events — raw_indicator_history rewrites that differed
--     only by noise or label.
--   * source_payloads — every fetch's whole response body, ~200 MB/day.
-- The writers stop doing this in the same release (store/source-ledger-store.ts,
-- store/raw-history-store.ts, store/run-ledger-store.ts; tolerances in
-- analytics/source-tolerance.ts, decision D56).
--
-- THE DATA IS NOT REPAIRED HERE. Returning the existing ledger to what the
-- fixed writers would have written (the owner's rule, issue #1050) is a
-- one-time operation on production's data, not a schema change every database
-- needs: backend/scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts, run by the
-- v0.5.2 runbook (R4.3h on the twin, R6.4c in production). As a migration it
-- ran as one statement past the api's 5-minute statement_timeout on
-- production's volume (stage-2 twin rehearsal, 2026-09-28), and every fresh or
-- CI database would have run it for nothing.
--
-- REWRITTEN IN PLACE, not a new migration: no persistent database has recorded
-- 0080 (production's ledger ends at v0.5.1; the stage twins restore a fresh
-- v0.5.1 dump each run; only ephemeral test databases had applied it).
--
-- NUMBERED 0080, not 0063: 0063 is taken on the v0.5.1 release branch
-- (0063_swarm_judge_model_default) and 0063-0079 on the deployment-refactor
-- branch (issue #1026). A filename no other branch uses keeps this file's
-- schema_migrations key unique whichever of them lands first.
--
-- No GRANT or REVOKE is issued: the new column is covered by the table-level
-- grants 0058 and 0062 already made, and the grants on source_payloads go with
-- the table when it is dropped.

-- ── 1. Vintage membership as runs of consecutive version ids ────────────────
-- A member row now covers [source_value_version_id, last_source_value_version_id]
-- — every id in that range, all under the row's source_key (see memberRanges in
-- store/run-ledger-store.ts). NULL is the single-id row. Adding a nullable
-- column with no default rewrites nothing and fires no row trigger, so the
-- table's immutability guards stay armed throughout.
ALTER TABLE analytics_vintage_members
  ADD COLUMN last_source_value_version_id bigint
    CONSTRAINT analytics_vintage_members_last_version_fkey REFERENCES source_value_versions(id),
  ADD CONSTRAINT analytics_vintage_members_range_check
    CHECK (last_source_value_version_id IS NULL OR last_source_value_version_id > source_value_version_id);

COMMENT ON COLUMN analytics_vintage_members.last_source_value_version_id IS
  'Issue #1035: when set, this row stands for EVERY source_value_versions id from source_value_version_id to this one inclusive (all consecutive, all under source_key). NULL means the single id source_value_version_id.';

-- The new foreign key needs an index led by its referencing column, or any
-- check against it is a scan of this table. Partial: a single-id row has none.
CREATE INDEX analytics_vintage_members_last_version_idx
  ON analytics_vintage_members (last_source_value_version_id)
  WHERE last_source_value_version_id IS NOT NULL;

-- ── 2. Stop keeping raw response bodies: drop source_payloads ───────────────
-- Every fetch returns a series' WHOLE history, so every new day or jittered
-- point stored the full history again as a new content-addressed blob — about
-- 200 MB a day, never deleted, and read by nothing. The ledger's job is to
-- catch and tag revised source data, which source_value_versions does; the
-- bodies duplicated it (decision D56). source_fetches.response_checksum stays
-- as a plain fingerprint of what each response contained; only its foreign
-- key into the dropped table goes. DROP TABLE removes the table's own
-- immutability triggers with it; the guard inventories
-- (src/db/analytics-ledger-guard.ts, src/db/append-only-guard.ts) no longer
-- list it, so both still report armed.
ALTER TABLE source_fetches DROP CONSTRAINT source_fetches_response_checksum_fkey;
DROP TABLE source_payloads;

COMMENT ON COLUMN source_fetches.response_checksum IS
  'SHA-256 of the response body, a fingerprint only. The body itself is not stored (issue #1035, decision D56; source_payloads dropped by migration 0080).';

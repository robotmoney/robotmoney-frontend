-- compat: additive
-- metadata_version: 1
--
-- The take's final flag — issue #1026 W3, D51 (docs/decisions.md) and
-- docs/technical/smoke-production-spec.md §6.2.
--
-- D51: "Each take carries a final flag. Accepting a new take sets that take
-- final and unsets the member's previous one, so at every instant a member has
-- exactly one final take in a session. Every read that means 'the session's
-- takes' selects the final ones." And: "Add the final flag with a migration
-- that backfills each legacy session's newest revision per member as final."
--
-- This file is the schema half: the column, the backfill, the uniqueness and
-- the privilege. The accepting transaction that sets and unsets the flag, and
-- the reads that select on it, are later work; until then every new take lands
-- with `final = false` and nothing reads the column.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE BACKFILL
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The newest revision per (session_id, member_id) is final, which is what
-- every current read resolves to already (`ORDER BY revision DESC`). Migration
-- 0028's UNIQUE (session_id, member_id, revision) makes "the newest" one row,
-- never a tie.
--
-- `swarm_recommendations` is append-only (0032), and its guard triggers fire on
-- DELETE and TRUNCATE only — `rm_append_only_guard()` is installed
-- `BEFORE DELETE OR TRUNCATE` and `BEFORE DELETE ... FOR EACH ROW`. D51 says so
-- in as many words: "the table's guard triggers block only DELETE and
-- TRUNCATE, so setting it is permitted as written." No trigger is disabled
-- here, because none is in the way.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PARTIAL UNIQUE INDEX
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `UNIQUE (session_id, member_id) WHERE final` is what makes "exactly one
-- final take" structural rather than a property of one code path. Two racing
-- amendments that each try to become final serialize on this index: the loser
-- gets a unique violation instead of leaving the member with two final takes.
-- D51 explains why it is partial: a plain UNIQUE (session_id, member_id) cannot
-- be added to a table that already holds several rows per member.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PRIVILEGE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- D51 keeps D33's rule that "an accepted take's content is never UPDATEd".
-- Migration 0053 granted rm_app table-wide UPDATE on every table, this one
-- included, and backend/schema/grants.sql re-granted it on every
-- reconciliation — so the rule was a convention. After this file rm_app may
-- UPDATE exactly one column, `final`, and a statement that rewrites a stance,
-- a payload or a signature is refused by grant (42501) whatever code runs it.
--
-- A table-level REVOKE also removes column-level grants, so the REVOKE comes
-- first and the column GRANT second. rm_worker holds only SELECT here (0054's
-- allowlist never included this table); the REVOKE names it anyway so a
-- hand-widened grant does not survive the migration. schema/grants.sql
-- re-asserts the same shape on every migrate run.
--
-- ADDITIVE. A defaulted column, an index no existing row violates (the backfill
-- marks one row per pair), and a privilege no runtime code uses: no path in
-- backend/src UPDATEs swarm_recommendations.

ALTER TABLE swarm_recommendations
  ADD COLUMN IF NOT EXISTS final boolean NOT NULL DEFAULT false;

UPDATE swarm_recommendations r
   SET final = true
  FROM (
    SELECT DISTINCT ON (session_id, member_id) id
      FROM swarm_recommendations
     ORDER BY session_id, member_id, revision DESC
  ) newest
 WHERE r.id = newest.id
   AND NOT r.final;

CREATE UNIQUE INDEX IF NOT EXISTS swarm_recommendations_one_final_per_member
  ON swarm_recommendations (session_id, member_id)
  WHERE final;

REVOKE UPDATE ON swarm_recommendations FROM rm_app, rm_worker;
GRANT UPDATE (final) ON swarm_recommendations TO rm_app;

COMMENT ON COLUMN swarm_recommendations.final IS
  'Whether this take is the member''s counting take for the session (D51). Exactly one per (session_id, member_id), enforced by swarm_recommendations_one_final_per_member. The only column rm_app may UPDATE: a take''s content is never rewritten.';

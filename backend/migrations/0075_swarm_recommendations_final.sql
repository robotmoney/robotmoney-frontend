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
-- This file is the schema half: the column, the backfill, the uniqueness, the
-- privilege and the insert trigger that keeps the invariant true for writers
-- that do not know the column exists. The accepting transaction that sets and
-- unsets the flag itself, and the reads that select on it, are later work.
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
-- ─────────────────────────────────────────────────────────────────────────────
-- THE INSERT TRIGGER — WRITERS THAT PREDATE THE COLUMN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The backfill runs once. Smoke spec §8.5 migrates an additive release against
-- the running stack, so the OLD code keeps accepting takes between `bun run
-- migrate` and the new images booting — and again after a code-only rollback,
-- and on any database that applies this file before the accepting transaction
-- learns to set the flag. Every one of those inserts omits `final`, so it would
-- land on the column default (false): a new member's only take would have no
-- final row, and an amendment would leave the OLD revision final. Once the
-- reads select `WHERE final`, both are silently wrong.
--
-- `swarm_recommendations_default_final` closes that gap in the database, where
-- it holds whatever code runs. BEFORE INSERT, for a row arriving with
-- `final = false` that is the member's newest revision in the session, it
-- clears the member's previous final take and marks the new row final — the
-- D51 acceptance rule, applied for a writer that does not know it.
--
--   * A row inserted with `final = true` passes untouched: a writer that knows
--     D51 does its own unsetting, and the partial unique index still refuses
--     two final rows when it gets that wrong or races.
--   * A row that is NOT the newest revision (an older revision replayed after a
--     newer one) stays non-final: the newest revision is the counting take,
--     exactly as the backfill decides it.
--   * Two old-code inserts racing for one member already collide on 0028's
--     UNIQUE (session_id, member_id, revision); if they carried different
--     revisions, the second's UPDATE waits on the first's row lock, and its
--     final row then meets the first's on the partial index (23505) — the same
--     serialization the header above describes for racing amendments.
--     A refused insert rolls its statement back, the trigger's UPDATE with it.
--   * Never pair an INSERT into this table with `ON CONFLICT DO NOTHING`.
--     BEFORE ROW triggers fire before the conflict check, so the unset of the
--     old final take would commit while the new row is skipped, leaving the
--     member with no final take. Today's only writer (swarm/domain.ts) has no
--     ON CONFLICT clause.
--
-- The function runs with the inserter's privileges. rm_app, the only runtime
-- role that inserts takes, holds SELECT on the table and UPDATE on `final`
-- (below), which is all the function uses.
--
-- ADDITIVE. A defaulted column, an index no existing row violates (the backfill
-- marks one row per pair), a privilege no runtime code uses (no path in
-- backend/src UPDATEs swarm_recommendations), and a trigger that only sets the
-- column no existing statement reads.

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

CREATE OR REPLACE FUNCTION swarm_recommendations_default_final() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- A writer that knows D51 set the flag itself; the partial unique index
  -- is its check.
  IF NEW.final THEN
    RETURN NEW;
  END IF;
  -- Only the member's newest revision in the session is the counting take.
  IF EXISTS (
    SELECT 1 FROM public.swarm_recommendations
     WHERE session_id = NEW.session_id
       AND member_id = NEW.member_id
       AND revision >= NEW.revision
  ) THEN
    RETURN NEW;
  END IF;
  UPDATE public.swarm_recommendations
     SET final = false
   WHERE session_id = NEW.session_id
     AND member_id = NEW.member_id
     AND final;
  NEW.final := true;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS swarm_recommendations_default_final_trigger ON swarm_recommendations;
CREATE TRIGGER swarm_recommendations_default_final_trigger
  BEFORE INSERT ON swarm_recommendations
  FOR EACH ROW EXECUTE FUNCTION swarm_recommendations_default_final();

COMMENT ON COLUMN swarm_recommendations.final IS
  'Whether this take is the member''s counting take for the session (D51). Exactly one per (session_id, member_id), enforced by swarm_recommendations_one_final_per_member. The only column rm_app may UPDATE: a take''s content is never rewritten.';

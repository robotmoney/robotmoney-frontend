-- `swarm_member_keys` joins the append-only set (issue #697).
--
-- WHY THIS REVERSES 0032's ORIGINAL CALL. `src/db/append-only-guard.ts`
-- excluded this table with the stated reason "key lifecycle, not history: an
-- operator must be able to remove a key". That reasoning was already wrong
-- the day it was written: every REAL removal path (deactivateMemberAdmin,
-- reactivateMemberAdmin, rotateMemberKeyAdmin — swarm/admin.ts) has always
-- retained the old row as `active = false`, never deleted it. No operator
-- need was ever actually served by permitting DELETE here; the one thing the
-- exclusion did was let swarm/domain.ts's registerMember hard-DELETE every key
-- row on re-registration (fixed in the same commit as this migration, to
-- deactivate like every other path). The stated reason was retroactively
-- describing that bug, not a real requirement — issue #697's own framing.
--
-- WHY IT MATTERS NOW THAT IT DIDN'T SEEM TO BEFORE. Migration 0032's own
-- header states the invariant this repo is actually protecting: "the
-- signatures were made by keys the server never held" — i.e. a signed take's
-- verifiability depends on material the server did not create and cannot
-- reconstruct. A `swarm_member_keys` row IS exactly that material for the
-- take(s) it verified. Protecting `swarm_recommendations` from deletion while
-- leaving the keys that make its rows checkable freely deletable is the same
-- defect 0032's header calls out for jobs.job_id → audit_log.job_id: "the
-- guard preserves rows; it does not preserve every fact recorded in them" —
-- except here the missing fact is the one the append-only guarantee exists
-- for in the first place.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 0032, and why the DO block below
-- is the same shape as 0032's and 0040's: see 0040_swarm_judgements_append_only.sql's
-- header — an applied migration is a frozen artefact, so a table joining the
-- protected set after the fact is always a new file re-running the same DO
-- block over just the new table(s).
--
-- WHAT THIS DOES NOT CHANGE. UPDATE is still permitted — `active = false` is
-- exactly how every real rotation/deactivation path already retires a key,
-- and that stays the correct operation. This migration only forecloses
-- DELETE and TRUNCATE, the operations that were never actually needed.

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'swarm_member_keys'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'append-only guard: table % does not exist, skipping', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');

    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only_row', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only_row', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only_row');
  END LOOP;
END;
$$;

COMMENT ON TABLE swarm_member_keys IS
  'Append-only key-history record (migrations 0004, 0050). A row is retired with active = false, never deleted; protected by rm_append_only_guard() so a take''s signing key can never be discarded out from under it. See issue #697.';

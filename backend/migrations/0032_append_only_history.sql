-- Append-only enforcement for the historical record.
--
-- WHY. The swarm record is a chain of facts: a signed take, the memo it cites,
-- the session that produced it, the member who authored it. None of that is
-- editable by deletion, and none of it can be reconstructed once gone — the
-- signatures were made by keys the server never held. Until this migration
-- that was CONVENTION ONLY. `resetSessions()` had been a dev-only
-- `TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions RESTART
-- IDENTITY CASCADE`; it was removed by hand and swarm/domain.ts:1219 records
-- why ("Nothing wipes rows any more"). Nothing stopped the next caller from
-- re-adding it, and nothing stopped a hand-run `psql` at 3am either.
--
-- A comment is not an invariant. This is the invariant.
--
-- WHAT THIS DOES. A statement-level BEFORE trigger on each protected table
-- that raises on DELETE and on TRUNCATE. Three properties matter and each is
-- deliberate:
--
--   1. FOR EACH STATEMENT, not FOR EACH ROW. A row-level trigger never fires
--      for `DELETE ... WHERE false`, so the guard would be absent for exactly
--      the probe that tests it, and present only when damage was already being
--      done. Statement-level refuses the OPERATION, regardless of what it
--      matched.
--
--   2. ENABLE ALWAYS, not plain ENABLE. `session_replication_role = 'replica'`
--      — what a restore and a logical-replication apply run as — silently
--      SKIPS ordinary triggers. Migration 0031 already learned this for the
--      handle namespace; the same bypass would let a restore erase history
--      without raising. This is the second time that lesson has been needed,
--      which is why it is spelled out rather than cross-referenced.
--
--   3. DELETE and TRUNCATE together. TRUNCATE is not a DELETE and is not
--      caught by a DELETE trigger; it is the faster way to lose everything.
--
-- WHAT THIS DOES NOT DO. It does not freeze the tables. INSERT and UPDATE are
-- untouched: the invariant is "history is not erased", not "the table is
-- read-only". An `UPDATE` that corrects a member's handle is normal operation.
--
-- SCOPE. Ephemeral auth/coordination state is deliberately NOT protected
-- (admin_session, admin_webauthn_challenge, swarm_claim_challenges,
-- swarm_member_keys, jobs/job_runs/job_schedules) — those exist to be consumed
-- or to expire, and an unconsumable WebAuthn challenge is a replay window, not
-- a safety feature. `raw_indicator_history` is also excluded: it is
-- re-derivable from its external sources and has a live repair path that
-- deletes calendar-invalid rows (`verifySeedProvenance(db, clean = true)`,
-- analytics/store/seed-provenance.ts). The full list and the reasoning live
-- next to the test that pins it: backend/tests/append-only-enforcement.test.ts.

CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 0A000 = feature_not_supported: the operation is refused categorically, not
  -- because of this caller's privileges or this row's contents.
  RAISE EXCEPTION
    'table "%" is append-only: row deletion is not permitted (%). History is immutable; correct it with an UPDATE or an offsetting row.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

COMMENT ON FUNCTION rm_append_only_guard() IS
  'Refuses DELETE/TRUNCATE on the append-only historical tables. See migration 0032 and backend/tests/append-only-enforcement.test.ts.';

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'swarm_members',
    'swarm_recommendations',
    'swarm_memos',
    'swarm_sessions',
    'swarm_briefs',
    'swarm_subjects',
    'swarm_session_events',
    'swarm_applications',
    'audit_log',
    'agent_activity_log',
    'regime_snapshots',
    'schema_migrations'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    -- Skip a table this deployment has not created yet rather than aborting the
    -- migration: the protected set spans features added across many releases,
    -- and a fresh database applies them in order.
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'append-only guard: table % does not exist, skipping', t;
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only', t);
    -- Must be a separate ALTER: CREATE TRIGGER has no ENABLE ALWAYS clause.
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');
  END LOOP;
END;
$$;

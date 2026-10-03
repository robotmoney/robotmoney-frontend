-- compat: additive
-- metadata_version: 1
--
-- The append-only GRANT TRANSITION — step 2 of
-- docs/technical/smoke-production-spec.md §9.1 (issue #1026 W2).
--
-- WHAT IT UNDOES. Migration 0053 line 129 is
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
-- rm_app` — append-only tables included. §7 check 2's denylist forbids
-- `DELETE`/`TRUNCATE` on an append-only table for every runtime role, and §9.1
-- says of this step, in as many words: "Check 2 fails until it lands." So this
-- is the difference between a production database that can pass preflight and
-- one that cannot.
--
-- WHY A MIGRATION AND NOT ONLY RECONCILIATION. The revocation is also re-asserted
-- by backend/schema/grants.sql on every migrate run, and that re-assertion is
-- worth keeping: a hand-run GRANT that re-widens rm_app is drift no one-shot
-- migration can catch. But reconciliation alone runs only inside a migrate run,
-- and §8.5 makes a production migrate run "an operator intervention … never
-- part of the boot". A production database that has never had an operator
-- migrate run would therefore fail check 2 forever while looking, from the
-- repository, as if the transition had shipped. §9.1 calls this step "a
-- migration"; it is one.
--
-- ADDITIVE, and the word is load-bearing here because this migration REVOKES.
-- §8.4 defines additive as "old code's supported behavior is preserved …  no
-- privilege it needs is revoked". No privilege revoked below is needed: these
-- tables are append-only, migration 0032 and the ledger guards of 0057-0060
-- already raise on every DELETE from the application, and no registered call
-- site declares DELETE or TRUNCATE on any of them. What is being removed is a
-- privilege that could only ever be exercised by a statement the triggers
-- refuse. Absent privilege is one half of the protection; the triggers are the
-- other (src/db/append-only-guard.ts).
--
-- TRUNCATE MATTERS MORE THAN DELETE HERE. The triggers are row-level and
-- TRUNCATE fires none of them, so for that statement the grant is the ONLY
-- protection there has ever been.
--
-- rm_readonly is untouched: it holds SELECT and no more (0053 lines 136-137).

DO $$
DECLARE
  -- Kept in step with APPEND_ONLY_TABLES in src/db/append-only-guard.ts, which
  -- is what preflight check 2's `append_only_write` rule tests against, and
  -- with the identical array in backend/schema/grants.sql.
  append_only text[] := ARRAY[
    'swarm_members', 'swarm_recommendations', 'swarm_memos', 'swarm_sessions',
    'swarm_briefs', 'swarm_subjects', 'swarm_session_events', 'swarm_session_members',
    'swarm_subject_snapshots', 'swarm_session_judgements', 'swarm_consensus_receipts',
    'swarm_member_keys', 'swarm_applications', 'audit_log', 'agent_activity_log',
    'regime_snapshots', 'schema_migrations', 'analytics_overwrite_events'
  ];
  rel record;
BEGIN
  FOR rel IN
    SELECT c.oid::regclass AS ident, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname = ANY(append_only)
    ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM rm_app, rm_worker', rel.ident);
  END LOOP;
END
$$;

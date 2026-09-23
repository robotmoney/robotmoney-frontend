-- Snapshot, part 3 of 3: ROLES AND GRANTS (smoke-production-spec.md §8.1).
--
-- Idempotent grant reconciliation for the objects rm_owner owns. Unlike part 1 it
-- runs on EVERY migrate run -- "always, even with nothing pending" (§8.3) -- because
-- the failure it exists to catch is a grant fixed by hand and then lost, which no
-- migration list can see.
--
-- ROLE CREATION IS NOT PART OF IT. Creating a role needs CREATEROLE and §3 says
-- "rm_owner never holds CREATEROLE"; the four roles are created by doadmin as cluster
-- provisioning (§9.1). This file only moves privileges.
--
-- IT SWEEPS EVERY RELATION IN public RATHER THAN A WRITTEN LIST, for the same reason
-- the registry is derived rather than written down: a list is wrong the week a table
-- is added. A relation in public that rm_owner does not own makes this file FAIL, and
-- that is the correct outcome -- ownership of an application object by a runtime role
-- is itself a check-2 denylist violation (§7 check 2), so reconciliation must not
-- quietly succeed around it.
--
-- THE APPEND-ONLY REVOCATION IS §9.1 STEP 2. Migration 0053 granted rm_app
-- `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` -- append-only tables
-- included -- and preflight check 2 fails until that is undone. The REVOKE below is
-- the transition, carried by reconciliation rather than by a numbered migration so
-- that it is re-asserted on every run: a hand-run GRANT that re-widens rm_app is
-- exactly the drift a one-shot migration cannot catch. Absent privilege is one half
-- of the protection; migration 0032's triggers are the other (src/db/append-only-guard.ts).

DO $$
DECLARE
  -- Kept in step with APPEND_ONLY_TABLES in src/db/append-only-guard.ts, which is
  -- what preflight check 2's `append_only_write` rule tests against.
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
    LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND d.objid IS NULL  -- provider-managed: extension-owned relations are not ours
    ORDER BY c.relname
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO rm_app', rel.ident);
    EXECUTE format('GRANT SELECT ON %s TO rm_readonly', rel.ident);
    IF rel.name = ANY(append_only) THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM rm_app, rm_worker', rel.ident);
    END IF;
  END LOOP;

  -- Sequences: rm_app writes, so it needs the serial columns' sequences; rm_readonly
  -- reads `last_value` (migration 0062). rm_worker's own table grants are an
  -- allowlist maintained by migrations 0054/0061/0062 and are not widened here.
  FOR rel IN
    SELECT c.oid::regclass AS ident
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND d.objid IS NULL
    ORDER BY c.relname
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO rm_app', rel.ident);
    EXECUTE format('GRANT SELECT ON SEQUENCE %s TO rm_readonly', rel.ident);
  END LOOP;
END
$$;

-- Schema usage, and nothing that grants DDL: 0053 revoked ALL on `public` from PUBLIC
-- and granted only USAGE, which is what the `ddl` denylist rule tests.
GRANT USAGE ON SCHEMA public TO rm_app, rm_worker, rm_readonly;

-- Future objects created by rm_owner, so a table added by a later migration is not a
-- table nobody may read.
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON TABLES TO rm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO rm_app;

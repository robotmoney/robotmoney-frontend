-- Production database role taxonomy (issue #692).
--
-- `rm_owner` is deliberately NOLOGIN: it owns schema objects but no persistent
-- process can authenticate as it.  A human-run deployment connects with the
-- short-lived MIGRATE_DATABASE_URL and SET ROLE rm_owner for DDL.  Runtime
-- processes authenticate only as rm_app or rm_worker.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_owner') THEN
    CREATE ROLE rm_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_app') THEN
    CREATE ROLE rm_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_readonly') THEN
    CREATE ROLE rm_readonly LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- NO NOSUPERUSER/NOREPLICATION/NOBYPASSRLS HERE, deliberately.  Postgres
  -- requires SUPERUSER to set those three attributes in ALTER ROLE even when
  -- setting them to their negative (already-default) value, so including them
  -- made this whole DO block fail with "permission denied to alter role" for
  -- any non-superuser bootstrap login.  The production primary's bootstrap
  -- login is `doadmin`, which is rolsuper=false (rolcreaterole=true), so
  -- scripts/ops/provision-db-role-taxonomy.sh could never have completed
  -- against it.  They are redundant regardless: CREATE ROLE above sets them
  -- on the roles this migration creates, and a non-superuser could not grant
  -- those attributes to begin with.  The attributes that DO need pinning here
  -- are settable by a CREATEROLE login holding ADMIN OPTION on the target,
  -- which doadmin holds for rm_worker and rm_readonly.
  ALTER ROLE rm_owner NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  ALTER ROLE rm_app LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  ALTER ROLE rm_worker LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  ALTER ROLE rm_readonly LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;

  -- The bootstrap/migration login may assume the non-login owner.  This is
  -- intentionally the current role, never either runtime role.
  EXECUTE format('GRANT rm_owner TO %I', current_user);
END
$$;

-- BEFORE the sweep, not after it.  ALTER TABLE ... OWNER TO rm_owner requires
-- the NEW owner to hold CREATE on the containing schema, so `public` must
-- already belong to rm_owner when the loop below runs.  A superuser bypasses
-- that ACL check entirely, which is why applying this file as a container
-- superuser (the test suite, and the smoke-twin's own boot) never surfaced it
-- while a non-superuser bootstrap login -- the production primary's `doadmin`,
-- rolsuper=false -- failed on the very first table with "permission denied for
-- schema public".
ALTER SCHEMA public OWNER TO rm_owner;

-- Move every existing application relation and function out of the bootstrap
-- role.  New objects are owned by rm_owner because migrate.ts SET LOCAL ROLEs
-- before applying each subsequent migration.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relkind, c.oid::regclass AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      -- An identity/serial sequence follows its owning table automatically;
      -- PostgreSQL rejects changing it independently.
      AND (c.relkind <> 'S' OR NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')
      ))
      -- Objects belonging to an EXTENSION are the extension's, not ours.
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO rm_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.object_name);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS object_name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      -- Same exclusion as the relation loop above, and the one that actually
      -- bites: pgcrypto installs digest()/gen_random_bytes() into public, and
      -- re-owning an extension's function fails with "must be owner of
      -- function digest" for a non-superuser -- and is wrong even when a
      -- superuser is permitted to do it, since the function belongs to the
      -- extension's lifecycle, not to rm_owner's.
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO rm_owner', r.object_name);
  END LOOP;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rm_app, rm_worker, rm_readonly;

-- There are no default write grants.  A later migration must name every new
-- runtime capability explicitly, making a missing grant fail closed.
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE ALL ON TABLES FROM rm_app, rm_worker, rm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_app, rm_worker, rm_readonly;

-- API: current application tables only.  It is a grantee, never an owner, so
-- even this broad data-plane permission cannot alter/drop tables or triggers.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_app;

-- Read-only operators can inspect the current schema and automatically receive
-- SELECT for later owner-created tables; they never receive write privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rm_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rm_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON TABLES TO rm_readonly;

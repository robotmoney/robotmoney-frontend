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
  ALTER ROLE rm_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER ROLE rm_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER ROLE rm_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER ROLE rm_readonly LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

  -- The bootstrap/migration login may assume the non-login owner.  This is
  -- intentionally the current role, never either runtime role.
  EXECUTE format('GRANT rm_owner TO %I', current_user);
END
$$;

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
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO rm_owner', r.object_name);
  END LOOP;
END
$$;

ALTER SCHEMA public OWNER TO rm_owner;
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

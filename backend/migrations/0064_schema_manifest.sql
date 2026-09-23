-- compat: additive
-- metadata_version: 1
--
-- `schema_manifest` and the ledger's compat columns — the metadata objects of
-- docs/technical/smoke-production-spec.md §8.2/§8.3 (issue #1026 W2).
--
-- WHY A MIGRATION AND NOT GRANT RECONCILIATION. These two objects were first
-- created inside the migrate run itself, reconciled rather than migrated. That
-- cannot work for production. §8.3 makes `schema_manifest` "a one-row table"
-- that preflight check 3a compares the live schema against, and check 3a runs
-- BEFORE any migrate run on an ordinary boot — so a production database whose
-- manifest table only ever appears during a migrate run can never pass the
-- check the manifest exists to serve. Migrations are the only forward-only
-- mechanism this repository has for moving a populated database (§8.2), and
-- this is a populated database's schema, so it moves the same way everything
-- else does.
--
-- ADDITIVE. Nothing here removes or reshapes an object, a bootstrap row or a
-- privilege: two nullable columns and one new table. Code built for the
-- previous snapshot issues no statement that changes meaning, which is exactly
-- §8.4's definition, so `compat: additive` keeps code-only rollback alive
-- across it.
--
-- ONE ROW, ENFORCED BY THE KEY, for the reason 0063 gives about
-- `deployment_identity`: a second manifest is not an ambiguity to resolve at
-- read time, it is a constraint violation at write time. `readManifest`
-- (src/db/schema-manifest.ts) still refuses two rows, because it also runs
-- against databases restored from before this migration.
--
-- WRITABLE ONLY BY rm_owner (§8.3: "Only `rm_owner` may write it or the
-- ledger's `compat`/`metadata_version` columns; they are trusted inputs to boot
-- decisions"), READABLE by every runtime role. The read is not a courtesy:
-- §7.2 has the database-holding containers run checks 1-3 "at startup against
-- their own credential", and check 3a compares the live schema with "the
-- manifest for M stored in the database" — so api, worker and worker-swarm
-- cannot boot at all without SELECT here. Exactly the split 0063 made for
-- `deployment_identity`: the write restriction is the whole protection, and it
-- is a grant, never a TypeScript check on top of one.

CREATE TABLE schema_manifest (
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  format_version integer NOT NULL,
  declaration    text    NOT NULL,
  filenames      text[]  NOT NULL,
  content_hash   text    NOT NULL
);

-- 0053 moved every application object to rm_owner, but it is a one-time sweep and
-- this table is created after it. A production migrate run already executes as
-- rm_owner (§8.3), so this is a no-op there; it matters where the runner is a
-- superuser -- CI, a twin, a locally bootstrapped database -- because
-- backend/schema/grants.sql reconciles privileges only "for objects `rm_owner`
-- owns" (§8.1) and a manifest owned by the provisioning login would silently sit
-- outside every later reconciliation.
ALTER TABLE schema_manifest OWNER TO rm_owner;

REVOKE ALL ON schema_manifest FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT ON schema_manifest TO rm_app, rm_worker, rm_readonly;

COMMENT ON TABLE schema_manifest IS
  'One-row declared schema for the installed version (spec §8.3): declaration, filename list, content hash, format version. Writable only by rm_owner.';

-- §8.2: "On apply the runner records `compat` and `metadata_version` in
-- `schema_migrations`; that is how an older image learns about migrations it
-- does not contain." NULLABLE on purpose, and §8.4 is explicit about what a
-- NULL means: "A `NULL` compat, an unknown version, or `breaking` refuses."
-- Every row already in the ledger predates the scheme and is therefore
-- genuinely unknown; backfilling a cheerful 'additive' over them would be
-- inventing a reviewed claim nobody made.
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS compat text;
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS metadata_version integer;

ALTER TABLE schema_migrations
  DROP CONSTRAINT IF EXISTS schema_migrations_compat_check;
ALTER TABLE schema_migrations
  ADD CONSTRAINT schema_migrations_compat_check
  CHECK (compat IS NULL OR compat IN ('additive', 'breaking'));

COMMENT ON COLUMN schema_migrations.compat IS
  'Spec §8.2/§8.4: the migration''s own additive/breaking declaration, parsed from its header on apply. NULL means the row predates the scheme, which §8.4 refuses rather than assumes.';
COMMENT ON COLUMN schema_migrations.metadata_version IS
  'Spec §8.2/§8.4: the metadata format the compat claim was written under, so an older image can refuse a version it does not understand.';

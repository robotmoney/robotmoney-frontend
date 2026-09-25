-- rm_readonly must be able to read sequence state, because it is the role the
-- BACKUP runs as (issue #699; docs/runbooks/rollout-procedure.md §5.1).
--
-- WHAT WENT WRONG. `pg_dump` reads every sequence's `last_value` to reproduce
-- it in the dump. Running as rm_readonly against production it failed:
--
--   pg_dump: error: failed to get data for sequence "analytics_data_vintages_id_seq";
--            user may lack SELECT privilege on the sequence
--
-- Twelve of forty sequences in `public` denied rm_readonly a read. They are
-- exactly the twelve created by 0056-0060, each of which ends with a hardening
-- block of the shape:
--
--   REVOKE ALL ON SEQUENCE <new sequences> FROM PUBLIC, rm_worker, rm_readonly;
--   GRANT  SELECT ON <new tables> TO rm_readonly;
--
-- So each of those migrations granted rm_readonly SELECT on the TABLE and, in
-- the same breath, took away its ability to read that table's sequence.
--
-- WHY THAT IS OVER-HARDENING RATHER THAN POLICY. A role that can already
-- SELECT every row of `analytics_data_vintages` learns nothing from
-- `analytics_data_vintages_id_seq.last_value` that the rows do not already
-- tell it -- the counter is strictly less information than the table. It is
-- not a privilege boundary; it is the same boundary spelled twice, once
-- correctly and once as a denial. What the denial DOES do is break the backup,
-- silently: nothing at runtime reads those sequences as rm_readonly, so the
-- only consumer is pg_dump, and the only symptom is the P3.backup gate of the
-- NEXT release failing. That is where this was found.
--
-- 0053 CONTRIBUTES A SECOND, SMALLER GAP, fixed here too. It revokes the
-- default privilege on both tables and sequences (lines 103-104) and restores
-- it for tables only (line 118) -- there is no SEQUENCES counterpart. So even
-- a migration that does NOT revoke explicitly would leave its sequence
-- unreadable. Restoring the default is what makes the normal case correct
-- without every future migration having to remember.
--
-- IDEMPOTENT. Both statements are absolute assignments over a set; re-running
-- reaches the same state. Runs as rm_owner (migrate.ts SET LOCAL ROLE, 0054+),
-- which owns every sequence here and may therefore grant on it.

-- 1. REPAIR: every sequence that exists right now, including the twelve.
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;

-- 2. PREVENT: the default 0053 revoked and never restored, so a sequence
--    created later is readable without anyone remembering to say so.
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO rm_readonly;

-- ── 3. ROLE CLEANUP: drop the test fixture that reached production ──────────
--
-- `rm_readonly_test` is created by backend/tests/preflight-utils.test.ts:154
-- as `CREATE ROLE rm_readonly_test LOGIN PASSWORD 'testpass'` -- a fixture,
-- with its password committed to the repository. It exists on the PRODUCTION
-- cluster and authenticates, which means the backend suite was once pointed at
-- the production DATABASE_URL.
--
-- Its blast radius today is nil and that is luck, not design: 0053's
-- `REVOKE ALL ON SCHEMA public FROM PUBLIC` stripped the grants the fixture
-- gave it, so it holds SELECT on 0 of 87 tables and no USAGE on `public`
-- (verified against the replica 2026-09-21). It can still connect and read the
-- system catalogs. A LOGIN role with a public password has no business on a
-- production cluster whatever it can currently reach.
--
-- WHY THIS IS GUARDED RATHER THAN A BARE `DROP ROLE`. DROP ROLE needs
-- CREATEROLE or superuser. 0053 sets rm_owner NOCREATEROLE, and migrate.ts
-- runs every migration from 0054 on under `SET LOCAL ROLE rm_owner`
-- (migrate.ts:58) -- so at BOOT this statement cannot succeed, and unguarded
-- it would fail the deploy outright.
--
-- Two paths, one file, and that is deliberate:
--   * scripts/ops/provision-db-role-taxonomy.sh applies this file through psql
--     as the bootstrap login (doadmin, rolcreaterole=true) -- the drop HAPPENS.
--   * the boot applies it as rm_owner and records it -- the drop is SKIPPED
--     with a notice, because the role cleanup is not the boot's job.
-- Same split 0053 already uses, and the reason the provisioning script is the
-- documented pre-step rather than an afterthought.
--
-- DROP OWNED BY first: DROP ROLE refuses while any grant still references the
-- role, and DROP OWNED BY removes exactly those.
--
-- BUT `DROP OWNED BY` IS PER-DATABASE AND A ROLE IS PER-CLUSTER. It clears
-- only what the role holds in the database the migration is connected to, so
-- a grant in a SIBLING database still blocks the drop. Production has one
-- application database and is unaffected; the test cluster is exactly the
-- opposite shape -- tests/support/clean-db.ts gives each test file its own
-- template clone, and preflight-utils.test.ts creates this very role and
-- grants it privileges inside whichever clone it is running in. So the drop
-- legitimately fails there, and an unhandled failure took eight unrelated API
-- boot tests down with it.
--
-- Both refusals are therefore caught and reported, never fatal. A migration
-- that cannot complete a CLEANUP must not fail a deploy over it — and nothing
-- is silently assumed, because postflight's `test-role-removed` check asserts
-- the role is actually gone rather than trusting that 0062 ran.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_readonly_test') THEN
    BEGIN
      EXECUTE 'DROP OWNED BY rm_readonly_test';
      EXECUTE 'DROP ROLE rm_readonly_test';
      RAISE NOTICE '0062: dropped rm_readonly_test (test fixture, password was committed to the repo)';
    EXCEPTION
      WHEN insufficient_privilege THEN
        -- Expected at boot: rm_owner is NOCREATEROLE (0053) and migrate.ts runs
        -- migrations from 0054 on under SET LOCAL ROLE rm_owner. The
        -- provisioning script performs the drop as the bootstrap login.
        RAISE NOTICE '0062: rm_readonly_test kept — this session (%) may not DROP ROLE. Run scripts/ops/provision-db-role-taxonomy.sh against the primary.', current_user;
      WHEN dependent_objects_still_exist THEN
        -- The role holds grants in ANOTHER database of this cluster, which
        -- DROP OWNED BY cannot reach from here. Normal in the test cluster,
        -- and a real (reportable) condition anywhere else.
        RAISE NOTICE '0062: rm_readonly_test kept — it still owns objects or grants in another database of this cluster.';
    END;
  END IF;
END
$$;

-- ── 4. THE LIVE OUTAGE: rm_worker cannot WRITE the tables it samples ────────
--
-- 1,968 dead `wallet.sample_balances` / `wallet.sample_sleeves` jobs and 6
-- dead `wallet.backfill_window` jobs, continuous from 02:47Z and still firing
-- at 20:47Z. The error names a table, which made it look like a missing SELECT:
--
--   permission denied for table asset_prices
--     at writeAssetPrice (/app/src/ops/asset-prices.ts:116:9)
--
-- The stack frame is the tell. `rm_worker` HAS SELECT on asset_prices
-- (`rm_worker=r/rm_owner` in its ACL, verified on the replica). What it lacks
-- is INSERT/UPDATE: line 116 is an `INSERT ... ON CONFLICT DO UPDATE`.
--
-- THIS IS 0054'S OWN PREDICTION COMING TRUE. Its header says: "Replace 0016's
-- broad/default worker grant with an explicit current-table allow-list. Future
-- tables start inaccessible to rm_worker." The allow-list names the tables
-- that existed when it was written. `asset_prices`/`asset_price_floors`
-- (0046) and `chain_address_floors` (0045) are sampler-written tables that
-- predate 0054 in NUMBER but were never added to its list. Fail-closed worked
-- exactly as designed; nobody extended the list.
--
-- SCOPED TO WHAT PRODUCTION ACTUALLY PROVES IT NEEDS. The grant list is taken
-- from the empirical oracle, not from grepping the source: every distinct
-- `permission denied for table X` in `jobs.last_error` across the whole
-- incident. That is exactly two tables, and there are zero denials of any
-- other shape (no sequence, function or schema).
--
--   asset_prices          1,968 failures   wallet.sample_balances, wallet.sample_sleeves
--   chain_address_floors      6 failures   wallet.backfill_window
--
-- `asset_price_floors` is added on CODE evidence rather than observed failure:
-- asset-prices.ts:152 inserts into it from the same function that dies at line
-- 116, so it has never been reached. Granting only the two observed tables
-- would move the outage rather than end it.
--
-- NO DELETE, and no sequence USAGE: nothing deletes from these three, and all
-- three take natural primary keys, so they own no sequence. Least privilege is
-- the whole point of an allow-list.
--
-- GUARDED ON EXISTENCE, because a bare `GRANT ... ON asset_prices` is not
-- portable across the databases this file has to run on. A plain statement
-- aborts the whole migration with `relation "asset_prices" does not exist` on
-- any database built to an earlier baseline -- which the test suite does
-- routinely (the v0.3.0-preflight-on-a-v0.2.2-baseline fixture caught exactly
-- this). The tables are 0045/0046's, so they are present wherever this grant
-- actually matters, and skipping them where they are absent is correct rather
-- than merely tolerant.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_prices', 'asset_price_floors', 'chain_address_floors'] LOOP
    IF EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind IN ('r', 'p')
    ) THEN
      EXECUTE format('GRANT INSERT, UPDATE ON public.%I TO rm_worker', t);
    END IF;
  END LOOP;
END
$$;

-- ── 5. READ GAPS IN THE OTHER ROLES (preventive, not the outage) ────────────
--
-- Audited against the production replica 2026-09-21. The same
-- retroactive-GRANT-with-no-default shape shows up under every role name:
--
--   role         tables            sequences (SELECT)
--   rm_readonly  87/87  ok         28/40  <- section 1, breaks the BACKUP
--   rm_app       86/87  1 missing  39/40   1 missing
--   rm_worker    71/87  16 missing 28/40  12 missing
--
-- None of these has caused a failure yet -- the 16 tables rm_worker cannot
-- read are the analytics/source ledgers, and its analytics lane has not tried.
-- They are fixed here because the next reader to touch one would fail the same
-- silent way, and because a default is what stops the list needing maintenance.
--
-- WRITES STAY FAIL-CLOSED. 0053's rule -- "there are no default write grants;
-- a later migration must name every new runtime capability explicitly" -- is
-- preserved exactly: section 4 names three tables, and nothing below grants a
-- write or a sequence USAGE to anyone.
GRANT SELECT ON ALL TABLES    IN SCHEMA public TO rm_app, rm_worker;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_app, rm_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO rm_app, rm_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO rm_app, rm_worker;

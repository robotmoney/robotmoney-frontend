-- compat: additive
-- metadata_version: 1
--
-- The immutable analytics ledgers are insert-only by grant, not only by
-- trigger — issue #1026 W2, docs/technical/smoke-production-spec.md §8.3, and
-- D53 decision 6 (docs/decisions.md).
--
-- WHAT THE LEDGER MIGRATIONS GRANTED. 0057, 0058, 0059 and 0060 each created a
-- family of immutable tables (LEDGER_FAMILIES in
-- src/db/analytics-ledger-guard.ts), revoked ALL from PUBLIC and rm_worker, and
-- granted rm_app exactly `SELECT, INSERT` (0057:108, 0058:137, 0059:113,
-- 0060:76). Their triggers refuse UPDATE, DELETE and TRUNCATE.
--
-- WHAT UNDID IT. backend/schema/grants.sql's reconciliation granted
-- `SELECT, INSERT, UPDATE` to rm_app on every table it did not list as
-- read-only, and it listed none of these, so every migrate run that reconciled
-- widened all fourteen to UPDATE. The triggers still refused the write, but a
-- trigger and a grant are two protections, not one (0072's header says the
-- same): a privilege refusal survives a dropped trigger, and a trigger
-- survives a re-widened grant. With the grant widened, a single disabled
-- trigger was the whole defence. grants.sql now carries an insert-only list and
-- never widens these again; this migration takes back what earlier
-- reconciliations already handed out, on databases that ran one.
--
-- DELETE AND TRUNCATE are revoked too. D53 decision 6 makes preflight check
-- 2's append-only rule cover these families: "Losing a ledger row is the same
-- harm as losing a history row." A database where rm_app still held either
-- would fail that check.
--
-- rm_worker is named in the REVOKE for the same belt-and-braces reason as
-- 0072: its grants are an allowlist, and a hand-widened grant must not survive
-- the migration. Its SELECT (0062) is left alone.
--
-- ADDITIVE: every one of these writes was already refused by the family's
-- immutability trigger, so no statement that used to succeed now fails.

-- GUARDED PER TABLE. Production (v0.5.2) recorded the schema-only
-- 0080_analytics_ledger_compaction.sql, which DROPS source_payloads, before
-- this file reached it, so there this file runs AFTER 0080 and a single REVOKE
-- naming source_payloads would fail and stop the boot
-- (backend/tests/migration-history.test.ts). Each REVOKE is issued only for a
-- table that exists, the same shape 0062_rm_worker_analytics_ledger_read_grant
-- takes. A fresh database runs this before 0080 and revokes all fourteen.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'source_acquisitions', 'source_acquisition_events', 'source_payloads', 'source_fetches', 'source_value_versions',
    'analytics_ledger_methodology_versions', 'analytics_ledger_runs', 'analytics_ledger_run_events',
    'analytics_data_vintages', 'analytics_vintage_members',
    'analytics_output_snapshots', 'analytics_report_snapshots', 'swarm_brief_revisions',
    'analytics_parity_observations'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM rm_app, rm_worker', t);
    END IF;
  END LOOP;
END $$;

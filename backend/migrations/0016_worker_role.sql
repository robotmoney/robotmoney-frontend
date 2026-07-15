-- Queue-scoped worker database role (issue #106).
--
-- Analytics outputs are persisted ONLY through the authenticated
-- /api/analytics/* boundary (the API process owns all analytics-table SQL).
-- The worker keeps narrowly scoped database access — queue lifecycle
-- (jobs/job_runs/job_schedules) plus the legacy non-analytics samplers — but
-- its role must NOT authorize mutations to the analytics data tables, so the
-- source-level import boundary is backed by database permissions.
--
-- Deployment: point the worker at this role via WORKER_DATABASE_URL (see
-- backend/src/db/worker-client.ts). The role is created WITHOUT a password —
-- an operator provisions credentials out-of-band (ALTER ROLE rm_worker
-- PASSWORD '...'); never bake a secret into a migration. CI's restricted-role
-- test (tests/analytics-worker-role.test.ts) does exactly that against the
-- ephemeral Postgres and proves queue access works while analytics writes are
-- denied.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rm_worker') THEN
    CREATE ROLE rm_worker LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO rm_worker;

-- Broad grant first (the worker still legitimately maintains the non-analytics
-- tables: queue lifecycle, vault_share_price_history, wallet_balance_samples,
-- buyback_swaps, projects pipelines, committee lifecycle jobs)…
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rm_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_worker;

-- …and future tables created by the migration runner inherit the same access.
-- NOTE: any FUTURE analytics data table must add its own explicit REVOKE in the
-- migration that creates it (tests/analytics-worker-role.test.ts pins the
-- current analytics set).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rm_worker;

-- The analytics data boundary: the worker may READ analytics tables (report
-- projections used by committee jobs) but must never mutate them.
REVOKE INSERT, UPDATE, DELETE ON raw_indicator_history, regime_snapshots, research_signals FROM rm_worker;

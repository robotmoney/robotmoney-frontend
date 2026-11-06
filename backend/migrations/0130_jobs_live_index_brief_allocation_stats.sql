-- compat: additive
-- metadata_version: 1
--
-- The jobs table stops being read in full, the paged sessions list stops
-- detoasting every brief body, and query statistics can be installed (issue
-- 1581). Its locks stay short enough for the release that is still serving
-- (issue 1584).
--
-- WHY. Measured on the production primary on 2026-11-05: `jobs` held 310k
-- rows, had taken 124k full scans and caused about 90% of all disk reads. The
-- only index on `status` (jobs_pending_run_after_idx) covers 'pending' rows,
-- so the reaper (`status = 'running' AND locked_at < ...`, 2.5 s), the enqueue
-- live-job guard and livePayloadField (`kind = $ AND status IN ('pending',
-- 'running')`, 170 ms each) and the worker-start backlog sweep read every row.
-- The admin overview's `GROUP BY status` read every row too (280 ms). The
-- paged sessions list read `body->'allocation'` from swarm_briefs, which
-- detoasts the whole ~240 KB body per row to return a few weights.
--
-- WHAT IT DOES.
--   1. jobs_live_kind_locked_idx: (kind, locked_at) over the live rows only
--      ('pending', 'running'). Every live-row query above plans on it. It
--      stays small whatever the table's size: a row leaves it when it settles.
--      The admin `GROUP BY status` / `GROUP BY kind` counts get no index of
--      their own (an index-only scan of a (status, kind) index loses to the
--      heap scan whenever the visibility map lags, and that index also
--      became the enqueue guard's plan). On a large table they stop reading
--      the heap: the live statuses come exactly through this index, the rest
--      from planner statistics (backend/src/admin/job-counts.ts). So
--      jobs.status and jobs.kind get a statistics target of 1000: ANALYZE
--      then samples up to 300k rows, all of a production-size table, and a
--      status as rare as 0.1% is estimated within a few percent.
--   2. audit_log_job_idx, swarm_session_events_job_idx and
--      pipeline_ingest_receipts_job_idx: indexes on job_id columns that had
--      none. `bun run prune` (backend/scripts/prune.ts) deletes old finished
--      jobs and keeps any job one of these rows names. The first two are
--      `ON DELETE SET NULL` foreign keys, so without an index every deleted
--      jobs row scanned both tables. The third has no foreign key; the prune's
--      NOT EXISTS reads it (issue 1584). (analytics_runs, job_runs,
--      research_pipeline_runs and analytics_ledger_runs already index job_id.)
--   3. swarm_briefs.allocation: a plain nullable column, kept equal to
--      `body -> 'allocation'` by the BEFORE INSERT OR UPDATE trigger
--      swarm_briefs_allocation. The trigger sets it on every write, so no
--      writer changes, an older image's writes fill it too, and no write can
--      store a value that disagrees with the body. The sessions list reads it
--      in place of the body. Existing rows are filled by the next file,
--      0131_swarm_briefs_allocation_backfill.sql.
--   4. pg_stat_statements, when this role may create it. It is not a trusted
--      extension, so rm_owner (which runs this file) normally may not: on a
--      managed cluster `bun scripts/prod-init.ts role-passwords
--      --doadmin-stdin` creates it as doadmin before the release (D61), and
--      this file then finds it present and does nothing. A refusal is a
--      NOTICE, never a failed migration: the statistics are an operator aid
--      and the application does not depend on them. The `pg_read_all_stats`
--      grant to rm_readonly is not here at all: rm_owner holds no admin
--      option on that role, so only the doadmin tool can give it.
--
-- LOCKS (issue 1584). The previous release keeps serving while this file
-- runs, and its request routes give up on a lock after 3 s
-- (PG_REQUEST_LOCK_TIMEOUT_MS). This file runs in one transaction (the migrate
-- step wraps each file), so CREATE INDEX CONCURRENTLY is not available and
-- every lock below is held until it commits.
--   * `lock_timeout = 2s` bounds each wait. Without it, a long transaction on
--     jobs would hold this file's SHARE request in the queue, and every route
--     write to jobs would queue behind it with no bound. With it, the file
--     fails (55P03) and rolls back whole, and the migrate is run again. It is
--     above deadlock_timeout (1 s), the moment Postgres cancels an
--     autovacuum that blocks a lock request, so an autovacuum of jobs does not
--     fail the file.
--   * No table is rewritten. As first merged (PR 1582), this file added
--     `allocation` as a STORED generated column. That rewrites swarm_briefs
--     (and copies all ~100 MB of its TOAST) under ACCESS EXCLUSIVE while
--     every other lock here is held: 0.8 to 1.0 s on a copy of stage-2's tables (431 briefs,
--     88 MB), longer on a colder or busier primary. A plain nullable column
--     is a catalog change only.
--   * The swarm_briefs statements come last, so their ACCESS EXCLUSIVE lock
--     lives only from the ADD COLUMN to the commit.
--   Measured on that copy (311k jobs, 99k receipts): the whole file took
--   about 95 ms, 62 ms of it the receipts index and 20 ms the jobs index.
--
-- ADDITIVE. Indexes, two statistics targets, one nullable column with its
-- trigger and an optional extension. An older image never names the new
-- column (every swarm_briefs INSERT lists its columns) and reads the same
-- rows through the same statements. No row is removed and no grant changes.
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS or OR REPLACE, so a second run
-- changes nothing.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS audit_log_job_idx ON audit_log (job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS swarm_session_events_job_idx ON swarm_session_events (job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pipeline_ingest_receipts_job_idx ON pipeline_ingest_receipts (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE jobs ALTER COLUMN status SET STATISTICS 1000;
ALTER TABLE jobs ALTER COLUMN kind SET STATISTICS 1000;

CREATE INDEX IF NOT EXISTS jobs_live_kind_locked_idx
  ON jobs (kind, locked_at) WHERE status IN ('pending', 'running');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pg_stat_statements not created by %: % (role-passwords creates it as doadmin, D61)', current_user, SQLERRM;
    END;
  END IF;
END
$$;

ALTER TABLE swarm_briefs ADD COLUMN IF NOT EXISTS allocation jsonb;

CREATE OR REPLACE FUNCTION rm_swarm_briefs_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.allocation := NEW.body -> 'allocation';
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION rm_swarm_briefs_allocation() IS
  'Keeps swarm_briefs.allocation equal to body -> ''allocation'' on every write (migration 0130, issue 1584).';

CREATE OR REPLACE TRIGGER swarm_briefs_allocation
  BEFORE INSERT OR UPDATE ON swarm_briefs
  FOR EACH ROW EXECUTE FUNCTION rm_swarm_briefs_allocation();
-- ALWAYS, like the append-only guards: a session in replica mode (a restore,
-- a logical apply) still keeps the column equal to the body.
ALTER TABLE swarm_briefs ENABLE ALWAYS TRIGGER swarm_briefs_allocation;

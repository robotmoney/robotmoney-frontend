-- compat: additive
-- metadata_version: 1
--
-- The jobs table stops being read in full, the paged sessions list stops
-- detoasting every brief body, and query statistics can be installed (issue
-- 1581).
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
--   2. audit_log_job_idx and swarm_session_events_job_idx: the two
--      `job_id REFERENCES jobs ON DELETE SET NULL` edges that had no index.
--      `bun run prune` (backend/scripts/prune.ts) now deletes old finished
--      jobs, and each deleted jobs row makes Postgres look up its referencing
--      rows; without these, every deleted row scanned both tables. The prune
--      also uses them to skip a job that history still names.
--      (analytics_runs.job_id already has analytics_runs_job_attempt_idx.)
--   3. swarm_briefs.allocation: a STORED generated column equal to
--      `body -> 'allocation'`. Postgres computes it on every write, so no
--      writer changes and no write can disagree with the body. Adding it
--      rewrites the table, which fills it for every existing row: that is the
--      backfill. The sessions list reads it in place of the body.
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
-- ADDITIVE. Indexes, two statistics targets, one generated column and an optional extension. An older
-- image never names the new column (every swarm_briefs INSERT lists its
-- columns) and reads the same rows through the same statements. No row is
-- removed and no grant changes.
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS, so a second run changes
-- nothing.
CREATE INDEX IF NOT EXISTS jobs_live_kind_locked_idx
  ON jobs (kind, locked_at) WHERE status IN ('pending', 'running');

ALTER TABLE jobs ALTER COLUMN status SET STATISTICS 1000;
ALTER TABLE jobs ALTER COLUMN kind SET STATISTICS 1000;

CREATE INDEX IF NOT EXISTS audit_log_job_idx ON audit_log (job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS swarm_session_events_job_idx ON swarm_session_events (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE swarm_briefs
  ADD COLUMN IF NOT EXISTS allocation jsonb GENERATED ALWAYS AS (body -> 'allocation') STORED;

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

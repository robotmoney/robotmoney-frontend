-- compat: additive
-- metadata_version: 1
--
-- Indexes for four slow read paths (issue 1690). The owner's rule: no api
-- request takes 5 s or more.
--
-- WHY, per index (root cause and plans on issue 1690):
--   1. jobs_kind_id_idx (kind, id DESC) and job_runs_kind_started_idx (kind,
--      started_at DESC). GET /api/admin/overview reads the newest job and run
--      of each monitored kind (src/admin/overview.ts). No index led with kind
--      outside the live-only partial index, so a kind with no rows
--      (regime.classify, research.refresh) planned a parallel sequential scan
--      of jobs and job_runs, four full scans per request, and a rare kind
--      walked the primary key backward filtering on the heap. The request hit
--      the 5 s statement timeout on production (57014, 2026-11-18). With these
--      every probe is one index descent.
--   2. source_value_versions_heads_idx: the lookup index's key with value
--      INCLUDEd. POST /api/analytics/vintages (freezeVintage) reads the head
--      of every series at the cutoff (loadHistoricalSourceValues). Through
--      source_value_versions_lookup_idx it fetched each row's value from the
--      heap in key order, which the heap does not follow (correlation 0.31):
--      random reads over the whole table. This index answers it index-only.
--      The lookup index stays; dropping it is a later breaking change.
--   3. source_value_versions_id_time_idx (id) INCLUDE (knowledge_time) and
--      analytics_overwrite_events_id_time_idx (id) INCLUDE (recorded_at). The
--      public archive's day step (src/analytics/store/public-archive-store.ts)
--      finds the first id at or after a day boundary by walking ids and
--      reading each row's time. Through the primary key that read the heap,
--      about 2 KB a row on analytics_overwrite_events. These answer it
--      index-only.
--   4. analytics_vintage_members_vintage_id_idx (vintage_id, id). The members
--      step's max(id) over the vintages a backup adds read every member's id
--      from the heap through analytics_vintage_members_vintage_idx. This
--      answers it index-only.
--
-- LOCKS. The migrate step wraps each file in one transaction, so CREATE INDEX
-- CONCURRENTLY is not available. Each CREATE INDEX takes a SHARE lock on its
-- table: reads go on, inserts wait until the file commits. Run it outside a
-- 3-hourly analytics tick (the tick writes source_value_versions,
-- analytics_overwrite_events and analytics_vintage_members). lock_timeout 2s
-- bounds the wait for the lock itself, the same rule as 0130.
--
-- BUILD TIME, measured on a copy of the production dump of 2026-11-22
-- (Postgres 18.6, the production row counts: 7.5M members, 1.1M overwrite
-- events, 731k source values, 384k runs, 373k jobs; shared_buffers 190MB,
-- maintenance_work_mem 64MB, cold cache), in one transaction:
--   jobs_kind_id_idx                          1.3 s
--   job_runs_kind_started_idx                 1.4 s
--   source_value_versions_heads_idx           2.7 s
--   source_value_versions_id_time_idx         0.6 s
--   analytics_overwrite_events_id_time_idx    6.1 s
--   analytics_vintage_members_vintage_id_idx  7.9 s
--   whole file                               about 20 s
-- Inserts into those tables wait that long; reads do not wait.
--
-- ADDITIVE. Indexes only: no row, column, grant or statement an older image
-- runs changes. IDEMPOTENT: every statement is IF NOT EXISTS.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS jobs_kind_id_idx ON jobs (kind, id DESC);

CREATE INDEX IF NOT EXISTS job_runs_kind_started_idx ON job_runs (kind, started_at DESC);

CREATE INDEX IF NOT EXISTS source_value_versions_heads_idx
  ON source_value_versions (source_key, market_date, market_instant, knowledge_time DESC, id DESC) INCLUDE (value);

CREATE INDEX IF NOT EXISTS source_value_versions_id_time_idx ON source_value_versions (id) INCLUDE (knowledge_time);

CREATE INDEX IF NOT EXISTS analytics_overwrite_events_id_time_idx ON analytics_overwrite_events (id) INCLUDE (recorded_at);

CREATE INDEX IF NOT EXISTS analytics_vintage_members_vintage_id_idx ON analytics_vintage_members (vintage_id, id);

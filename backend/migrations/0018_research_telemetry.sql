-- Research pipeline telemetry (issue #151). Structured, queryable records of
-- every runAnalytics execution — access/extract/transform/analyze/store/report
-- stage status, warnings, bounded artifact previews, and the run outcome — so
-- an admin can inspect pipeline behavior without grepping job_runs.output text.
--
-- NOTE (issue #151 depends on #150 "admin surface data and audit foundation",
-- which had not landed when this migration was authored): #150 was scoped to
-- own migration 0017 with a broader admin-surface schema (queue scope/cancel
-- metadata, committee versioning, audit_log extension, etc), including its
-- own placeholder `analytics_runs`/`analytics_stage_runs`/`analytics_artifacts`
-- tables (docs/architecture.md §5.2) that #150 explicitly left
-- unimplemented ("Out of scope: Analytics telemetry endpoint implementation
-- and worker instrumentation" — issue #150). This migration renumbers to 0018
-- during rebase (mechanical) AND uses distinct `research_pipeline_*` table
-- names (not mechanical) because #150's placeholder tables use an incompatible
-- schema (uuid PK, job_kind/source_mode/attempt columns) for the same table
-- name this migration originally claimed. #150's tables are untouched here —
-- renaming them would require rewriting its already-merged, already-tested
-- migration/tests; this migration owns the fully-implemented store+API path
-- (telemetry-store.ts, api/routes/admin.ts, api/routes/analytics.ts) so it
-- renames its own tables instead. #150's tables remain dead scaffolding
-- unless a future issue wires them up.
--
-- Persisted ONLY through the authenticated /api/analytics/telemetry boundary
-- (analytics-provider bearer) — the API process owns all telemetry SQL, mirroring
-- the raw_indicator_history/regime_snapshots/research_signals boundary from
-- migration 0009/0016. The worker role may READ (admin projections proxy through
-- the API, but tests/tooling may still want read access) but must NEVER write
-- these tables directly.
CREATE TABLE research_pipeline_runs (
  id           bigserial PRIMARY KEY,
  -- Soft reference to jobs(id) — deliberately NOT a foreign key, mirroring the
  -- existing job_runs.job_id convention (migration 0003_task_queue.sql), so
  -- `TRUNCATE jobs` in tests never cascades/fails on this table.
  job_id       bigint,
  kind         text NOT NULL,            -- toolId submitted ('regime' | 'channel-divergence' | 'late-cycle-signals' | 'suite')
  asof         date NOT NULL,
  source       text NOT NULL CHECK (source <> '' AND length(source) <= 32), -- 'live' | 'hermetic' | 'fixture' (test/demo)
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'succeeded', 'degraded', 'failed')),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  checksum     text,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb, -- small result summary (composite/regime/rows count etc.) — never a full series
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_pipeline_runs_job_idx ON research_pipeline_runs (job_id);
CREATE INDEX research_pipeline_runs_kind_asof_idx ON research_pipeline_runs (kind, asof DESC);
CREATE INDEX research_pipeline_runs_created_idx ON research_pipeline_runs (created_at DESC);
CREATE INDEX research_pipeline_runs_status_idx ON research_pipeline_runs (status);

CREATE TABLE research_pipeline_stages (
  id           bigserial PRIMARY KEY,
  run_id       bigint NOT NULL REFERENCES research_pipeline_runs(id) ON DELETE CASCADE,
  stage        text NOT NULL CHECK (stage IN ('access', 'extract', 'transform', 'analyze', 'store', 'report')),
  sequence     int NOT NULL,
  status       text NOT NULL CHECK (status IN ('ok', 'warn', 'error')),
  summary      text NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX research_pipeline_stages_run_idx ON research_pipeline_stages (run_id);

CREATE TABLE research_pipeline_warnings (
  id         bigserial PRIMARY KEY,
  run_id     bigint NOT NULL REFERENCES research_pipeline_runs(id) ON DELETE CASCADE,
  stage      text NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_pipeline_warnings_run_idx ON research_pipeline_warnings (run_id);

-- Bounded artifact previews ONLY — the persistence boundary (api/routes) caps
-- payload size and this table stores a truncated preview, never a complete
-- time series (issue #151 explicit out-of-scope guard).
CREATE TABLE research_pipeline_artifacts (
  id         bigserial PRIMARY KEY,
  run_id     bigint NOT NULL REFERENCES research_pipeline_runs(id) ON DELETE CASCADE,
  stage      text NOT NULL,
  kind       text NOT NULL,
  checksum   text,
  preview    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_pipeline_artifacts_run_idx ON research_pipeline_artifacts (run_id);

-- Worker-role boundary (mirrors migration 0016_worker_role.sql / 0009_analytics_v2):
-- the worker submits telemetry through the authenticated HTTP boundary, never
-- direct SQL, so its database role must not be able to mutate these tables.
REVOKE INSERT, UPDATE, DELETE ON research_pipeline_runs, research_pipeline_stages, research_pipeline_warnings, research_pipeline_artifacts FROM rm_worker;

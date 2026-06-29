-- Postgres-backed task queue replacing the 16 GitHub Actions cron workflows.
-- Concurrency-safe via FOR UPDATE SKIP LOCKED; durable; observable via job_runs.

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  priority     int NOT NULL DEFAULT 0,
  run_after    timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- A slot enqueues at most once even with multiple schedulers.
CREATE UNIQUE INDEX jobs_dedupe_key_idx ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
-- Fast claim of due work.
CREATE INDEX jobs_pending_run_after_idx ON jobs (run_after) WHERE status = 'pending';

CREATE TABLE job_schedules (
  id               serial PRIMARY KEY,
  kind             text NOT NULL,
  cron             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone         text NOT NULL DEFAULT 'UTC',
  enabled          boolean NOT NULL DEFAULT true,
  last_enqueued_at timestamptz,
  next_run_at      timestamptz
);

CREATE TABLE job_runs (
  id          bigserial PRIMARY KEY,
  job_id      bigint,
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL,
  error       text,
  output      jsonb
);
CREATE INDEX job_runs_job_idx ON job_runs (job_id);
CREATE INDEX job_runs_started_idx ON job_runs (started_at DESC);

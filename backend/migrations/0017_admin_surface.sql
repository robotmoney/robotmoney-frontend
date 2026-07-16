-- Admin surface data and audit foundation (issue #150; docs/plan-admin-surface.md §5).
--
-- Durable, queryable foundations for scoped queue work, analytics execution
-- telemetry, committee roster/lifecycle history, and safe append-only admin
-- auditing. Forward-only, idempotent in the same style as prior migrations
-- (IF NOT EXISTS guards; CHECK/FK constraints are made idempotent via
-- DROP CONSTRAINT IF EXISTS immediately before ADD CONSTRAINT so re-running
-- this file is a no-op the second time). Preserves all existing rows —
-- unknown/orphan legacy values are normalized/placeholder-backed BEFORE any
-- constraint that would reject them is enforced.

-- ── 5.1 Queue extensions ─────────────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scope_type        text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scope_id          text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requested_by      text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS audit_request_id  uuid;
CREATE INDEX IF NOT EXISTS jobs_scope_idx ON jobs (scope_type, scope_id, id DESC);

-- Allow 'cancelled'; keep 'failed' (normal retries leave the job pending, but
-- existing/legacy deployments may still carry 'failed' rows).
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled'));

-- ── 5.2 Research/analytics telemetry ─────────────────────────────────────────
-- Analytics-owned: the worker database role must never mutate these (revoked
-- below, mirroring migration 0016). Writes come only through the authenticated
-- analytics-provider endpoints (out of scope here; see docs §6.2).
CREATE TABLE IF NOT EXISTS analytics_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            bigint REFERENCES jobs(id) ON DELETE SET NULL,
  job_kind          text NOT NULL,
  attempt           int NOT NULL,
  asof              date NOT NULL,
  source_mode       text NOT NULL CHECK (source_mode IN ('live', 'hermetic')),
  tools             jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'succeeded', 'warning', 'failed')),
  current_stage     text,
  code_version      text NOT NULL DEFAULT 'unknown',
  warning_count     int NOT NULL DEFAULT 0,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  created_by        text NOT NULL,
  audit_request_id  uuid
);
-- No uniqueness on (job_id, attempt): a failed telemetry begin + a subsequent
-- retry must not block a new trace; list projection picks the latest.
CREATE INDEX IF NOT EXISTS analytics_runs_started_idx ON analytics_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS analytics_runs_job_attempt_idx ON analytics_runs (job_id, attempt);
CREATE INDEX IF NOT EXISTS analytics_runs_asof_kind_idx ON analytics_runs (asof DESC, job_kind);

CREATE TABLE IF NOT EXISTS analytics_stage_runs (
  id                bigserial PRIMARY KEY,
  analytics_run_id  uuid REFERENCES analytics_runs(id) ON DELETE CASCADE,
  tool_id           text NOT NULL,
  stage             text NOT NULL
                      CHECK (stage IN ('access', 'extract', 'transform', 'analyze', 'store', 'report')),
  sequence          smallint NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'succeeded', 'warning', 'failed', 'skipped')),
  started_at        timestamptz,
  finished_at       timestamptz,
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text,
  UNIQUE (analytics_run_id, tool_id, stage)
);

CREATE TABLE IF NOT EXISTS analytics_artifacts (
  id                bigserial PRIMARY KEY,
  analytics_run_id  uuid REFERENCES analytics_runs(id) ON DELETE CASCADE,
  stage_run_id      bigint REFERENCES analytics_stage_runs(id) ON DELETE CASCADE,
  tool_id           text NOT NULL,
  kind              text NOT NULL,
  artifact_key      text NOT NULL,
  checksum          text,
  row_count         int,
  first_date        date,
  last_date         date,
  preview           jsonb,               -- bounded to <=250 points by the write path
  storage_ref       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_artifacts_run_tool_idx ON analytics_artifacts (analytics_run_id, tool_id);
CREATE INDEX IF NOT EXISTS analytics_artifacts_key_created_idx ON analytics_artifacts (artifact_key, created_at DESC);

-- The worker role gets these tables via 0016's ALTER DEFAULT PRIVILEGES (any
-- table created after 0016 by the same owning role inherits the broad grant);
-- explicitly claw back write access the same way 0016 did for the tables that
-- existed before it (analytics-worker-role.test.ts pins this set).
REVOKE INSERT, UPDATE, DELETE ON analytics_runs, analytics_stage_runs, analytics_artifacts FROM rm_worker;

-- ── 5.4 Audit extension ──────────────────────────────────────────────────────
-- Landed here, ahead of §5.3, because §5.3's roster backfill below writes
-- target_type/target_id/outcome on audit_log and needs those columns to
-- already exist.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id   uuid DEFAULT gen_random_uuid();
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_type  text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_id    text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS reason       text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS before_state jsonb;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS after_state  jsonb;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS outcome      text NOT NULL DEFAULT 'succeeded';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS job_id       bigint REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS session_id   uuid REFERENCES committee_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_request_idx ON audit_log (request_id);

-- ── 5.3 Committee integrity and scheduling ──────────────────────────────────
ALTER TABLE committee_members  ADD COLUMN IF NOT EXISTS version    int NOT NULL DEFAULT 1;
ALTER TABLE committee_members  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE committee_subjects ADD COLUMN IF NOT EXISTS version    int NOT NULL DEFAULT 1;
ALTER TABLE committee_subjects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS version    int NOT NULL DEFAULT 1;
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS brief_opens_at  timestamptz;
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS publish_at      timestamptz;
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS cancelled_at    timestamptz;
-- window_closes_at and published_at already exist (migration 0004).

-- Normalize BEFORE enforcing checks so legacy/unexpected values never break
-- the migration.
UPDATE committee_members SET status = 'inactive'
  WHERE status NOT IN ('applied', 'active', 'inactive');
ALTER TABLE committee_members DROP CONSTRAINT IF EXISTS committee_members_status_check;
ALTER TABLE committee_members ADD CONSTRAINT committee_members_status_check
  CHECK (status IN ('applied', 'active', 'inactive'));

UPDATE committee_subjects SET status = 'inactive'
  WHERE status NOT IN ('active', 'inactive');
ALTER TABLE committee_subjects DROP CONSTRAINT IF EXISTS committee_subjects_status_check;
ALTER TABLE committee_subjects ADD CONSTRAINT committee_subjects_status_check
  CHECK (status IN ('active', 'inactive'));

UPDATE committee_applications SET status = 'rejected'
  WHERE status NOT IN ('pending', 'approved', 'rejected');
ALTER TABLE committee_applications DROP CONSTRAINT IF EXISTS committee_applications_status_check;
ALTER TABLE committee_applications ADD CONSTRAINT committee_applications_status_check
  CHECK (status IN ('pending', 'approved', 'rejected'));

-- Six legal session states (docs/plan-admin-surface.md §2); no persisted
-- 'brief_published'. Defensively fold any unexpected legacy value to
-- 'scheduled' before enforcing.
UPDATE committee_sessions SET state = 'scheduled'
  WHERE state NOT IN ('scheduled', 'collecting', 'window_closed', 'aggregated', 'published', 'cancelled');
ALTER TABLE committee_sessions DROP CONSTRAINT IF EXISTS committee_sessions_state_check;
ALTER TABLE committee_sessions ADD CONSTRAINT committee_sessions_state_check
  CHECK (state IN ('scheduled', 'collecting', 'window_closed', 'aggregated', 'published', 'cancelled'));

-- Orphan subject_id references (sessions/recommendations/snapshots/briefs):
-- insert an inactive placeholder subject for any id that has no matching row
-- BEFORE adding the foreign keys, so historical data is never rejected.
INSERT INTO committee_subjects (id, status, name)
SELECT DISTINCT orphan_id, 'inactive', orphan_id
FROM (
  SELECT subject_id AS orphan_id FROM committee_sessions
  UNION
  SELECT subject_id FROM committee_recommendations
  UNION
  SELECT subject_id FROM committee_subject_snapshots
  UNION
  SELECT subject_id FROM committee_briefs
) orphans
WHERE orphan_id IS NOT NULL
  AND orphan_id NOT IN (SELECT id FROM committee_subjects)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE committee_sessions DROP CONSTRAINT IF EXISTS committee_sessions_subject_fk;
ALTER TABLE committee_sessions ADD CONSTRAINT committee_sessions_subject_fk
  FOREIGN KEY (subject_id) REFERENCES committee_subjects(id);

ALTER TABLE committee_recommendations DROP CONSTRAINT IF EXISTS committee_recommendations_subject_fk;
ALTER TABLE committee_recommendations ADD CONSTRAINT committee_recommendations_subject_fk
  FOREIGN KEY (subject_id) REFERENCES committee_subjects(id);

ALTER TABLE committee_subject_snapshots DROP CONSTRAINT IF EXISTS committee_subject_snapshots_subject_fk;
ALTER TABLE committee_subject_snapshots ADD CONSTRAINT committee_subject_snapshots_subject_fk
  FOREIGN KEY (subject_id) REFERENCES committee_subjects(id);

ALTER TABLE committee_briefs DROP CONSTRAINT IF EXISTS committee_briefs_subject_fk;
ALTER TABLE committee_briefs ADD CONSTRAINT committee_briefs_subject_fk
  FOREIGN KEY (subject_id) REFERENCES committee_subjects(id);

-- Roster snapshot per session (docs §3: a session snapshots its expected
-- roster at creation; later member changes never rewrite history).
CREATE TABLE IF NOT EXISTS committee_session_members (
  session_id  uuid NOT NULL REFERENCES committee_sessions(id) ON DELETE CASCADE,
  member_id   text NOT NULL REFERENCES committee_members(id),
  member_name text NOT NULL,
  member_lens text,
  status      text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'excused')),
  included_at timestamptz NOT NULL DEFAULT now(),
  excused_at  timestamptz,
  reason      text,
  PRIMARY KEY (session_id, member_id)
);

-- Lifecycle transition history (docs §5.3 / US-C4).
CREATE TABLE IF NOT EXISTS committee_session_events (
  id          bigserial PRIMARY KEY,
  session_id  uuid REFERENCES committee_sessions(id) ON DELETE CASCADE,
  from_state  text,
  to_state    text NOT NULL,
  action      text NOT NULL,
  actor       text NOT NULL,
  reason      text,
  job_id      bigint REFERENCES jobs(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS committee_session_events_session_idx ON committee_session_events (session_id, at);

-- Backfill committee_session_members for every pre-existing session from the
-- historical evidence available. Idempotent: ON CONFLICT DO NOTHING on the
-- (session_id, member_id) primary key, and the "add up to the recorded active
-- count" loop below stops adding once the target is reached, so a second run
-- adds nothing further.
--
-- 1) Every member that actually submitted a recommendation to the session is
--    unambiguously 'expected', using the current name/lens snapshot.
INSERT INTO committee_session_members (session_id, member_id, member_name, member_lens, status, included_at)
SELECT DISTINCT r.session_id, r.member_id, m.name, m.lens, 'expected', now()
FROM committee_recommendations r
JOIN committee_members m ON m.id = r.member_id
ON CONFLICT (session_id, member_id) DO NOTHING;

-- 2) For sessions that recorded committee_recommendation.quorum.active, add
--    currently-active members (ordered by id) until the recorded active count
--    is reached. If there are not enough currently-active members left to
--    reach that count, the exact historical roster cannot be reconstructed —
--    record an approximate backfill audit event for that session.
DO $$
DECLARE
  s RECORD;
  target int;
  have int;
  need int;
BEGIN
  FOR s IN
    SELECT id
    FROM committee_sessions
    WHERE committee_recommendation IS NOT NULL
      AND committee_recommendation ? 'quorum'
      AND (committee_recommendation -> 'quorum' ->> 'active') IS NOT NULL
  LOOP
    target := (SELECT (committee_recommendation -> 'quorum' ->> 'active')::int
               FROM committee_sessions WHERE id = s.id);
    SELECT count(*) INTO have FROM committee_session_members WHERE session_id = s.id;
    need := target - have;
    IF need > 0 THEN
      INSERT INTO committee_session_members (session_id, member_id, member_name, member_lens, status, included_at)
      SELECT s.id, m.id, m.name, m.lens, 'expected', now()
      FROM committee_members m
      WHERE m.status = 'active'
        AND m.id NOT IN (SELECT member_id FROM committee_session_members WHERE session_id = s.id)
      ORDER BY m.id
      LIMIT need
      ON CONFLICT (session_id, member_id) DO NOTHING;
    END IF;

    SELECT count(*) INTO have FROM committee_session_members WHERE session_id = s.id;
    IF have < target THEN
      INSERT INTO audit_log (actor, action, scope, target_type, target_id, outcome)
      SELECT 'system:migration', 'backfill_session_roster',
             jsonb_build_object('sessionId', s.id, 'approximate', true, 'target', target, 'reconstructed', have),
             'committee_session', s.id::text, 'succeeded'
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
        WHERE action = 'backfill_session_roster' AND target_id = s.id::text
      );
    END IF;
  END LOOP;
END
$$;

-- 3) One 'backfill' lifecycle event per pre-existing session, recording its
--    current state at migration time.
INSERT INTO committee_session_events (session_id, from_state, to_state, action, actor, at)
SELECT cs.id, NULL, cs.state, 'backfill', 'system:migration', cs.generated_at
FROM committee_sessions cs
WHERE NOT EXISTS (
  SELECT 1 FROM committee_session_events e
  WHERE e.session_id = cs.id AND e.action = 'backfill'
);

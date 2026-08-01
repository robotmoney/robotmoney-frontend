-- Agent activity log (issue #392, docs/bot-analytics-ui-port-plan.md §5.6,
-- P1.6/P4.1): durable, queryable feed backing the /market + /dashboard
-- TerminalFeed — "Live feed of every tracked agent action across the
-- network." One append-only row per agent action / governance vote /
-- market event. `agent_name` is denormalized at write time (survives an
-- agent record later being removed; joined against openclaw_agents for a
-- live name/link when the agent still exists).
--
-- Forward-only, applied once, tracked in schema_migrations. Idempotent
-- (IF NOT EXISTS). Ingestion that POPULATES this table (the pipeline
-- writer, P1.6) is a separate, not-yet-landed follow-up — same honesty
-- contract as issue #70's `projects` tables: a fresh deploy has an empty
-- table and GET /api/dashboards/activity returns `{ entries: [] }`, never a
-- fabricated seed row (issue #98/#346).
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  agent_id        uuid REFERENCES openclaw_agents(id) ON DELETE SET NULL,
  agent_name      text NOT NULL DEFAULT '',
  action_type     text NOT NULL,
  status          text NOT NULL CHECK (status IN ('success', 'pending', 'rejected')),
  commit_summary  text,
  submitted_by    text,
  approved_by     text,
  -- Zero-score rows are considered noise and filtered by the read query
  -- (§5.6: "50 fetched, zero-score noise filtered"); null is untouched by
  -- the filter (no score attached to this action type).
  score           numeric,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_activity_log_occurred_idx ON agent_activity_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_activity_log_agent_idx ON agent_activity_log (agent_id);

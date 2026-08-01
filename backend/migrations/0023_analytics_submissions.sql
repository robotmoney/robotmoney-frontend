-- Analytics /submit intake (issue #393, docs/bot-analytics-ui-port-plan.md
-- §5.17): public, anonymous agent-onboarding / community-commit submissions.
-- Mirrors committee_applications (0001_backends.sql) — one jsonb payload
-- column plus a moderation status, reviewed later from an admin surface.
-- No auto-publish: everything lands 'pending'.

CREATE TABLE analytics_submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type       text NOT NULL,
  submitter_handle  text NOT NULL,
  agent_id          text,
  summary           text NOT NULL,
  registration      jsonb,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  ip_hash           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_submissions_status_created_idx ON analytics_submissions (status, created_at DESC);

-- Committee agent-health surface (issue #208; resolved design scout #214).
-- Durable, queryable projection for two events that were previously visible
-- only in an agent's private stdout: a roster member missing its expected
-- submission window (recorded once at closeWindow), and a rejected/tampered
-- submission signature (recorded at submitRecommendation). Forward-only,
-- idempotent (IF NOT EXISTS), append-only (no UPDATE/DELETE path).
CREATE TABLE IF NOT EXISTS committee_agent_health_events (
  id          bigserial PRIMARY KEY,
  event_type  text NOT NULL CHECK (event_type IN ('absent', 'rejected_signature')),
  session_id  uuid REFERENCES committee_sessions(id) ON DELETE CASCADE,
  member_id   text REFERENCES committee_members(id),
  -- Bounded, redacted detail ONLY (never a raw signature/public key/payload) —
  -- e.g. { "reason": "signature verification failed" }.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS committee_agent_health_events_session_idx
  ON committee_agent_health_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS committee_agent_health_events_member_idx
  ON committee_agent_health_events (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS committee_agent_health_events_type_idx
  ON committee_agent_health_events (event_type, created_at DESC);

-- Restart-safety: closeWindow must materialize AT MOST ONE 'absent' event per
-- (session, member) even if it is ever invoked more than once for the same
-- session (e.g. a retried job after a worker restart). rejected_signature has
-- no such dedup requirement — a member may legitimately submit several
-- rejected proofs before a valid one, and each attempt is a distinct event.
CREATE UNIQUE INDEX IF NOT EXISTS committee_agent_health_events_absent_once_idx
  ON committee_agent_health_events (session_id, member_id)
  WHERE event_type = 'absent';

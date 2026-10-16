-- compat: additive
-- metadata_version: 1
--
-- A refused take becomes visible (post-mortem 2026-10-09, "why this was hard to
-- see").
--
-- WHY. Since the v0.6.0 cutover every vault and allocation take from woon and
-- shodai was refused 400 `weights_required_for_bucket_weights_subject`. The API
-- logged no line for it and wrote no row: the only trace was the website
-- server's status code and byte count, and the operator's table showed the same
-- members as ordinary absences. The agent-health table recorded only `absent`
-- and `rejected_signature`.
--
-- WHAT IT DOES. Widens the event_type CHECK with `rejected_take` and adds a
-- unique index so a looping agent writes one row per (session, member, refusal
-- code), not one per attempt. The code is `detail->>'code'`, a short token the
-- submit path writes (never a signature, a key or a request body).
--
-- Additive: no existing row changes, and an older image that never writes
-- `rejected_take` is unaffected by the wider CHECK.
ALTER TABLE swarm_agent_health_events
  DROP CONSTRAINT IF EXISTS swarm_agent_health_events_event_type_check;
ALTER TABLE swarm_agent_health_events
  ADD CONSTRAINT swarm_agent_health_events_event_type_check
  CHECK (event_type = ANY (ARRAY['absent', 'rejected_signature', 'rejected_take']));

CREATE UNIQUE INDEX IF NOT EXISTS swarm_agent_health_events_rejected_take_once_idx
  ON swarm_agent_health_events (session_id, member_id, (detail->>'code'))
  WHERE event_type = 'rejected_take';

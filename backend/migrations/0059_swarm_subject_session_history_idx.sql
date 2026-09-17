-- RM-121: the allocation record reads one subject and lifecycle state at a time.
-- Keep keyset pagination bounded as other subjects and same-day sessions grow.
CREATE INDEX IF NOT EXISTS swarm_sessions_subject_state_history_idx
  ON swarm_sessions (subject_id, state, date DESC, generated_at DESC, id DESC);

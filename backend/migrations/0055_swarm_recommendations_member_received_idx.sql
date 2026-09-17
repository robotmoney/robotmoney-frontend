-- Issue #782: getMembers() now LEFT JOIN LATERALs each active member against
-- `max(received_at)` over its own swarm_recommendations rows to expose
-- `lastTakeAt`. swarm_recommendations_member_session_idx (0028) covers
-- (member_id, session_id) — the amendment-cap lookup — but has no ordering on
-- received_at, so the lateral's per-member max() would fall back to a scan of
-- that member's rows. This index makes it an index-only walk to the first row.
--
-- IF NOT EXISTS, in the style of every migration in this directory.
CREATE INDEX IF NOT EXISTS swarm_recommendations_member_received_idx
  ON swarm_recommendations (member_id, received_at DESC);

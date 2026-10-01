-- compat: additive
-- metadata_version: 1
--
-- The event log's table comment names the retention rule that governs it —
-- issue #1026, decision D55 (12).
--
-- D55 (12): "A later migration corrects the table comment 0080 wrote, which
-- still names the cursor bound." 0080's comment says only rm_owner may delete
-- "only rows below the oldest servable cursor (D52, D53 (2))". D55 (12)
-- superseded that bound: the oldest cursor the API may still be asked to serve
-- is not knowable while a scheduler is down, so the log keeps a time window of
-- at least 7 days and is pruned only by the manual, receipted `rm_owner`
-- command `bun run prune` (backend/scripts/prune.ts). A subscriber whose
-- cursor is below the retained floor gets resync-and-close (`log_truncated`)
-- and rebuilds (system-scheduler-spec.md §6.3 Retention).
--
-- ADDITIVE (spec §8.4): a comment changes no statement's meaning.

COMMENT ON TABLE swarm_stream_events IS
  'The scheduler event stream (spec §6). One row per change to what the clock waits on, written in the same transaction as that change, numbered gaplessly in commit order from swarm_stream_head. No runtime role may delete: only the manual, receipted rm_owner command `bun run prune` removes rows, and only rows older than its retention window of at least 7 days. A cursor below the retained floor gets resync-and-close (log_truncated) (D55 (12)).';

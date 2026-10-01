-- compat: additive
-- metadata_version: 1
--
-- The judging duration a session settles under — issue #1026 W4,
-- docs/technical/system-scheduler-spec.md §4.4.
--
-- §4.4: "Judge mode and judging duration are captured at turnover. The
-- session records the judge mode in force (`off` or `enforce`, per D48) and
-- the subject's `judging_duration` at the instant it closes. An admin changing
-- either afterwards affects later sessions, never one already settling."
--
-- Migration 0068 captured the judge mode (`swarm_sessions.judge_mode`). This
-- is the other half: the duration, copied from
-- `swarm_subjects.judging_duration_seconds` (migration 0073) in the turnover
-- transaction. The judging deadline is then the request instant plus THIS
-- column, never plus the subject's current value, so an operator shortening a
-- subject's judging wait cannot move the deadline of a session that is already
-- waiting on a judge.
--
-- NULLABLE, and NULL means "not captured": either the session is still
-- `collecting` (nothing to capture yet), or it closed under code that predates
-- this column. It is not a disabled state — the CHECK refuses zero and
-- negatives, and nothing may default a NULL to some duration.
--
-- WHAT A NULL MEANS TO SETTLEMENT. This column is read once, at the turnover,
-- to COMPUTE `judging_deadline_at`; settlement compares against that stored
-- absolute instant (0068), never against this column. So:
--   * NULL here, `judging_deadline_at` stored — a LEGACY session. It closed
--     before this migration, or during §8.5's migrate-then-boot window when
--     the old code was still turning epochs over, or after a code-only
--     rollback. Its deadline is already fixed; settle it against that stored
--     deadline exactly as today. This is not a defect and must not be refused.
--   * NULL here AND no stored `judging_deadline_at` when settlement needs a
--     deadline — nothing fixed one and nothing can compute one. That, and
--     only that, is the defect for settlement to refuse.
--
-- NO BACKFILL. Existing closed sessions settled (or are settling) under the
-- hardcoded 900-second deadline, and their `judging_deadline_at` is already
-- stored as an absolute instant (0068), which is what finalize compares
-- against. Writing 900 into them would record a capture that never happened.
--
-- ADDITIVE: a nullable column with no default changes nothing any existing
-- statement reads or writes. `swarm_sessions` is append-only for DELETE and
-- TRUNCATE only (0032), so the turnover's UPDATE that will write it is
-- permitted as written.

ALTER TABLE swarm_sessions
  ADD COLUMN IF NOT EXISTS judging_duration_seconds integer;

ALTER TABLE swarm_sessions
  DROP CONSTRAINT IF EXISTS swarm_sessions_judging_duration_seconds_check;
ALTER TABLE swarm_sessions
  ADD CONSTRAINT swarm_sessions_judging_duration_seconds_check
  CHECK (judging_duration_seconds IS NULL OR judging_duration_seconds > 0);

COMMENT ON COLUMN swarm_sessions.judging_duration_seconds IS
  'The subject''s judging duration in force when this epoch CLOSED (scheduler spec §4.4), captured in the turnover transaction beside judge_mode. The judging deadline is the request instant plus this value. NULL while the epoch is still collecting.';

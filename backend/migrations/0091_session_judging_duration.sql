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
-- Migration 0086 captured the judge mode (`swarm_sessions.judge_mode`). This
-- is the other half: the duration, copied from
-- `swarm_subjects.judging_duration_seconds` (migration 0090) in the turnover
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
-- absolute instant (0086), never against this column. So:
--   * NULL here, `judging_deadline_at` stored — a LEGACY session. It closed
--     before this migration, or during §8.5's migrate-then-boot window when
--     the old code was still turning epochs over, or after a code-only
--     rollback. Its deadline is already fixed; settle it against that stored
--     deadline exactly as today. This is not a defect and must not be refused.
--   * NULL here AND no stored `judging_deadline_at` when settlement needs a
--     deadline — nothing fixed one and nothing can compute one. That, and
--     only that, is the defect for settlement to refuse.
--
-- BACKFILL OF IN-FLIGHT SESSIONS (issue 1111). The paragraph above describes
-- sessions that closed under epoch code. A v0.5.4 database holds a different
-- population: sessions the cron driver closed, still unpublished, with
-- `judge_mode` and this column both NULL. The scheduler refuses such a session
-- (`judging_not_captured`) and nobody can fix it by hand, while the owner rule
-- (2026-10-03) is that an upgrade changes how production is deployed, not what
-- it does: these sessions must finish on their normal timing, with no
-- operator step. So the capture is written here, once, for every session in
-- `window_closed`, `aggregated` or `judged` that has none:
--
--   judge_mode         the mode in force now (swarm_judge_config), `shadow`
--                      read as `off` (D48). Exception: a `judged` session
--                      keeps the mode its judgement ran under.
--   judging duration   the subject's current judging_duration_seconds (900
--                      unless an admin set it, 0090), or 900 when the subject
--                      row is gone: the value the old code hardcoded.
--
-- Timestamps already stored (window_closes_at, published_at, ...) are not
-- touched. `collecting` sessions need nothing: the turnover captures at close.
--
-- A session still unjudged is NOT given a judging deadline here. The scheduler
-- aggregates it and requests judging when it next rebuilds, which stores the
-- deadline as request instant plus the duration captured above. Under
-- `enforce` that makes the session `judging`, and the judge participant is
-- served it on connect (smoke spec 6.2): the request is state. This includes
-- a session the old driver was judging when 0089 deleted its pending
-- `swarm.judge` job: nothing is lost, the judge gets it through the stream.
--
-- A legacy `judged` session ran the old inline judge:
--   * with an `enforce` judgement on file it stays `judged`, with the request
--     instant, the deadline and the consensus instant all set from that
--     judgement's own created_at, so finalize decides `judged` (a consensus
--     at or before the deadline) and publishes it as the old driver would.
--   * otherwise (a `shadow` judgement, which never reached the session, or
--     none) it returns to `aggregated`, the state it was in before the shadow
--     run, and settles under `off`: published `not_judged`, the shadow row
--     kept as history.

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

-- The backfill described under "BACKFILL OF IN-FLIGHT SESSIONS" above. It runs
-- after the column and its CHECK exist, and every statement is guarded by the
-- NULL it fills, so a re-run changes nothing.
DO $$
DECLARE
  config_mode text;
BEGIN
  SELECT CASE WHEN mode = 'enforce' THEN 'enforce' ELSE 'off' END
    INTO config_mode FROM swarm_judge_config WHERE id = 1;
  config_mode := COALESCE(config_mode, 'off');

  -- legacy `judged`, enforce judgement on file: settle by it
  UPDATE swarm_sessions s
     SET judge_mode = 'enforce',
         judging_duration_seconds = COALESCE(
           (SELECT t.judging_duration_seconds FROM swarm_subjects t WHERE t.id = s.subject_id), 900),
         judging_requested_at = j.at,
         judging_deadline_at = j.at + make_interval(secs => COALESCE(
           (SELECT t.judging_duration_seconds FROM swarm_subjects t WHERE t.id = s.subject_id), 900)),
         consensus_recorded_at = j.at
    FROM (SELECT session_id, min(created_at) AS at
            FROM swarm_session_judgements WHERE mode = 'enforce' GROUP BY session_id) j
   WHERE j.session_id = s.id AND s.state = 'judged'
     AND s.judge_mode IS NULL AND s.judging_requested_at IS NULL;

  -- legacy `judged`, nothing that reached the session: back to `aggregated`
  UPDATE swarm_sessions
     SET state = 'aggregated'
   WHERE state = 'judged' AND judge_mode IS NULL AND judging_requested_at IS NULL;

  -- every other unpublished session with no capture
  UPDATE swarm_sessions s
     SET judge_mode = COALESCE(s.judge_mode, config_mode),
         judging_duration_seconds = COALESCE(s.judging_duration_seconds,
           (SELECT t.judging_duration_seconds FROM swarm_subjects t WHERE t.id = s.subject_id), 900)
   WHERE s.state IN ('window_closed', 'aggregated', 'judged')
     AND (s.judge_mode IS NULL OR s.judging_duration_seconds IS NULL);
END
$$;

COMMENT ON COLUMN swarm_sessions.judging_duration_seconds IS
  'The subject''s judging duration in force when this epoch CLOSED (scheduler spec §4.4), captured in the turnover transaction beside judge_mode. The judging deadline is the request instant plus this value. NULL while the epoch is still collecting.';

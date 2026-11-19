-- compat: additive
-- metadata_version: 1
--
-- The buyback refresh job stops running (issue 1184).
--
-- WHY. buybacks.refresh held the shared analytics worker past its 900 s
-- heartbeat budget. On the 0.6.0 twin gate run of 2026-10-06 (stage-2) the
-- probe read "no progress for 3271s ... job buybacks.refresh", while the job
-- halved an eth_getLogs range over and over from a scan position days behind
-- the chain head. No other job reads what it writes. The owner decided on
-- 2026-11-19 to stop the job and keep its code for reference.
--
-- WHAT IT DOES.
--   1. Every buybacks.refresh row in job_schedules is disabled, so the
--      scheduler enqueues nothing more of that kind.
--   2. Every pending or running buybacks.refresh job is dead-lettered, so no
--      worker claims one. job_runs history stays.
--
-- ADDITIVE. No column, table, row or grant is removed. buyback_swaps and
-- buyback_scan_state keep their rows. An older image reads the disabled row
-- and enqueues nothing, which is the intent.
--
-- Idempotent: each statement matches only rows not already in its end state.

UPDATE job_schedules
   SET enabled = false
 WHERE kind = 'buybacks.refresh' AND enabled;

UPDATE jobs
   SET status = 'dead',
       locked_at = NULL,
       locked_by = NULL,
       last_error = 'buybacks.refresh disabled (issue 1184)',
       updated_at = now()
 WHERE kind = 'buybacks.refresh' AND status IN ('pending', 'running');

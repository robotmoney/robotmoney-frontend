-- compat: additive
-- metadata_version: 1
--
-- A third catch-up policy, 'latest-only', for the six heavy kinds (issue 1378).
--
-- WHY. tickScheduler (worker/scheduler.ts) enqueues one job per missed cron
-- slot under 'all'. On the v0.6.2 stage QA boot of 2026-10-15 (19:12Z
-- production dump, boot 21:07:25-21:08:10Z) that put two extra parity sweeps
-- and every missed projects/ops slot on the single worker-analytics lane: 131
-- jobs were due by 21:13, and live wallet samplers waited behind them. A heavy
-- job recomputes current state from scratch, so only its newest slot carries
-- any work; every older slot is the same run repeated.
--
-- WHAT IT DOES.
--   1. The CHECK accepts 'latest-only' next to 'all' and 'collapse-per-bucket'.
--   2. The six heavy kinds move to 'latest-only': a boot after downtime
--      enqueues one job for each, at its newest due slot.
--
-- ADDITIVE. The CHECK only widens. An older image reads 'latest-only' as
-- anything other than 'collapse-per-bucket', which is its 'all' branch: it
-- enqueues every missed slot, exactly what it did before this file. No row is
-- removed and no grant changes.
ALTER TABLE job_schedules DROP CONSTRAINT IF EXISTS job_schedules_catchup_policy_check;
ALTER TABLE job_schedules
  ADD CONSTRAINT job_schedules_catchup_policy_check
  CHECK (catchup_policy IN ('all', 'collapse-per-bucket', 'latest-only'));

UPDATE job_schedules
   SET catchup_policy = 'latest-only'
 WHERE kind IN (
   'analytics.parity_sweep',
   'projects.refresh_wallets',
   'projects.fetch_vaults',
   'projects.refresh_coins',
   'ops.repair_gaps',
   'ops.backfill_asset_prices'
 );

-- Per-schedule catch-up policy for backlog replay (issue #651).
--
-- tickScheduler's catch-up loop (worker/scheduler.ts) enqueues one job per
-- missed cron slot when a schedule has fallen behind. For most kinds that is
-- right — each slot's own occurrence carries distinct work (buybacks indexing
-- new on-chain events, a projects pipeline step advancing state). But
-- wallet.sample_balances / wallet.sample_sleeves upsert a single
-- (sample_date, symbol) row per UTC day (migration 0014's natural key) via a
-- LIVE Base RPC read each time — an hourly-behind sampler down for 8 hours
-- does 8 live chain reads on restart to produce the one row a single read
-- would have produced. The reads are individually correct
-- (worker/handlers/slot.ts's same-bucket-catchup case), just redundant N-1
-- times over.
--
-- 'all' (default): every missed slot gets its own job — current behaviour,
-- unchanged for every existing schedule except the two below.
-- 'collapse-per-bucket': tickScheduler enqueues only the LAST due slot per
-- UTC-day bucket, so same-day backlog folds into one job instead of one per
-- missed slot. slot.ts's same-bucket/past-bucket classification is untouched
-- for whichever single slot per day does get enqueued and run.
ALTER TABLE job_schedules
  ADD COLUMN IF NOT EXISTS catchup_policy text NOT NULL DEFAULT 'all'
    CHECK (catchup_policy IN ('all', 'collapse-per-bucket'));

-- Applied to EXISTING rows too (not just db/seed.ts's future inserts, which
-- can't touch a row already on disk — seedJobSchedules() upserts ON CONFLICT
-- DO NOTHING on (kind, cron)) — an upgraded deployment gets the fix on
-- migrate without needing a from-scratch reseed.
UPDATE job_schedules
   SET catchup_policy = 'collapse-per-bucket'
 WHERE kind IN ('wallet.sample_balances', 'wallet.sample_sleeves');

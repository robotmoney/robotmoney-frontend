-- Shared-leg circuit breaker for the Class C wallet backfill (issue #761;
-- docs/technical/markets-asset-pricing-ingest.md §5.3, §8.1).
--
-- deferDay() correctly never charges a day's attempt counter for a shared-leg
-- refusal (the price load, block resolution's head probe, the whole-window
-- multicall) -- that is what stops a ten-second provider blip from retiring
-- ten days permanently. What it never distinguished is a TRANSIENT shared-leg
-- refusal from a PERMANENT one: a mistyped pin or a delisted pool refuses
-- identically on every retry, so the same days were re-selected on every
-- scheduled run forever, spending the whole per-run budget re-earning the
-- same refusal instead of making room for other, repairable gaps.
--
-- These three columns are a per-day, per-leg circuit breaker: `defer_leg`
-- names which shared leg most recently deferred this day, `defer_streak`
-- counts consecutive SEPARATE refusals of that same leg (a burst of retries
-- inside the queue's own backoff window, worker/loop.ts, counts as ONE — see
-- the debounce comment on bumpDeferStreak() in wallet-backfill.ts), and
-- `defer_leg_at` is when the streak was last advanced. Crossing
-- WALLET_BACKFILL_LEG_TERMINAL_THRESHOLD moves the day to the new 'blocked'
-- status: still a disclosed gap (GET /api/admin/gaps derives from the sample
-- tables, never from this one), no longer re-selected every run, and retried
-- automatically once WALLET_BACKFILL_LEG_RETRY_COOLDOWN_MINUTES has passed
-- since the leg's last refusal — so a corrected pin repairs the days on its
-- own, without hand-written SQL.
--
-- Any DAY-SPECIFIC outcome (filled, skipped, or a failDay refusal attributable
-- to that day alone) clears all three columns: the streak tracks consecutive
-- SHARED-leg refusals only, never a day's own problem.
ALTER TABLE wallet_backfill_state DROP CONSTRAINT IF EXISTS wallet_backfill_state_status_check;
ALTER TABLE wallet_backfill_state ADD CONSTRAINT wallet_backfill_state_status_check
  CHECK (status IN ('filled', 'skipped', 'failed', 'exhausted', 'blocked'));

ALTER TABLE wallet_backfill_state ADD COLUMN IF NOT EXISTS defer_leg text;
ALTER TABLE wallet_backfill_state ADD COLUMN IF NOT EXISTS defer_streak int NOT NULL DEFAULT 0;
ALTER TABLE wallet_backfill_state ADD COLUMN IF NOT EXISTS defer_leg_at timestamptz;

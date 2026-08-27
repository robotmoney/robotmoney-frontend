-- Class C wallet/AUM backfill: the date→block cache and the per-day checkpoint.
-- Issue #709; docs/technical/markets-asset-pricing-ingest.md §5.1 and §5.2.
--
-- Neither table holds a measurement. `chain_day_blocks` is a cache of an
-- immutable fact about the chain, and `wallet_backfill_state` is an operational
-- ledger of what the repair driver has attempted. The repaired DATA lands in
-- wallet_balance_samples / wallet_sleeve_samples, tagged provenance='backfilled'
-- so it stays distinguishable from a live sample forever.

-- The resolved LAST BLOCK of each UTC day.
--
-- WHY THE CACHE IS PERMANENT AND NOT A TTL. A past UTC midnight's block is
-- immutable: the answer for 2026-07-04 is the same today, next month, and after
-- the next database rebuild. So a second pass over the same window costs ZERO
-- resolver calls, which matters because resolution is the dominant RPC cost of
-- the backfill (≤8 probes per day, ~340 for a 42-day gap) against a metered
-- ~0.55 calls/s per-IP budget.
--
-- `block_timestamp` is stored, not just the number, so the bracket property the
-- resolver asserts (block.timestamp < next UTC midnight ≤ next block's) is
-- auditable after the fact from the row itself rather than only from the code
-- that wrote it.
CREATE TABLE IF NOT EXISTS chain_day_blocks (
  sample_date     date PRIMARY KEY,
  block_number    bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  resolved_at     timestamptz NOT NULL DEFAULT now()
);

-- Per-day checkpoint for the repair driver.
--
-- Modelled on buyback_scan_state (migration 0015) — a durable cursor that is
-- NOT derived from the data table — but keyed PER DAY rather than as a single
-- row, because the backfill's unit of work is a day and days are processed
-- independently. Committing per day means an interruption loses at most one
-- day's work.
--
-- This is a COST OPTIMISATION, not a correctness mechanism. Correctness comes
-- from the writes themselves: a day is written in ONE transaction, and only
-- into a day that is still empty, so re-running the driver over a day it
-- already filled is a no-op regardless of what this table says.
--
--   'filled'    — the day was read, priced and written.
--   'skipped'   — the day was deliberately not written, and `detail` says why
--                 (already populated by the live sampler; not yet closed).
--   'failed'    — the day could not be read honestly. NOTHING was written for
--                 it, and it will be retried. An unrepaired day must keep
--                 LOOKING unrepaired, which is why it also stays in the gap
--                 report rather than being marked handled.
--   'exhausted' — retried up to the attempt ceiling and still unreadable. Also
--                 written nothing, also still a gap — but no longer retried, so
--                 a permanently unreachable day (e.g. one preceding a token's
--                 deployment) stops spending a metered RPC budget forever. This
--                 is the honest end state for PD8's seed-omission days: they
--                 remain disclosed holes, not silently interpolated ones.
CREATE TABLE IF NOT EXISTS wallet_backfill_state (
  sample_date   date PRIMARY KEY,
  status        text NOT NULL CHECK (status IN ('filled', 'skipped', 'failed', 'exhausted')),
  block_number  bigint,
  balance_rows  int NOT NULL DEFAULT 0,
  sleeve_rows   int NOT NULL DEFAULT 0,
  attempts      int NOT NULL DEFAULT 0,
  detail        text,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_backfill_state_status_idx ON wallet_backfill_state (status, sample_date);

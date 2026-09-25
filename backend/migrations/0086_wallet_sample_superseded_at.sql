-- compat: additive
-- metadata_version: 1
--
-- A supersession tombstone for the wallet AUM samples — issue #1026, decision
-- D55 (6).
--
-- TODAY the wallet backfill's repair pass (src/ops/wallet-backfill.ts) deletes
-- every `wallet_balance_samples` and `wallet_sleeve_samples` row for the date it
-- repairs and inserts the rows it computed, as rm_worker. D55 (6) keeps the
-- effect and removes the delete: the pass upserts the rows it writes (in place,
-- on the natural keys below) and marks `superseded_at` on the date's live rows
-- it no longer writes. Every read of the samples filters
-- `superseded_at IS NULL`. The code change lands in wave 5
-- (w5-wallet-samples-upsert); this file only adds the column and the index it
-- reads through.
--
-- THE PARTIAL INDEXES are the live rows' keys: one live row per
-- (sample_date, symbol) and per (sample_date, wallet_address, symbol), the same
-- keys the existing total UNIQUE constraints hold. They are UNIQUE so they
-- stay the live-row guarantee if a later change relaxes the total constraint
-- to keep superseded history beside a live row; while the total constraint
-- stands they add no refusal of their own. An `ON CONFLICT (sample_date,
-- symbol)` with no WHERE clause still infers the total constraint, never a
-- partial index, so today's upserts are unchanged.
--
-- THE PUBLISHED-SNAPSHOT GUARD. Both tables carry the
-- `*_snapshot_final_guard` trigger (rm_wallet_aum_snapshot_constituent_guard,
-- 0038), which refuses every UPDATE of a row whose `snapshot_run_id` names a
-- run in state 'complete' or 'degraded'. It fires per row on UPDATE of any
-- column, so it permits setting `superseded_at` on a row with no run or with a
-- run that is not final, and refuses it on a row of a published run — a
-- published snapshot stays immutable. ADD COLUMN with no default rewrites no
-- row and fires no row trigger, so this migration is itself allowed on a table
-- holding published rows. backend/tests/delete-tombstone-columns.test.ts
-- proves all three.
--
-- ADDITIVE (spec §8.4): one nullable column per table with no default, every
-- existing row NULL ("live" — true of every row today, since a replaced row is
-- deleted), plus two indexes no current statement is refused by. Code built
-- before this file keeps working unchanged.
--
-- GRANTS: none. rm_worker keeps its worker_dml SELECT, INSERT, UPDATE on both
-- tables (0054, re-asserted by backend/schema/grants.sql). No DELETE is granted
-- anywhere; the DELETE rm_worker holds today is revoked with the code change in
-- wave 5.

ALTER TABLE wallet_balance_samples ADD COLUMN superseded_at timestamptz;
ALTER TABLE wallet_sleeve_samples ADD COLUMN superseded_at timestamptz;

CREATE UNIQUE INDEX wallet_balance_samples_live_key
  ON wallet_balance_samples (sample_date, symbol) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX wallet_sleeve_samples_live_key
  ON wallet_sleeve_samples (sample_date, wallet_address, symbol) WHERE superseded_at IS NULL;

COMMENT ON COLUMN wallet_balance_samples.superseded_at IS
  'When a later repair pass stopped writing this row (D55 (6)): the pass upserts the rows it writes and sets this on the rest instead of deleting them. Every read filters superseded_at IS NULL. NULL = live.';
COMMENT ON COLUMN wallet_sleeve_samples.superseded_at IS
  'When a later repair pass stopped writing this row (D55 (6)): the pass upserts the rows it writes and sets this on the rest instead of deleting them. Every read filters superseded_at IS NULL. NULL = live.';

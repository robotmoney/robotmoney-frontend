-- Quarantine every backfilled wallet/sleeve sample written before the price
-- path named its token (T0.2), and un-settle the days the old path gave up on
-- (T0.3).
--
-- docs/code-review/20260823-review-data-integrity-aum-correctness.md
--
-- WHY. Until de5cf06, chain/historical-prices.ts asked GeckoTerminal for a
-- pool's OHLCV without a `token=` parameter. Absent that parameter the endpoint
-- answers for the pool's BASE side, and resolvePoolForToken picks a pool by
-- 24h volume without ever checking which side the target token sits on. For
-- WETH on Base the ranking is a ~9% near-tie between "WETH / USDC 0.3%" (WETH
-- base, correct) and "cbBTC / WETH 0.05%" (WETH quote, cbBTC's price), so which
-- ASSET the series described was decided by a volume ranking that moves day to
-- day. On the 2026-08-23 twin all 50 backfilled WETH/ETH rows carried a
-- BTC-class price — 58 545 to 69 306 USD against a live-sampled 2 438.
--
-- de5cf06 fixed the WRITER. It cannot fix what the writer already wrote, and
-- this migration is the half that does.
--
-- WHY ALL BACKFILLED ROWS, NOT JUST WETH/ETH. Wrongness arrives in run-sized
-- blocks: the pool is resolved once per process and one request prefetches ~180
-- days, so a single wrong-side resolution poisons a whole window at once. The
-- blocks cannot be reconstructed afterwards either — ops/wallet-backfill.ts
-- stamps `sampled_at` as the SAMPLE DAY's 23:59, not the write time, so run
-- boundaries are unrecoverable from the table. Neither a date cutoff nor a run
-- cutoff can separate the good rows from the bad, so every backfilled row is
-- presumed guilty and adjudicated individually later (T5.1). BNKR/ROBOTMONEY
-- rows that already overlap their live-sampled range are expected to be
-- re-admitted; they are quarantined here anyway because a row is re-admitted by
-- EVIDENCE, not by an assumption made in a migration.
--
-- WHY UPDATE AND NOT DELETE. The wrong values are the evidence. §1.1 of the
-- review is reconstructed entirely from them, T5.1 needs them to adjudicate,
-- and a number nobody can look at afterwards cannot be checked. These two
-- tables are deliberately NOT in migration 0032's append-only list, so both
-- UPDATE and DELETE are physically possible here — the restraint is the point,
-- not the permission.
--
-- WHY A NEW PROVENANCE VALUE RATHER THAN A FLAG COLUMN. provenance already
-- answers "where did this number come from, and how much should you trust it".
-- "It came from the backfill, and the backfill was asking the wrong question"
-- is an answer to exactly that, so it belongs in the same column. There is no
-- CHECK constraint on it (migration 0014 documents the vocabulary in a comment
-- only), so no constraint has to be widened.
--
-- WHAT THIS DOES NOT DO. It does not re-fetch, re-price or re-admit anything —
-- that is T5.1, fed by the Phase 2 plausibility rail pointed backwards. And it
-- runs exactly once, like every migration here: it heals the rows a broken
-- writer left behind, it is not a standing guard against a future one. The
-- standing guard is T1.2's in-band orientation assertion, which is already in
-- the writer, plus T2.2's trigger.

-- ── T0.2 ────────────────────────────────────────────────────────────────────
UPDATE wallet_balance_samples
   SET provenance = 'backfilled-quarantined'
 WHERE provenance = 'backfilled';

UPDATE wallet_sleeve_samples
   SET provenance = 'backfilled-quarantined'
 WHERE provenance = 'backfilled';

-- ── T0.3 ────────────────────────────────────────────────────────────────────
--
-- 'exhausted' means the day was retried up to the attempt ceiling and still
-- could not be read, so selectBackfillDays stops offering it — it is settled by
-- design, and will never retry on its own. Some of those days were exhausted
-- against the OLD path, including against the systematic refusal T1.2 now
-- raises for a wrong-side pool. Deleting the checkpoint returns the day to
-- "never attempted", which is the truth: it has never been attempted by the
-- writer that exists now.
--
-- The row count, not the day list, is what matters here — the days come back
-- from the gap detector on the next plan, which derives the work list from the
-- DATA rather than from this ledger.
--
-- wallet_backfill_state is an operational ledger, not history: it holds no
-- measurement, it is re-derivable by re-attempting the day, and it is
-- deliberately absent from migration 0032's protected list. DELETE is the
-- correct verb for it in a way it never would be for a samples table.
DELETE FROM wallet_backfill_state
 WHERE status = 'exhausted';

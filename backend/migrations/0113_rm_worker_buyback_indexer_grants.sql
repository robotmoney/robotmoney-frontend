-- compat: additive
-- metadata_version: 1
--
-- rm_worker may write the buyback indexer's two tables — issue #1150,
-- runbook blocker B11.
--
-- WHY. The buybacks job handler runs the indexer on the worker's pool, as
-- rm_worker (src/chain/buyback-logs.ts declares its cursor, max-block, insert
-- and advance sites as rm_worker). 0054 replaced 0016's broad worker grant with
-- an explicit allowlist and left both tables off it, so on a database built by
-- the migrations alone rm_worker holds SELECT only and every sweep is refused
-- 42501 (preflight check 2 names it: "rm_worker is missing INSERT, UPDATE on
-- buyback_scan_state"). backend/schema/grants.sql re-asserts these grants on
-- every migrate run; this migration carries them too, as 0061 and 0109 did for
-- the same class of gap, so a database that has applied the ledger holds them
-- without waiting for a reconciliation.
--
-- WHAT IT GRANTS. INSERT and UPDATE on buyback_scan_state (the cursor upsert is
-- INSERT ... ON CONFLICT DO UPDATE); INSERT on buyback_swaps (a decoded swap is
-- inserted, idempotent on tx_hash, and never updated). No DELETE or TRUNCATE
-- (D55 (6)). SELECT rm_worker already holds (0062). The buyback_swaps_id_seq
-- USAGE is already in 0054's set and grants.sql `worker_sequence_usage`.
--
-- ADDITIVE (spec §8.4): it widens privileges; code built before it runs beside
-- it unchanged. IDEMPOTENT: a GRANT already held is a no-op
-- (tests/prod-baseline.test.ts re-applies the newest migration).

GRANT INSERT, UPDATE ON buyback_scan_state TO rm_worker;
GRANT INSERT ON buyback_swaps TO rm_worker;

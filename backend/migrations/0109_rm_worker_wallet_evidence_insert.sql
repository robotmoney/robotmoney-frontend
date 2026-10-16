-- compat: additive
-- metadata_version: 1
--
-- rm_worker may INSERT the wallet repair pass's evidence rows — issue #1026,
-- decision D55 (6).
--
-- THE LIVE DEFECT. The wallet repair pass (src/ops/wallet-backfill.ts
-- repairResolvedDay) runs as rm_worker. Before it rewrites an incomplete day
-- it copies that day's samples into wallet_balance_sample_evidence and
-- wallet_sleeve_sample_evidence (migration 0037's immutable AUM evidence), in
-- the same transaction. 0054 replaced 0016's broad worker grant with an
-- explicit allowlist and left both evidence tables off it; no later migration
-- granted them. So the evidence INSERT fails 42501 ("permission denied for
-- table wallet_balance_sample_evidence") and the repair of every incomplete
-- day rolls back — the same class of bug 0061 fixed for wallet_backfill_state
-- and chain_day_blocks. D55 (6) makes the repair an upsert-and-supersede
-- instead of a delete, and it still copies the evidence first, so the grant is
-- needed either way.
--
-- WHAT IT GRANTS: INSERT, and nothing else. SELECT rm_worker already holds
-- (0062). The evidence is immutable (0037's rm_aum_evidence_guard refuses
-- UPDATE, DELETE and TRUNCATE), so no UPDATE is granted, and D55 (6) gives no
-- runtime role DELETE or TRUNCATE. The evidence_id sequences are already in
-- rm_worker's USAGE set (0054 granted USAGE on every sequence then existing;
-- backend/schema/grants.sql `worker_sequence_usage` re-asserts both).
-- backend/schema/grants.sql `worker_insert_only` re-asserts this grant on every
-- migrate run.
--
-- ADDITIVE (spec §8.4): it widens a privilege; code built before it runs
-- beside it unchanged. IDEMPOTENT: a GRANT already held is a no-op
-- (tests/prod-baseline.test.ts re-applies the newest migration).
--
-- A TABLE 0037 NEVER CREATED IS SKIPPED, the way 0100 skips an absent
-- swarm_judge_config: a database that has not run 0037 has no evidence to
-- grant on, and the repair pass that writes it cannot run there either.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallet_balance_sample_evidence', 'wallet_sleeve_sample_evidence'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '% absent — 0037 has not run on this database; nothing to grant', t;
    ELSE
      EXECUTE format('GRANT INSERT ON public.%I TO rm_worker', t);
    END IF;
  END LOOP;
END
$$;

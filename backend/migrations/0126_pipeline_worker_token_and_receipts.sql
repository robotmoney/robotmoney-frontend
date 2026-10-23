-- compat: additive
-- metadata_version: 1
--
-- The pipeline worker reaches the database through the api only (issue 1034,
-- decision D75). This file adds what the api needs to serve it; 0127 takes the
-- worker's own database role away.
--
-- 1. A FOURTH TOKEN HOLDER. `pipeline-worker` presents an automation token like
--    the scheduler, the producer and the operator (smoke spec §3). It carries
--    two rights and no others: `pipeline_queue` (claim, renew, settle, enqueue,
--    tick, reap) and `pipeline_ingest` (the read and ingestion routes under
--    /api/pipeline/**). The holder and rights CHECKs widen to admit them, the
--    same way 0095 added the producer and the operator. src/db/automation-tokens.ts
--    HOLDER_RIGHTS holds the same lists.
--
-- 2. INGESTION RECEIPTS. Every pipeline write carries an Idempotency-Key. The
--    api records the key, the sha256 of the request body and the response it
--    sent, in the same transaction as the write. A replay with the same key and
--    body gets the recorded response and writes nothing; the same key with a
--    different body is refused 409. Rows are never updated or deleted at
--    runtime: rm_app holds SELECT and INSERT (grants.sql lists the table with
--    the insert-only ledgers), and pruning is an rm_owner step (D55 (6)).
--
-- 3. rm_app WRITES WHAT THE WORKER WROTE. The api now runs the statements the
--    worker ran as rm_worker, so rm_app needs the same writes on the same
--    tables. backend/schema/grants.sql already gives rm_app SELECT, INSERT and
--    UPDATE on every ordinary table on each migrate run; this file carries the
--    grants for the tables created after 0053 whose migrations granted only
--    rm_worker (0061, 0109, 0113, 0115 among them), so a database that has
--    applied the ledger holds them without waiting for a reconciliation, as
--    0113 did for the same class of gap. No DELETE or TRUNCATE (D55 (6)).
--
-- ADDITIVE (spec §8.4). The CHECKs only widen, the table is new and the grants
-- only widen. Code built before this file never presents the new holder and
-- never reads the table. IDEMPOTENT: every statement is guarded or a
-- re-assertion.

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_holder_check;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_holder_check
  CHECK (holder IN ('system-scheduler', 'analytics-producer', 'operator', 'pipeline-worker'));

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_rights_known_check;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_rights_known_check
  CHECK (rights <@ ARRAY[
    'read_subjects', 'read_sessions', 'lifecycle_transitions', 'analytics_ingestion', 'admin',
    'pipeline_queue', 'pipeline_ingest'
  ]::text[]);

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_holder_rights_check;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_holder_rights_check
  CHECK (
    (holder = 'system-scheduler'
       AND rights <@ ARRAY['read_subjects', 'read_sessions', 'lifecycle_transitions']::text[])
    OR (holder = 'analytics-producer' AND rights <@ ARRAY['analytics_ingestion']::text[])
    OR (holder = 'operator' AND rights <@ ARRAY['admin']::text[])
    OR (holder = 'pipeline-worker' AND rights <@ ARRAY['pipeline_queue', 'pipeline_ingest']::text[])
  );

COMMENT ON COLUMN automation_tokens.holder IS
  'Who presents this token: system-scheduler, analytics-producer, operator or pipeline-worker (smoke spec §3). Bounds the rights the row may carry.';
COMMENT ON COLUMN automation_tokens.rights IS
  'What the bearer may do, a subset of its holder''s list: system-scheduler read_subjects/read_sessions/lifecycle_transitions; analytics-producer analytics_ingestion; operator admin; pipeline-worker pipeline_queue/pipeline_ingest.';

CREATE TABLE IF NOT EXISTS pipeline_ingest_receipts (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation       text NOT NULL,
  body_sha256     text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  response        jsonb NOT NULL,
  job_id          bigint,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pipeline_ingest_receipts IS
  'One row per pipeline write the api accepted (issue 1034): the Idempotency-Key, the sha256 of the request body and the response sent. A replay with the same key and body is answered from here and writes nothing.';

GRANT SELECT, INSERT ON pipeline_ingest_receipts TO rm_app;
GRANT SELECT ON pipeline_ingest_receipts TO rm_readonly;

-- Each grant is guarded by to_regclass: a table a database does not have
-- (a replay that skips an older release's files) is passed over, never an
-- error. Production has every one of them.
DO $rm_pipeline_grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_revenue_daily', 'agent_vaults', 'chain_address_floors', 'chain_day_blocks', 'daily_agent_snapshots',
    'daily_coin_snapshots', 'daily_tvl_snapshots', 'daily_wallet_snapshots', 'job_runs', 'job_schedules', 'jobs',
    'lobster_coins', 'openclaw_agents', 'projects', 'tracked_wallets', 'vault_adapter_samples',
    'vault_share_price_history', 'wallet_backfill_state', 'wallet_balance_samples', 'wallet_sleeve_samples',
    'asset_price_floors', 'asset_prices', 'buyback_scan_state', 'token_market_samples'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO rm_app', t);
    END IF;
  END LOOP;
  -- The evidence copies are written once and never changed: rm_app holds no
  -- UPDATE on them (grants.sql lists both with the insert-only ledgers).
  FOREACH t IN ARRAY ARRAY['wallet_balance_sample_evidence', 'wallet_sleeve_sample_evidence', 'buyback_swaps'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO rm_app', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['wallet_balance_sample_evidence', 'wallet_sleeve_sample_evidence'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE ON public.%I FROM rm_app', t);
    END IF;
  END LOOP;
END $rm_pipeline_grants$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_app;

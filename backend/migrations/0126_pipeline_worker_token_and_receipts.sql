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
-- ADDITIVE (spec §8.4). The CHECKs only widen and the table is new. Code built
-- before this file never presents the new holder and never reads the table.
-- IDEMPOTENT: every statement is guarded or a re-assertion.

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

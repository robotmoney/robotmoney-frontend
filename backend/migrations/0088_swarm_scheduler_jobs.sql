-- compat: additive
-- metadata_version: 1
--
-- Job pushes on the scheduler subscription — issue #1026 W4.4,
-- docs/technical/system-scheduler-spec.md §6.3.
--
-- WHAT THE SPEC ASKS FOR, verbatim:
--
--   "Job pushes. An ad-hoc job the API pushes carries kind, target, and an
--    idempotency key. The scheduler acks it through the API when done. Timed
--    redelivery of an unacked job on a live connection is part of the API's
--    serving of that subscription — it is not autonomous orchestration and does
--    not need a background worker. On reconnect the API re-pushes anything
--    unacked."
--
-- WHY A TABLE AND NOT A QUEUE ROW. The existing `jobs` table is the worker's
-- lane: it carries run_after, attempts, backoff and a handler registry, and
-- §4.4 is explicit that settlement "is not scheduled" — reusing that table
-- would smuggle the tick model back in under a different column. This holds
-- three facts and one instant, and nothing polls it: a connection reads it when
-- it opens and while it is live, which is serving, not orchestration.
--
-- WHY THE ROW OUTLIVES THE ACK. `acked_at` is set; the row is never deleted.
-- The idempotency key IS the guarantee, and a guarantee that disappears when
-- the work finishes is no guarantee at all — the identical key would be
-- accepted as fresh work the moment the old row went away. `ON CONFLICT
-- (idempotency_key) DO NOTHING` therefore answers "already pushed" for the life
-- of the log, acked or not.
--
-- WHAT DECIDES DELIVERY is `acked_at IS NULL`, and nothing else. There is no
-- attempt counter and no expiry: a job the scheduler has not finished is work
-- the operator still wants done, and dropping it after N pushes would lose it
-- silently. A job that can never succeed is a bug to see, not a row to expire.

CREATE TABLE IF NOT EXISTS swarm_scheduler_jobs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL,
  target          text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acked_at        timestamptz,
  CONSTRAINT swarm_scheduler_jobs_kind_check CHECK (kind <> ''),
  CONSTRAINT swarm_scheduler_jobs_target_check CHECK (target <> ''),
  CONSTRAINT swarm_scheduler_jobs_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{4,128}$')
);

-- The only query this table ever serves: what is still outstanding, oldest
-- first, so a reconnect re-pushes in the order the jobs were created.
CREATE INDEX IF NOT EXISTS swarm_scheduler_jobs_unacked_idx
  ON swarm_scheduler_jobs (created_at)
  WHERE acked_at IS NULL;

-- The API pushes, reads and acks; no other role has business here. DELETE is
-- deliberately NOT granted: 0053 handed `rm_app` DELETE on ALL TABLES, and a
-- deleted row is a re-runnable idempotency key (see the header).
REVOKE ALL ON swarm_scheduler_jobs FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT, INSERT, UPDATE ON swarm_scheduler_jobs TO rm_app;
GRANT SELECT ON swarm_scheduler_jobs TO rm_worker, rm_readonly;

COMMENT ON TABLE swarm_scheduler_jobs IS
  'Ad-hoc jobs the API pushes on the scheduler subscription (spec §6.3). Rows are never deleted: the idempotency key has to outlive the ack, or the same key would be accepted as new work.';
COMMENT ON COLUMN swarm_scheduler_jobs.idempotency_key IS
  'The caller-supplied identity of this work. Unique for the life of the log, so a re-push is a no-op whether or not the job has been acked.';
COMMENT ON COLUMN swarm_scheduler_jobs.acked_at IS
  'When the scheduler reported the work done. NULL means the job is pushed on every connect and while a connection is live; there is no attempt counter and no expiry.';

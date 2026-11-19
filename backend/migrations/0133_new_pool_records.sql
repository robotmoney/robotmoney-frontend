-- compat: additive
-- metadata_version: 1
--
-- NEW_TOKENS pool records (issue 1654). The legacy NEW_TOKENS sweep stored a
-- computed 24-hour count that was the feed's 10-page fetch cap (100, then 200),
-- not a reading. The producer's new-pools collector now polls GeckoTerminal's
-- new-pools feed every 60 s and stores the source data itself: every pool it
-- sees, once, and one row per poll with the span of pool_created_at the poll
-- read and the coverage gap, if any, before it. The analyst SDK counts unique
-- pools per gap-free UTC day from these rows (transform/new-pools.ts).
--
-- Both tables are append-only, like the source ledger (migration 0057): the
-- same immutability trigger function, no update, delete or truncate. Every
-- statement is idempotent, so a re-run over a schema that has them is a no-op.
-- knowledge_time is always the database clock at insert.
CREATE TABLE IF NOT EXISTS new_pool_records (
  pool_id text PRIMARY KEY CHECK (pool_id <> '' AND length(pool_id) <= 160),
  network text NOT NULL CHECK (network <> '' AND length(network) <= 64),
  pool_created_at timestamptz NOT NULL,
  acquisition_id uuid NOT NULL REFERENCES source_acquisitions(id),
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS new_pool_records_created_idx ON new_pool_records (pool_created_at);

CREATE TABLE IF NOT EXISTS new_pool_polls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acquisition_id uuid NOT NULL UNIQUE REFERENCES source_acquisitions(id),
  oldest_created_at timestamptz NOT NULL,
  newest_created_at timestamptz NOT NULL,
  pages_read integer NOT NULL CHECK (pages_read BETWEEN 1 AND 10),
  pools_seen integer NOT NULL CHECK (pools_seen > 0),
  pools_new integer NOT NULL CHECK (pools_new >= 0 AND pools_new <= pools_seen),
  gap_from timestamptz,
  gap_to timestamptz,
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (oldest_created_at <= newest_created_at),
  CHECK ((gap_from IS NULL) = (gap_to IS NULL)),
  CHECK (gap_from IS NULL OR gap_from < gap_to)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['new_pool_records', 'new_pool_polls'] LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable()', t || '_immutable', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable');
    EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable()', t || '_immutable_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable_row');
  END LOOP;
END;
$$;

REVOKE ALL ON new_pool_records, new_pool_polls FROM PUBLIC, rm_worker;
REVOKE ALL ON SEQUENCE new_pool_polls_id_seq FROM PUBLIC, rm_worker;
GRANT SELECT ON SEQUENCE new_pool_polls_id_seq TO rm_readonly;
GRANT SELECT, INSERT ON new_pool_records, new_pool_polls TO rm_app;
GRANT USAGE, SELECT ON SEQUENCE new_pool_polls_id_seq TO rm_app;
GRANT SELECT ON new_pool_records, new_pool_polls TO rm_readonly;

COMMENT ON TABLE new_pool_records IS 'Every pool the new-pools collector saw, stored once with the knowledge time of the first poll that saw it; append-only (issue 1654).';
COMMENT ON TABLE new_pool_polls IS 'One row per stored new-pools poll: the pool_created_at span it read and the coverage gap before it; append-only (issue 1654).';

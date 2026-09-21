-- Prospective source evidence for Phase A research integrity (issue #976).
-- Current analytics tables remain self-healing views; these five tables are
-- the immutable record of what the producer knew and when it knew it.
CREATE TABLE source_acquisitions (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider <> '' AND length(provider) <= 64),
  parser_version text NOT NULL CHECK (parser_version <> '' AND length(parser_version) <= 128),
  cache_identity text NOT NULL CHECK (cache_identity <> '' AND length(cache_identity) <= 256),
  requested_by_run_id bigint,
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE source_acquisition_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acquisition_id uuid NOT NULL REFERENCES source_acquisitions(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('started', 'succeeded', 'failed')),
  detail text,
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (acquisition_id, sequence)
);

CREATE TABLE source_payloads (
  checksum text PRIMARY KEY CHECK (checksum ~ '^[0-9a-f]{64}$'),
  payload_bytes bytea NOT NULL,
  byte_length bigint GENERATED ALWAYS AS (octet_length(payload_bytes)) STORED,
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (encode(digest(payload_bytes, 'sha256'), 'hex') = checksum)
);

CREATE TABLE source_fetches (
  id uuid PRIMARY KEY,
  acquisition_id uuid NOT NULL REFERENCES source_acquisitions(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  request_identity jsonb NOT NULL,
  cache_status text NOT NULL CHECK (cache_status IN ('disabled', 'hit', 'miss')),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_checksum text REFERENCES source_payloads(checksum),
  provider_release_id text,
  error_detail text,
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (acquisition_id, sequence)
);

CREATE TABLE source_value_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acquisition_id uuid REFERENCES source_acquisitions(id),
  source_key text NOT NULL CHECK (source_key <> '' AND length(source_key) <= 128),
  market_date date,
  market_instant timestamptz,
  value double precision NOT NULL CHECK (
    value <> 'Infinity'::double precision
    AND value <> '-Infinity'::double precision
    AND value <> 'NaN'::double precision
  ),
  prior_version_id bigint REFERENCES source_value_versions(id),
  revision_kind text NOT NULL CHECK (revision_kind IN ('legacy_baseline', 'initial', 'unchanged', 'revision')),
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((market_date IS NOT NULL)::int + (market_instant IS NOT NULL)::int = 1),
  CHECK ((revision_kind = 'legacy_baseline') = (acquisition_id IS NULL))
);

CREATE UNIQUE INDEX source_value_versions_acquisition_key_idx
  ON source_value_versions (acquisition_id, source_key, market_date, market_instant) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX source_value_versions_one_successor_idx
  ON source_value_versions (prior_version_id) WHERE prior_version_id IS NOT NULL;
CREATE UNIQUE INDEX source_value_versions_legacy_baseline_idx
  ON source_value_versions (source_key, market_date) WHERE revision_kind = 'legacy_baseline';
CREATE INDEX source_value_versions_lookup_idx
  ON source_value_versions (source_key, market_date, market_instant, knowledge_time DESC, id DESC);

-- One honest baseline per current row. statement_timestamp() is fixed for the
-- migration transaction; no source response or release identifier is invented.
INSERT INTO source_value_versions
  (source_key, market_date, value, revision_kind, knowledge_time)
SELECT 'raw_indicator_history:' || indicator, date, value, 'legacy_baseline', statement_timestamp()
FROM raw_indicator_history
ON CONFLICT DO NOTHING;

CREATE FUNCTION public.rm_source_ledger_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'source ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$fn$;
REVOKE ALL ON FUNCTION public.rm_source_ledger_immutable() FROM PUBLIC;

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'source_acquisitions', 'source_acquisition_events', 'source_payloads',
    'source_fetches', 'source_value_versions'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable()', t || '_immutable', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable');
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable()', t || '_immutable_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable_row');
  END LOOP;
END;
$$;

REVOKE ALL ON source_acquisitions, source_acquisition_events, source_payloads, source_fetches, source_value_versions FROM PUBLIC, rm_worker;
REVOKE ALL ON SEQUENCE source_acquisition_events_id_seq, source_value_versions_id_seq FROM PUBLIC, rm_worker, rm_readonly;
GRANT SELECT, INSERT ON source_acquisitions, source_acquisition_events, source_payloads, source_fetches, source_value_versions TO rm_app;
GRANT USAGE, SELECT ON SEQUENCE source_acquisition_events_id_seq, source_value_versions_id_seq TO rm_app;
GRANT SELECT ON SEQUENCE source_acquisition_events_id_seq, source_value_versions_id_seq TO rm_readonly;
GRANT SELECT ON source_acquisitions, source_acquisition_events, source_payloads, source_fetches, source_value_versions TO rm_readonly;

COMMENT ON TABLE source_value_versions IS 'Immutable normalized source observations with distinct market time and database-assigned knowledge time (issue #976).';

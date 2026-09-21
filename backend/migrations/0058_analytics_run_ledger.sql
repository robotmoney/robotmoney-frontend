-- Research integrity Phase A (issue #977): freeze data vintages and analytics
-- runs. Builds the next immutable layer ON TOP of #976's append-only source
-- ledger (source_value_versions et al, migration 0057):
--
--   analytics_ledger_methodology_versions — one row per distinct (tool,
--     config) methodology identity a run can be bound to.
--   analytics_ledger_runs                — the immutable run HEADER. Written
--     once, before the injected AnalyticsDataSource is ever called. There is
--     deliberately NO status/finished_at/warning/error column here: this
--     table can never be UPDATEd (see the trigger below), so there is no
--     column for any code path to update — the run's outcome lives ONLY in
--     analytics_ledger_run_events, never on the header.
--   analytics_ledger_run_events           — append-only, ordered lifecycle
--     events (started/succeeded/degraded/failed) for a run.
--   analytics_data_vintages               — one frozen manifest per (run,
--     tool): the exact set of source_value_versions ids that were eligible
--     under a knowledge-time cutoff + market-time cutoff at freeze time, plus
--     a canonical digest and per-series fingerprints.
--   analytics_vintage_members             — the frozen membership: which
--     source_value_versions.id belongs to which vintage.
--
-- NOT named analytics_runs — that table already exists (migration 0017, a
-- mutable job-run diagnostics table for the admin surface) and is a
-- different, unrelated concept.
--
-- Table names are distinct from source_acquisitions/source_value_versions
-- (#976) on purpose: this ledger records WHICH cutoff-eligible slice of that
-- evidence a given run committed to, not the evidence itself.
CREATE TABLE analytics_ledger_methodology_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_id text NOT NULL CHECK (tool_id <> '' AND length(tool_id) <= 64),
  version_label text NOT NULL CHECK (version_label <> '' AND length(version_label) <= 128),
  config jsonb NOT NULL,
  config_digest text NOT NULL CHECK (config_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tool_id, config_digest)
);

CREATE TABLE analytics_ledger_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Caller-generated idempotency key (mirrors source_acquisitions.id, #976):
  -- a retried begin-run submission with the SAME run_key returns the
  -- already-persisted header rather than creating a second one (issue #977 AC8).
  run_key text NOT NULL UNIQUE CHECK (run_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  asof date NOT NULL,
  tool_id text NOT NULL CHECK (tool_id <> '' AND length(tool_id) <= 64),
  source_label text NOT NULL CHECK (source_label IN ('live', 'hermetic', 'fixture')),
  methodology_version_id bigint NOT NULL REFERENCES analytics_ledger_methodology_versions(id),
  build_identity text NOT NULL CHECK (build_identity <> '' AND length(build_identity) <= 256),
  -- Deliberately NO foreign key to jobs(id) (same choice as
  -- research_pipeline_runs.job_id, migration 0018): `jobs` churns and this
  -- table blocks UPDATE outright (see the immutability trigger below), so an
  -- ON DELETE SET NULL action on a job's own cleanup would itself be an
  -- UPDATE the trigger refuses, taking the unrelated job deletion down with
  -- it. A plain, unenforced bigint is the correct correlation id here.
  job_id bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX analytics_ledger_runs_asof_idx ON analytics_ledger_runs (asof DESC);
CREATE INDEX analytics_ledger_runs_job_idx ON analytics_ledger_runs (job_id);

CREATE TABLE analytics_ledger_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES analytics_ledger_runs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('started', 'succeeded', 'degraded', 'failed')),
  detail text,
  knowledge_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE analytics_data_vintages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES analytics_ledger_runs(id),
  tool_id text NOT NULL CHECK (tool_id <> '' AND length(tool_id) <= 64),
  knowledge_time_cutoff timestamptz NOT NULL,
  market_time_cutoff date NOT NULL,
  methodology_version_id bigint NOT NULL REFERENCES analytics_ledger_methodology_versions(id),
  build_identity text NOT NULL CHECK (build_identity <> '' AND length(build_identity) <= 256),
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  member_count integer NOT NULL CHECK (member_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, tool_id)
);

CREATE TABLE analytics_vintage_members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vintage_id bigint NOT NULL REFERENCES analytics_data_vintages(id),
  source_value_version_id bigint NOT NULL REFERENCES source_value_versions(id),
  source_key text NOT NULL CHECK (source_key <> '' AND length(source_key) <= 128),
  UNIQUE (vintage_id, source_value_version_id)
);

CREATE INDEX analytics_vintage_members_vintage_idx ON analytics_vintage_members (vintage_id);

-- Immutable ledger: distinct message from #976's rm_source_ledger_immutable so
-- an operator can tell which layer refused. Blocks UPDATE too (not merely
-- DELETE/TRUNCATE, unlike the generic rm_append_only_guard): a run header,
-- event, methodology version, vintage, or vintage membership is never
-- rewritten.
CREATE FUNCTION public.rm_analytics_run_ledger_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'analytics run ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$fn$;
REVOKE ALL ON FUNCTION public.rm_analytics_run_ledger_immutable() FROM PUBLIC;

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'analytics_ledger_methodology_versions', 'analytics_ledger_runs',
    'analytics_ledger_run_events', 'analytics_data_vintages', 'analytics_vintage_members'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable()', t || '_immutable', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable');
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable()', t || '_immutable_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable_row');
  END LOOP;
END;
$$;

-- Same role split as #976: only the API process (rm_app) may append; the
-- worker/producer role never touches these tables directly (it goes through
-- the authenticated HTTP boundary), and rm_readonly can inspect.
REVOKE ALL ON analytics_ledger_methodology_versions, analytics_ledger_runs, analytics_ledger_run_events, analytics_data_vintages, analytics_vintage_members FROM PUBLIC, rm_worker;
REVOKE ALL ON SEQUENCE
  analytics_ledger_methodology_versions_id_seq, analytics_ledger_runs_id_seq,
  analytics_ledger_run_events_id_seq, analytics_data_vintages_id_seq, analytics_vintage_members_id_seq
  FROM PUBLIC, rm_worker, rm_readonly;
GRANT SELECT, INSERT ON analytics_ledger_methodology_versions, analytics_ledger_runs, analytics_ledger_run_events, analytics_data_vintages, analytics_vintage_members TO rm_app;
GRANT USAGE, SELECT ON SEQUENCE
  analytics_ledger_methodology_versions_id_seq, analytics_ledger_runs_id_seq,
  analytics_ledger_run_events_id_seq, analytics_data_vintages_id_seq, analytics_vintage_members_id_seq
  TO rm_app;
GRANT SELECT ON SEQUENCE
  analytics_ledger_methodology_versions_id_seq, analytics_ledger_runs_id_seq,
  analytics_ledger_run_events_id_seq, analytics_data_vintages_id_seq, analytics_vintage_members_id_seq
  TO rm_readonly;
GRANT SELECT ON analytics_ledger_methodology_versions, analytics_ledger_runs, analytics_ledger_run_events, analytics_data_vintages, analytics_vintage_members TO rm_readonly;

COMMENT ON TABLE analytics_ledger_runs IS 'Immutable analytics run header, written before the injected AnalyticsDataSource is first called (issue #977). Outcome lives only in analytics_ledger_run_events.';
COMMENT ON TABLE analytics_data_vintages IS 'Frozen, fingerprint-verifiable manifest of the source_value_versions eligible under one (knowledge-time, market-time) cutoff pair (issue #977).';

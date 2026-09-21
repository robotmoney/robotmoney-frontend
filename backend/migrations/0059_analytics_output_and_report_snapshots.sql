-- Research integrity Phase A (issue #978): freeze analytics outputs and
-- report snapshots. Builds on #976's source ledger (migration 0057) and
-- #977's run/vintage ledger (migration 0058):
--
--   analytics_output_snapshots — the COMPLETE output artifacts a terminal
--     run produced, byte-exact and checksummed, one row per (run, kind).
--     `regime_snapshots`/`research_signals` kinds accompany a SUCCEEDED
--     terminal package; `warnings`/`logs`/`exceptions` accompany a FAILED
--     one. Unlike regime_snapshots/research_signals (self-healing current
--     views, upserted on their natural key), a row here is never replaced —
--     the exact bytes a run committed survive that run's current-view rows
--     being overwritten by a later run.
--   analytics_report_snapshots — the exact report bytes a SUCCEEDED
--     terminal run produced, one row per run (never per date): two runs for
--     the same market date get two independently addressable snapshots, so
--     a later run never overwrites an earlier one's report.
--   swarm_brief_revisions — append-only brief bodies. Every publishBrief()
--     call appends a new numbered revision instead of overwriting the prior
--     one's body; the previously-mutable swarm_briefs row keeps behaving as
--     a current-view projection (issue #106's contract, read by
--     dashboards/reports), now mirroring the newest revision rather than
--     being the append point itself. Each revision optionally binds to the
--     analytics_report_snapshots row the brief was built from, so a signed
--     recommendation can be checked against the EXACT report its author saw.
--
-- Both swarm_briefs and swarm_recommendations gain a nullable
-- `report_snapshot_id` (no backfill — same documented cutover shape as
-- migration 0049's signing_key_id: every row written before this migration
-- has NULL here and there is no way to reconstruct which report, if any, an
-- old brief or take was made against).
CREATE TABLE analytics_output_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES analytics_ledger_runs(id),
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('regime_snapshots', 'research_signals', 'warnings', 'logs', 'exceptions')),
  payload_bytes bytea NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  byte_length bigint GENERATED ALWAYS AS (octet_length(payload_bytes)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (encode(digest(payload_bytes, 'sha256'), 'hex') = checksum),
  UNIQUE (run_id, artifact_kind)
);
CREATE INDEX analytics_output_snapshots_run_idx ON analytics_output_snapshots (run_id);

CREATE TABLE analytics_report_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL UNIQUE REFERENCES analytics_ledger_runs(id),
  asof date NOT NULL,
  report_bytes bytea NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  byte_length bigint GENERATED ALWAYS AS (octet_length(report_bytes)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (encode(digest(report_bytes, 'sha256'), 'hex') = checksum)
);
CREATE INDEX analytics_report_snapshots_asof_idx ON analytics_report_snapshots (asof DESC);

CREATE TABLE swarm_brief_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES swarm_sessions(id),
  revision integer NOT NULL CHECK (revision > 0),
  body_bytes bytea NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  report_snapshot_id bigint REFERENCES analytics_report_snapshots(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (encode(digest(body_bytes, 'sha256'), 'hex') = checksum),
  UNIQUE (session_id, revision)
);
CREATE INDEX swarm_brief_revisions_session_idx ON swarm_brief_revisions (session_id);

ALTER TABLE swarm_briefs ADD COLUMN IF NOT EXISTS report_snapshot_id bigint REFERENCES analytics_report_snapshots(id);
COMMENT ON COLUMN swarm_briefs.report_snapshot_id IS
  'Mirrors the newest swarm_brief_revisions row for this session (issue #978). NULL for every brief written before this migration and for any session published with no analytics report snapshot available for its date.';

ALTER TABLE swarm_recommendations ADD COLUMN IF NOT EXISTS report_snapshot_id bigint REFERENCES analytics_report_snapshots(id);
COMMENT ON COLUMN swarm_recommendations.report_snapshot_id IS
  'The analytics_report_snapshots row the signed submission named (issue #978 AC6, schema 2.0 canonicalizeSubmission). NULL for every row written before this migration and for a schema-1.0 (legacy, unversioned) submission that named none.';

-- Immutable ledger, same shape as #976/#977: a distinct message from either so
-- an operator can tell which layer refused. Blocks UPDATE too, not merely
-- DELETE/TRUNCATE: an output snapshot, report snapshot, or brief revision is
-- never rewritten — a correction is always a NEW run or a NEW revision.
CREATE FUNCTION public.rm_analytics_output_ledger_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'analytics output ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$fn$;
REVOKE ALL ON FUNCTION public.rm_analytics_output_ledger_immutable() FROM PUBLIC;

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'analytics_output_snapshots', 'analytics_report_snapshots', 'swarm_brief_revisions'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable()', t || '_immutable', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable');
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable()', t || '_immutable_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable_row');
  END LOOP;
END;
$$;

-- Same role split as #976/#977: only the API process (rm_app) may append; the
-- worker/producer role never touches these tables directly, and rm_readonly
-- can inspect.
REVOKE ALL ON analytics_output_snapshots, analytics_report_snapshots, swarm_brief_revisions FROM PUBLIC, rm_worker;
REVOKE ALL ON SEQUENCE
  analytics_output_snapshots_id_seq, analytics_report_snapshots_id_seq, swarm_brief_revisions_id_seq
  FROM PUBLIC, rm_worker, rm_readonly;
GRANT SELECT, INSERT ON analytics_output_snapshots, analytics_report_snapshots, swarm_brief_revisions TO rm_app;
GRANT USAGE, SELECT ON SEQUENCE
  analytics_output_snapshots_id_seq, analytics_report_snapshots_id_seq, swarm_brief_revisions_id_seq
  TO rm_app;
GRANT SELECT ON SEQUENCE
  analytics_output_snapshots_id_seq, analytics_report_snapshots_id_seq, swarm_brief_revisions_id_seq
  TO rm_readonly;
GRANT SELECT ON analytics_output_snapshots, analytics_report_snapshots, swarm_brief_revisions TO rm_readonly;

COMMENT ON TABLE analytics_report_snapshots IS 'Immutable, byte-exact report per terminal analytics run (issue #978). One row per run_id, never per asof — a later run for the same market date gets its own row and its own id.';
COMMENT ON TABLE swarm_brief_revisions IS 'Append-only brief bodies (issue #978): publishBrief() always INSERTs a new numbered revision; swarm_briefs remains the mutable current-view projection of the newest one.';

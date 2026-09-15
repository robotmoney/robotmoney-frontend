-- Research integrity Phase A (issue #979): prove dual-write parity between
-- the ledger built by #976/#977/#978 (source_value_versions,
-- analytics_output_snapshots, analytics_report_snapshots, swarm_brief_revisions)
-- and the pre-existing mutable current-view tables (raw_indicator_history,
-- regime_snapshots, research_signals, swarm_briefs), then gate a cutover of
-- READS from the mutable tables to the ledger on an observation window.
--
--   analytics_read_mode          — the single-row operator switch this issue's
--     cutover flips. Mutable (like swarm_judge_config, migration 0018's
--     one-row config table) — it is configuration, not history; who changed it
--     and when is audit_log, which IS append-only. NOT protected by the guard
--     below on purpose (see backend/src/db/append-only-guard.ts's own list of
--     deliberate exclusions).
--   analytics_parity_observations — immutable evidence that a dual-write parity
--     check ran and what it found. This is the record the cutover gate reads
--     to decide whether the configured minimum observation window (duration +
--     count) has been satisfied with NO mismatch. An observation that could be
--     edited or deleted after the fact would let a failed check be erased
--     rather than superseded by a later, real one — so, like every other
--     Phase A ledger, a correction is a NEW row, never an edit.
CREATE TABLE analytics_read_mode (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode       text NOT NULL DEFAULT 'compatibility' CHECK (mode IN ('compatibility', 'ledger')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text
);
INSERT INTO analytics_read_mode (id, mode, updated_by) VALUES (true, 'compatibility', 'migration 0060');

CREATE TABLE analytics_parity_observations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain              text NOT NULL CHECK (domain IN (
                        'raw_indicator_history', 'regime_snapshots', 'research_signals', 'swarm_briefs'
                      )),
  observed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  legacy_row_count    integer NOT NULL CHECK (legacy_row_count >= 0),
  ledger_row_count    integer NOT NULL CHECK (ledger_row_count >= 0),
  legacy_checksum     text NOT NULL CHECK (legacy_checksum ~ '^[0-9a-f]{64}$'),
  ledger_checksum     text NOT NULL CHECK (ledger_checksum ~ '^[0-9a-f]{64}$'),
  matched             boolean NOT NULL,
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX analytics_parity_observations_domain_idx
  ON analytics_parity_observations (domain, observed_at DESC);

-- Immutable ledger, distinct message from #976/#977/#978 so an operator can
-- tell which layer refused. Blocks UPDATE too, not merely DELETE/TRUNCATE: a
-- parity observation is never rewritten — a re-check is always a NEW row.
CREATE FUNCTION public.rm_analytics_cutover_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'analytics cutover ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$fn$;
REVOKE ALL ON FUNCTION public.rm_analytics_cutover_immutable() FROM PUBLIC;

DO $$
DECLARE
  t text;
  protected text[] := ARRAY['analytics_parity_observations'];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_cutover_immutable()', t || '_immutable', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable');
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_cutover_immutable()', t || '_immutable_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable_row');
  END LOOP;
END;
$$;

-- Same role split as every Phase A ledger table: only the API process
-- (rm_app) may append observations or flip the read mode; rm_worker never
-- touches either directly; rm_readonly can inspect both.
REVOKE ALL ON analytics_parity_observations FROM PUBLIC, rm_worker;
REVOKE ALL ON SEQUENCE analytics_parity_observations_id_seq FROM PUBLIC, rm_worker, rm_readonly;
GRANT SELECT, INSERT ON analytics_parity_observations TO rm_app;
GRANT USAGE, SELECT ON SEQUENCE analytics_parity_observations_id_seq TO rm_app;
GRANT SELECT ON analytics_parity_observations TO rm_readonly;

REVOKE ALL ON analytics_read_mode FROM PUBLIC, rm_worker;
GRANT SELECT, INSERT, UPDATE ON analytics_read_mode TO rm_app;
GRANT SELECT ON analytics_read_mode TO rm_readonly;

COMMENT ON TABLE analytics_read_mode IS
  'Single-row operator switch (issue #979): whether current-view reads (dashboard/admin/raw-history/swarm-brief/regime-summary) resolve from the mutable compatibility tables or are derived from the immutable Phase A ledger. Flipping this writes nothing to any ledger table — cutover and rollback are both non-destructive by construction.';
COMMENT ON TABLE analytics_parity_observations IS
  'Immutable record of one dual-write parity check (issue #979): natural-key/row-count/checksum comparison between a compatibility current-view table and its ledger-derived reconstruction. The cutover gate (backend/src/analytics/cutover/gate.ts) requires an unbroken, sufficiently long, sufficiently large, sufficiently recent run of matched=true observations across every domain before ledger-mode reads are permitted.';

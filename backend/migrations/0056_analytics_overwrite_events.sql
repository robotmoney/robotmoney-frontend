-- Phase A research integrity (issue #974): retain immutable evidence whenever
-- one of the analytics current-view tables is materially replaced or removed.
-- This deliberately does not change those tables' upsert semantics. It makes
-- every future overwrite observable while the versioned source/run ledgers are
-- built in later phase issues. Nothing here fabricates evidence for history
-- that predates deployment.
CREATE TABLE analytics_overwrite_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name      text NOT NULL CHECK (table_name IN (
                    'raw_indicator_history', 'regime_snapshots', 'research_signals'
                  )),
  operation       text NOT NULL CHECK (operation IN ('update', 'delete')),
  natural_key     jsonb NOT NULL,
  previous_row    jsonb NOT NULL,
  replacement_row jsonb,
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT analytics_overwrite_events_replacement_check CHECK (
    (operation = 'update' AND replacement_row IS NOT NULL)
    OR (operation = 'delete' AND replacement_row IS NULL)
  )
);

CREATE INDEX analytics_overwrite_events_lookup_idx
  ON analytics_overwrite_events (table_name, natural_key, recorded_at DESC);

-- The current-view writer must be able to append evidence without gaining any
-- direct privilege on the evidence table. The function is owned by rm_owner,
-- uses a fixed safe search_path, and exposes no callable privilege to runtime
-- roles; PostgreSQL invokes it only through the owner-installed triggers.
CREATE FUNCTION public.rm_capture_analytics_overwrite() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  key jsonb;
BEGIN
  IF TG_TABLE_NAME = 'raw_indicator_history' THEN
    key := jsonb_build_object('date', OLD.date, 'indicator', OLD.indicator);
  ELSIF TG_TABLE_NAME = 'regime_snapshots' THEN
    key := jsonb_build_object('date', OLD.date);
  ELSIF TG_TABLE_NAME = 'research_signals' THEN
    key := jsonb_build_object('signal_key', OLD.signal_key, 'date', OLD.date);
  ELSE
    RAISE EXCEPTION 'unsupported analytics overwrite source table: %', TG_TABLE_NAME;
  END IF;

  INSERT INTO public.analytics_overwrite_events
    (table_name, operation, natural_key, previous_row, replacement_row)
  VALUES
    (TG_TABLE_NAME,
     CASE TG_OP WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
     key,
     to_jsonb(OLD),
     CASE TG_OP WHEN 'UPDATE' THEN to_jsonb(NEW) ELSE NULL END);

  RETURN CASE TG_OP WHEN 'UPDATE' THEN NEW ELSE OLD END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rm_capture_analytics_overwrite() FROM PUBLIC;

DO $$
DECLARE
  t text;
  capture_tables text[] := ARRAY[
    'raw_indicator_history',
    'regime_snapshots',
    'research_signals'
  ];
BEGIN
  FOREACH t IN ARRAY capture_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_capture_overwrite', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE ON public.%I FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION public.rm_capture_analytics_overwrite()',
      t || '_capture_overwrite', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_capture_overwrite');

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_capture_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_capture_analytics_overwrite()',
      t || '_capture_delete', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_capture_delete');
  END LOOP;
END;
$$;

-- Evidence itself is immutable. UPDATE needs its own refusal because the
-- shared append-only guard intentionally covers only DELETE/TRUNCATE.
CREATE FUNCTION public.rm_analytics_overwrite_event_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION
    'analytics_overwrite_events is immutable: UPDATE is not permitted'
    USING ERRCODE = 'feature_not_supported';
END;
$fn$;

REVOKE ALL ON FUNCTION public.rm_analytics_overwrite_event_immutable() FROM PUBLIC;

CREATE TRIGGER analytics_overwrite_events_immutable
  BEFORE UPDATE ON analytics_overwrite_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_overwrite_event_immutable();
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_immutable;

CREATE TRIGGER analytics_overwrite_events_immutable_row
  BEFORE UPDATE ON analytics_overwrite_events
  FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_overwrite_event_immutable();
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_immutable_row;

-- Same declaration shape read by append-only-enforcement.test.ts. This table
-- joins the protected union in its own forward migration; applied 0032 files
-- are never rewritten.
DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'analytics_overwrite_events'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard()',
      t || '_append_only', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');

    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard()',
      t || '_append_only_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only_row');
  END LOOP;
END;
$$;

-- No runtime role can fabricate or alter evidence directly. Read-only access
-- remains available for inspection; the SECURITY DEFINER trigger is the only
-- runtime append path.
REVOKE ALL ON analytics_overwrite_events FROM PUBLIC, rm_app, rm_worker;
REVOKE ALL ON SEQUENCE analytics_overwrite_events_id_seq FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT ON analytics_overwrite_events TO rm_readonly;

COMMENT ON TABLE analytics_overwrite_events IS
  'Immutable evidence of material UPDATE and allowed DELETE operations on analytics current-view rows (issue #974).';

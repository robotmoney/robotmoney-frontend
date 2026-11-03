-- compat: additive
-- metadata_version: 1
--
-- asset_prices overwrites are recorded as revisions (issue 1532, review
-- finding API-6; analytics requirements 4.4: a later revision is a new version
-- next to the old one, it never replaces it).
--
-- WHY. asset_prices is a current view: writeAssetPrice (src/ops/asset-prices.ts)
-- upserts each (price_date, symbol, time_basis) and overwrites a disagreeing
-- price with the fresh one. Migration 0056 captures every material UPDATE and
-- every DELETE of raw_indicator_history, regime_snapshots and research_signals
-- into analytics_overwrite_events. asset_prices was left out, so a revised
-- price left no record of the value it replaced.
--
-- WHAT. The same capture, extended to asset_prices:
--   * analytics_overwrite_events.table_name admits 'asset_prices';
--   * rm_capture_analytics_overwrite() keys an asset_prices row by its primary
--     key (price_date, symbol, time_basis);
--   * an AFTER UPDATE trigger records a change of any column but fetched_at
--     (every refresh rewrites fetched_at, the time we asked, and that alone is
--     not a revision), and an AFTER DELETE trigger records a removal.
-- The evidence table stays immutable and append-only (0056).
--
-- WHY `additive` (smoke spec §8.4). Old code's queries keep their meaning: its
-- upsert of asset_prices still succeeds and now also appends evidence through
-- the owner's SECURITY DEFINER function, which no runtime role can call.
-- Nothing is removed, reshaped or revoked.
--
-- IDEMPOTENT ON RE-APPLY: the constraint and triggers are dropped if present
-- and recreated, and the function is replaced.

ALTER TABLE analytics_overwrite_events DROP CONSTRAINT IF EXISTS analytics_overwrite_events_table_name_check;
ALTER TABLE analytics_overwrite_events ADD CONSTRAINT analytics_overwrite_events_table_name_check CHECK (table_name IN (
  'raw_indicator_history', 'regime_snapshots', 'research_signals', 'asset_prices'
)) NOT VALID;
ALTER TABLE analytics_overwrite_events VALIDATE CONSTRAINT analytics_overwrite_events_table_name_check;

CREATE OR REPLACE FUNCTION public.rm_capture_analytics_overwrite() RETURNS trigger
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
  ELSIF TG_TABLE_NAME = 'asset_prices' THEN
    key := jsonb_build_object('price_date', OLD.price_date, 'symbol', OLD.symbol, 'time_basis', OLD.time_basis);
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

DROP TRIGGER IF EXISTS asset_prices_capture_overwrite ON public.asset_prices;
CREATE TRIGGER asset_prices_capture_overwrite AFTER UPDATE ON public.asset_prices
  FOR EACH ROW WHEN ((to_jsonb(OLD) - 'fetched_at') IS DISTINCT FROM (to_jsonb(NEW) - 'fetched_at'))
  EXECUTE FUNCTION public.rm_capture_analytics_overwrite();
ALTER TABLE public.asset_prices ENABLE ALWAYS TRIGGER asset_prices_capture_overwrite;

DROP TRIGGER IF EXISTS asset_prices_capture_delete ON public.asset_prices;
CREATE TRIGGER asset_prices_capture_delete AFTER DELETE ON public.asset_prices
  FOR EACH ROW EXECUTE FUNCTION public.rm_capture_analytics_overwrite();
ALTER TABLE public.asset_prices ENABLE ALWAYS TRIGGER asset_prices_capture_delete;

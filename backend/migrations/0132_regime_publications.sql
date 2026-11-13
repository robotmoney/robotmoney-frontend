-- compat: additive
-- metadata_version: 1
--
-- Published regime and research figures are frozen (issue 1182, decision D83).
--
-- WHY. GET /api/dashboards/regime-snapshots served, for every past day, the
-- newest run's recomputation instead of the figure published that day. Every
-- regime run carries the whole recomputed history (about 3,100 rows), and both
-- read paths kept the last run per date: regime_snapshots' upsert rewrote every
-- past row, and the ledger read replayed every artifact with the latest run
-- winning. On the production replica every day from 2026-09-21 to 2026-10-04
-- served exactly the newest run's value. research_signals had the same upsert.
--
-- THE RULE (D83). The published figure of day D is the as-of-D row of the last
-- run with as-of D written on or before D (UTC). Once D is over it never
-- changes. A run with as-of D written after D (a replay, or a late run) is D's
-- publication only when nothing was published during D, and the first such run
-- wins. A day with no run that carries its own as-of row is a gap. Days before
-- the ledger start (the as-of day of the first non-empty regime artifact) are
-- frozen at cut-over: what this table serves when this file applies.
--
-- WHAT THIS FILE DOES, in one transaction:
--   1. analytics_ledger_runs accepts source_label 'replay' (issue 1162 records
--      replay runs; this rule must hold whichever lands first).
--   2. regime_publication_baseline freezes the served rows before the ledger
--      start, once, so the ledger read path serves the same figures for them.
--   3. regime_snapshots is repaired to the state the rule would have produced:
--      each day from the ledger start to today gets its publishing run's as-of
--      row, and a day with no publication is removed (2026-09-29 on production).
--      research_signals rows whose payload is not the publication are repaired
--      the same way. Each repair is recorded in analytics_overwrite_events by the
--      0056 capture triggers.
--   4. Two triggers make the rule hold for every writer, including the image
--      still serving while this migrates (C05): an UPDATE of a row dated before
--      today (UTC) is skipped, and an INSERT of a regime row dated between the
--      ledger start and yesterday is skipped unless a run with that as-of day
--      froze it. Skipped, not refused: the writers upsert whole histories, and a
--      refusal would fail every run.
--
-- ADDITIVE and IDEMPOTENT. A second application changes nothing: the baseline
-- insert keeps existing rows, the repair touches only rows that differ, and the
-- triggers are dropped and recreated.
SET LOCAL lock_timeout = '2s';

-- 1. A replay run can be recorded.
ALTER TABLE analytics_ledger_runs DROP CONSTRAINT IF EXISTS analytics_ledger_runs_source_label_check;
ALTER TABLE analytics_ledger_runs ADD CONSTRAINT analytics_ledger_runs_source_label_check
  CHECK (source_label IN ('live', 'hermetic', 'fixture', 'replay'));

-- 2. The frozen pre-ledger baseline. `snapshot` is the row in the shape a regime
-- artifact element has (camelCase), so both read paths decode it the same way.
CREATE TABLE IF NOT EXISTS regime_publication_baseline (
  date      date        PRIMARY KEY,
  snapshot  jsonb       NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now()
);

-- The guards come off while this file repairs the tables, and back on below.
DROP TRIGGER IF EXISTS regime_snapshots_publication_guard ON regime_snapshots;
DROP TRIGGER IF EXISTS research_signals_publication_guard ON research_signals;

INSERT INTO regime_publication_baseline (date, snapshot)
SELECT rs.date,
       jsonb_build_object(
         'date', rs.date::text, 'composite', rs.composite, 'compositePercentile', rs.composite_percentile,
         'regime', rs.regime, 'macroRegime', rs.macro_regime, 'onchainRegime', rs.onchain_regime,
         'factorRegime', rs.factor_regime, 'macroIndex', rs.macro_index, 'onchainIndex', rs.onchain_index,
         'factorIndex', rs.factor_index, 'macroPercentile', rs.macro_percentile,
         'onchainPercentile', rs.onchain_percentile, 'factorPercentile', rs.factor_percentile,
         'panelWeights', rs.panel_weights, 'version', rs.version, 'source', rs.source,
         'percentiles', coalesce(rs.percentiles, '{}'::jsonb), 'indicators', coalesce(rs.indicators, '[]'::jsonb),
         'panels', rs.panels, 'bucketThresholds', rs.bucket_thresholds, 'backtest', rs.backtest,
         'correlations', rs.correlations, 'extras', rs.extras)
  FROM regime_snapshots rs
 WHERE rs.date < coalesce((
         SELECT r.asof FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
          WHERE aos.artifact_kind = 'regime_snapshots' AND cardinality(aos.natural_keys) > 0
          ORDER BY aos.run_id, aos.id LIMIT 1), 'infinity'::date)
ON CONFLICT (date) DO NOTHING;

-- Written by this file alone; every role reads it.
REVOKE ALL ON regime_publication_baseline FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT ON regime_publication_baseline TO rm_app, rm_readonly;

-- 3a. regime_snapshots from the ledger start to today: the publishing run's
-- as-of row, and no row on a day with no publication. One statement, so the
-- three changes read one snapshot; they touch disjoint rows.
ALTER TABLE regime_snapshots DISABLE TRIGGER regime_snapshots_append_only;
ALTER TABLE regime_snapshots DISABLE TRIGGER regime_snapshots_append_only_row;

WITH start AS (
  SELECT r.asof FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
   WHERE aos.artifact_kind = 'regime_snapshots' AND cardinality(aos.natural_keys) > 0
   ORDER BY aos.run_id, aos.id LIMIT 1
),
published AS (
  SELECT DISTINCT ON (r.asof) r.asof AS date, aos.id
    FROM analytics_ledger_runs r
    JOIN analytics_output_snapshots aos ON aos.run_id = r.id AND aos.artifact_kind = 'regime_snapshots'
   CROSS JOIN start s
   WHERE r.asof >= s.asof AND r.asof <= (now() AT TIME ZONE 'UTC')::date
     AND aos.natural_keys @> ARRAY[r.asof::text]
   ORDER BY r.asof, ((aos.created_at AT TIME ZONE 'UTC')::date <= r.asof) DESC,
            CASE WHEN (aos.created_at AT TIME ZONE 'UTC')::date <= r.asof THEN aos.run_id END DESC NULLS LAST,
            aos.run_id, aos.id
),
publication AS (
  SELECT p.date, x.elem
    FROM published p
    CROSS JOIN LATERAL (
      SELECT e.elem FROM analytics_output_snapshots aos
       CROSS JOIN LATERAL jsonb_array_elements(convert_from(aos.payload_bytes, 'UTF8')::jsonb) WITH ORDINALITY AS e(elem, ord)
       WHERE aos.id = p.id AND e.elem ->> 'date' = p.date::text
       ORDER BY e.ord DESC LIMIT 1) x
),
target AS (
  SELECT p.date,
         (p.elem ->> 'composite')::numeric AS composite, (p.elem ->> 'compositePercentile')::numeric AS composite_percentile,
         p.elem ->> 'regime' AS regime, p.elem ->> 'macroRegime' AS macro_regime,
         p.elem ->> 'onchainRegime' AS onchain_regime, p.elem ->> 'factorRegime' AS factor_regime,
         (p.elem ->> 'macroIndex')::numeric AS macro_index, (p.elem ->> 'onchainIndex')::numeric AS onchain_index,
         (p.elem ->> 'factorIndex')::numeric AS factor_index, (p.elem ->> 'macroPercentile')::numeric AS macro_percentile,
         (p.elem ->> 'onchainPercentile')::numeric AS onchain_percentile,
         (p.elem ->> 'factorPercentile')::numeric AS factor_percentile,
         nullif(p.elem -> 'panelWeights', 'null'::jsonb) AS panel_weights, p.elem ->> 'version' AS version,
         p.elem ->> 'source' AS source, nullif(p.elem -> 'percentiles', 'null'::jsonb) AS percentiles,
         nullif(p.elem -> 'indicators', 'null'::jsonb) AS indicators, nullif(p.elem -> 'panels', 'null'::jsonb) AS panels,
         nullif(p.elem -> 'bucketThresholds', 'null'::jsonb) AS bucket_thresholds,
         nullif(p.elem -> 'backtest', 'null'::jsonb) AS backtest,
         nullif(p.elem -> 'correlations', 'null'::jsonb) AS correlations,
         nullif(p.elem -> 'extras', 'null'::jsonb) AS extras
    FROM publication p
),
repaired AS (
  UPDATE regime_snapshots rs SET
    composite = t.composite, composite_percentile = t.composite_percentile, regime = t.regime,
    macro_regime = t.macro_regime, onchain_regime = t.onchain_regime, factor_regime = t.factor_regime,
    macro_index = t.macro_index, onchain_index = t.onchain_index, factor_index = t.factor_index,
    macro_percentile = t.macro_percentile, onchain_percentile = t.onchain_percentile,
    factor_percentile = t.factor_percentile, panel_weights = t.panel_weights, version = t.version,
    source = t.source, percentiles = t.percentiles, indicators = t.indicators, panels = t.panels,
    bucket_thresholds = t.bucket_thresholds, backtest = t.backtest, correlations = t.correlations, extras = t.extras
    FROM target t
   WHERE rs.date = t.date
     AND (rs.composite, rs.composite_percentile, rs.regime, rs.macro_regime, rs.onchain_regime, rs.factor_regime,
          rs.macro_index, rs.onchain_index, rs.factor_index, rs.macro_percentile, rs.onchain_percentile,
          rs.factor_percentile, rs.panel_weights, rs.version, rs.source, rs.percentiles, rs.indicators, rs.panels,
          rs.bucket_thresholds, rs.backtest, rs.correlations, rs.extras)
         IS DISTINCT FROM
         (t.composite, t.composite_percentile, t.regime, t.macro_regime, t.onchain_regime, t.factor_regime,
          t.macro_index, t.onchain_index, t.factor_index, t.macro_percentile, t.onchain_percentile,
          t.factor_percentile, t.panel_weights, t.version, t.source, t.percentiles, t.indicators, t.panels,
          t.bucket_thresholds, t.backtest, t.correlations, t.extras)
  RETURNING rs.date
),
restored AS (
  INSERT INTO regime_snapshots
    (date, composite, composite_percentile, regime, macro_regime, onchain_regime, factor_regime,
     macro_index, onchain_index, factor_index, macro_percentile, onchain_percentile, factor_percentile,
     panel_weights, version, source, percentiles, indicators, panels, bucket_thresholds, backtest, correlations, extras)
  SELECT t.date, t.composite, t.composite_percentile, t.regime, t.macro_regime, t.onchain_regime, t.factor_regime,
         t.macro_index, t.onchain_index, t.factor_index, t.macro_percentile, t.onchain_percentile, t.factor_percentile,
         t.panel_weights, t.version, t.source, t.percentiles, t.indicators, t.panels, t.bucket_thresholds, t.backtest,
         t.correlations, t.extras
    FROM target t
   WHERE NOT EXISTS (SELECT 1 FROM regime_snapshots rs WHERE rs.date = t.date)
  RETURNING date
)
DELETE FROM regime_snapshots rs
 USING start s
 WHERE rs.date >= s.asof AND rs.date <= (now() AT TIME ZONE 'UTC')::date
   AND NOT EXISTS (SELECT 1 FROM published p WHERE p.date = rs.date);

ALTER TABLE regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_append_only;
ALTER TABLE regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_append_only_row;

-- 3b. research_signals: a (signal, day) whose payload is not its publication.
-- Only rows the ledger holds are compared; a row older than the ledger is left
-- as served. The payload hash in natural_keys (0123) finds them, so only their
-- artifacts are parsed.
WITH token AS (
  SELECT split_part(t.tok, chr(31), 1) AS date, split_part(t.tok, chr(31), 2) AS signal_key,
         nullif(split_part(t.tok, chr(31), 3), '') AS hash, aos.run_id, aos.id, t.ord,
         (aos.created_at AT TIME ZONE 'UTC')::date AS written_on
    FROM analytics_output_snapshots aos
   CROSS JOIN LATERAL unnest(aos.natural_keys) WITH ORDINALITY AS t(tok, ord)
   WHERE aos.artifact_kind = 'research_signals'
),
dated AS (
  SELECT *, written_on <= date::date AS on_day FROM token WHERE date ~ '^\d{4}-\d{2}-\d{2}$'
),
published AS (
  SELECT DISTINCT ON (signal_key, date) signal_key, date, hash, id, ord
    FROM dated
   ORDER BY signal_key, date, on_day DESC, CASE WHEN on_day THEN run_id END DESC NULLS LAST,
            CASE WHEN on_day THEN ord END DESC NULLS LAST, run_id, id, ord
),
stale AS (
  SELECT p.signal_key, p.date, p.id, p.ord
    FROM published p JOIN research_signals rs ON rs.signal_key = p.signal_key AND rs.date::text = p.date
   WHERE p.hash IS DISTINCT FROM jsonb_hash_extended(coalesce(rs.payload, 'null'::jsonb), 0)::text
)
UPDATE research_signals rs
   SET payload = x.elem -> 'payload'
  FROM stale s
 CROSS JOIN LATERAL (
   SELECT e.elem FROM analytics_output_snapshots aos
    CROSS JOIN LATERAL jsonb_array_elements(convert_from(aos.payload_bytes, 'UTF8')::jsonb) WITH ORDINALITY AS e(elem, ord)
    WHERE aos.id = s.id AND e.ord = s.ord) x
 WHERE rs.signal_key = s.signal_key AND rs.date::text = s.date;

-- 4. The guards. Run as the writing role (rm_app), which reads both ledgers.
CREATE OR REPLACE FUNCTION public.rm_regime_snapshots_publication_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  ledger_start date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only today's row (or a later one) is still being published.
    IF OLD.date >= today AND NEW.date >= today THEN
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.date >= today THEN
    RETURN NEW;
  END IF;
  SELECT r.asof INTO ledger_start
    FROM public.analytics_output_snapshots aos JOIN public.analytics_ledger_runs r ON r.id = aos.run_id
   WHERE aos.artifact_kind = 'regime_snapshots' AND cardinality(aos.natural_keys) > 0
   ORDER BY aos.run_id, aos.id LIMIT 1;
  -- Before the ledger start a day's first writer publishes it.
  IF ledger_start IS NULL OR NEW.date < ledger_start THEN
    RETURN NEW;
  END IF;
  -- After it, only a run with that as-of day publishes it: never another run's
  -- recomputation of a day nobody published.
  IF EXISTS (
    SELECT 1 FROM public.analytics_ledger_runs r
      JOIN public.analytics_output_snapshots aos ON aos.run_id = r.id AND aos.artifact_kind = 'regime_snapshots'
     WHERE r.asof = NEW.date AND aos.natural_keys @> ARRAY[NEW.date::text]) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rm_regime_snapshots_publication_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rm_research_signals_publication_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF OLD.date >= today AND NEW.date >= today THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rm_research_signals_publication_guard() FROM PUBLIC;

CREATE TRIGGER regime_snapshots_publication_guard BEFORE INSERT OR UPDATE ON regime_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.rm_regime_snapshots_publication_guard();
ALTER TABLE regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_publication_guard;

CREATE TRIGGER research_signals_publication_guard BEFORE UPDATE ON research_signals
  FOR EACH ROW EXECUTE FUNCTION public.rm_research_signals_publication_guard();
ALTER TABLE research_signals ENABLE ALWAYS TRIGGER research_signals_publication_guard;

COMMENT ON TABLE regime_publication_baseline IS
  'Regime rows dated before the ledger start, frozen as served when migration 0132 applied (issue 1182, D83). Written by that migration alone.';

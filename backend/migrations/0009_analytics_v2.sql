-- Analytics v2 (plan: "Faithfully reproduce the original RobotMoney analytics
-- signals"). Ports from agentjuno/robotmoney scripts/regime/. Enriches the regime
-- snapshot row so it stores the full computeRegime output (panel indices,
-- percentiles, point-in-time inverse-correlation panel weights, version, and the
-- richer per-indicator objects in the existing `indicators` jsonb), and adds the
-- append-only persisted-real floor table `raw_indicator_history`.
--
-- Forward-only, applied once, tracked in schema_migrations. Idempotent guards
-- (IF NOT EXISTS / IF EXISTS) so it is safe to re-run on every boot.

-- Enrich regime_snapshots. `composite, composite_percentile, regime,
-- macro_regime, onchain_regime, factor_regime, percentiles, indicators` already
-- exist (0002_dashboards.sql) and are reused; the richer per-indicator objects
-- ({raw_value, raw_date, transformed_value, percentile, signed_percentile,
-- panel_weight, sparkline}) go in the existing `indicators` jsonb.
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS macro_index        numeric;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS onchain_index      numeric;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS factor_index       numeric;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS macro_percentile   numeric;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS onchain_percentile numeric;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS factor_percentile  numeric;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS panel_weights      jsonb;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS version            text;

-- Append-only persisted-real floor. One row per (date, indicator); the
-- orchestrator merges fetched data over this floor (fetched wins on overlap,
-- never deletes) and persists the merged result back. Replaces the unused
-- long-format `regime_indicators` scaffold from 0002 with a clean PK.
CREATE TABLE IF NOT EXISTS raw_indicator_history (
  date      date             NOT NULL,
  indicator text             NOT NULL,
  value     double precision NOT NULL,
  PRIMARY KEY (date, indicator)
);
CREATE INDEX IF NOT EXISTS raw_indicator_history_indicator_idx
  ON raw_indicator_history (indicator);

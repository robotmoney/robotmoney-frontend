-- Regime dashboard extras. The rich regime dashboard carries dashboard-level
-- blobs that belong ONLY on the asof/latest row (NULL on historical rows). The
-- backtest + correlations columns are already added by 0010_backtest_correlations;
-- this migration runs AFTER 0010 (the runner applies migrations/*.sql sorted by
-- filename) and adds ONLY the net-new columns on top:
--   panels            — ordered panel ids shown (e.g. ["macro","onchain","factor"])
--   bucket_thresholds — {risk_off, risk_on} regime cutoffs
--   extras            — price overlays (spx/eth) as [{date, value}] series
--
-- Forward-only, applied once, tracked in schema_migrations. Idempotent guards
-- (IF NOT EXISTS) so it is safe to re-run on every boot.
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS panels            jsonb;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS bucket_thresholds jsonb;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS extras            jsonb;

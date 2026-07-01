-- Backtest + predictive correlations (issue #12: port the original's regime
-- backtest + predictive/concurrent correlations from agentjuno/robotmoney
-- scripts/regime/update.js). These are ASOF-ONLY payloads baked onto the latest
-- regime snapshot row (matching the original, which writes them into
-- public/data/regime-snapshot.json), so they live as two nullable jsonb columns
-- on regime_snapshots rather than a new table. Historical rows keep them NULL.
--
--   backtest      : { [portfolio: eth|sp500|mixed]: { [strategy]: metrics } }
--                   metrics = final_value, cagr, cagr_in_sample, cagr_out_sample,
--                   sharpe, max_drawdown, transitions, n_days, start_date,
--                   end_date, equity_curve (month-end downsample).
--   correlations  : { forward: {...}, concurrent: {...} } — Spearman ρ of each
--                   index level vs forward/concurrent SPX & ETH log-returns.
--
-- Forward-only, applied once, tracked in schema_migrations. Idempotent guards so
-- it is safe to re-run on every boot. Additive/superset — no existing column or
-- path changes.
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS backtest     jsonb;
ALTER TABLE regime_snapshots ADD COLUMN IF NOT EXISTS correlations jsonb;

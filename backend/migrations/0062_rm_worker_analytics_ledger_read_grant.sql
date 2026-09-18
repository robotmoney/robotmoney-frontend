-- Restore rm_worker's SELECT access to the analytics-ledger and
-- source-acquisition tables (0056-0060), missed the same way 0061 missed the
-- wallet-backfill tables.
--
-- WHY THIS BROKE. Migration 0054 replaced 0016's broad/default worker grant
-- with an explicit "GRANT SELECT ON ALL TABLES IN SCHEMA public" snapshot,
-- taken at the time it ran, and its own comment says the consequence plainly:
-- "Future tables start inaccessible to rm_worker." Every migration that adds
-- a table since then has to grant rm_worker SELECT on it itself — 0061 does
-- this for chain_day_blocks/wallet_backfill_state/chain_address_floors, but
-- none of 0056-0060 did it for the sixteen tables they created, so
-- postflight.ts's dynamic "every public table" sweep (part of this same
-- release's own upgrade runbook) is the first thing that ever checked ALL of
-- them together and caught the gap.
--
-- SELECT ONLY, matching 0054's own grant shape: rm_worker reads projections
-- and configuration, and nothing here is a table the worker's own handlers
-- write to, so there is no INSERT/UPDATE/DELETE to add alongside it.
GRANT SELECT ON
  analytics_data_vintages, analytics_ledger_methodology_versions,
  analytics_ledger_run_events, analytics_ledger_runs, analytics_output_snapshots,
  analytics_overwrite_events, analytics_parity_observations, analytics_read_mode,
  analytics_report_snapshots, analytics_vintage_members,
  source_acquisition_events, source_acquisitions, source_fetches, source_payloads,
  source_value_versions, swarm_brief_revisions
TO rm_worker;

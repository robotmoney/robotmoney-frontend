-- Issue #979 AC3: carry raw-history provenance into the source ledger.
--
-- WHY. `raw_indicator_history.source` (issue #397) labels every current row
-- with the data source that produced it — 'live' on the orchestrator's merge
-- path, 'seed' from the vendored gap-fill writer. `source_value_versions`
-- (migration 0057) had no equivalent column, so the ledger-mode answer to
-- GET /api/admin/research/raw-series/:indicator had nothing to return and
-- emitted null. Arming cutover would therefore have silently nulled that field
-- for every point. This column is the ledger's own copy of that label, written
-- by analytics/source-ledger.ts at capture time and read back by
-- analytics/cutover/ledger-current.ts.
--
-- WHY A PLAIN NULLABLE text COLUMN AND NOT jsonb. The expectation is more
-- label VALUES over time ('live', 'seed', a future provider tier), not a
-- structured provenance bag. A text label keeps the ledger row narrow and the
-- DTO field a direct copy; nothing here needs to be queried inside.
--
-- WHY EXISTING ROWS STAY NULL FOREVER. source_value_versions is append-only,
-- protected by the rm_source_ledger_immutable trigger pair (0057). ADD COLUMN
-- is catalog-only DDL and is permitted; a backfill would be an UPDATE and the
-- trigger refuses it — correctly, because rewriting an immutable row to insert
-- a label we did not observe at acquisition time is exactly the fabrication
-- this ledger exists to prevent. 0057's legacy baselines and every row written
-- before this migration keep provenance NULL, honestly marking "not recorded".
ALTER TABLE source_value_versions
  ADD COLUMN provenance text
  CONSTRAINT source_value_versions_provenance_check
  CHECK (provenance IS NULL OR (provenance <> '' AND length(provenance) <= 64));

COMMENT ON COLUMN source_value_versions.provenance IS
  'Data-source label observed at acquisition time (raw_indicator_history.source''s ledger equivalent, issue #979). NULL on migration 0057 legacy baselines and on any row written before migration 0061 — the append-only trigger forbids backfilling it.';

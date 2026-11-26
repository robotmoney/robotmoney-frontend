// Store stage: persist regime snapshots to regime_snapshots, one row per date.
// Upserts on the date primary key so re-running a slot overwrites rather than
// duplicates. The only SQL write for the regime classifier.
//
// A row whose values are all unchanged is skipped (issue 1765 storage S1): the
// DO UPDATE carries WHERE (old columns) IS DISTINCT FROM (EXCLUDED columns), so
// a re-run that recomputes the same history writes no new row version for it.
// The stored values are the same either way, and so is the overwrite evidence,
// because the capture trigger (migration 0056) fires only WHEN (OLD IS DISTINCT
// FROM NEW).
//
// The row carries the full computeRegime output: composite/percentile/regime,
// per-panel indices + percentiles + regimes, the point-in-time
// inverse-correlation panel weights, the methodology `version`, the
// per-indicator `percentiles` map, and the richer per-indicator objects
// ({raw_value, raw_date, transformed_value, percentile, signed_percentile,
// panel_weight, sparkline}) in the `indicators` jsonb. Pure I/O — no compute.
import { sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
// The row shape lives in the pure (DB-free) projection module so the shared eq
// mapper can import it without pulling in this Postgres client. Re-exported here
// for the store's own long-standing consumers (analytics index, tests).
import type { RegimeSnapshotRow } from "../report/regime-projection.ts";
import { SNAPSHOT_COLUMNS } from "../report/published-rows.ts";
import { toDbRow } from "../report/regime-eq-map.ts";
export type { RegimeSnapshotRow };

export async function saveRegimeSnapshots(
  snapshots: RegimeSnapshotRow[],
  db: DbHandle = sql,
): Promise<void> {
  // The orchestrator persists the full recomputed history (~3k rows) each run. Issue 1514
  // (v0.7.1): one statement per chunk of rows, with the rows as one jsonb document, instead of
  // one statement and 23 bound parameters per row. Binding 3k rows one by one kept the api's
  // event loop busy for about a second of the run-package request. Upsert semantics
  // (ON CONFLICT (date)) are unchanged. A date listed twice in a chunk keeps its last row,
  // because one INSERT cannot touch a row twice.
  const CHUNK = 500;
  for (let i = 0; i < snapshots.length; i += CHUNK) {
    const byDate = new Map<string, RegimeSnapshotRow>();
    for (const s of snapshots.slice(i, i + CHUNK)) byDate.set(s.date, s);
    await upsertSnapshots([...byDate.values()], db);
  }
}

// The columns the upsert writes, in the statement's order: every column of the
// snapshot column table (SNAPSHOT_COLUMNS, issue 1765). The probe below is built
// from this list, so it cannot drift from the column list it proves. Every
// column but the `date` key is both SET and compared by the no-op guard.
const UPSERT_COLUMNS: readonly string[] = SNAPSHOT_COLUMNS.map((c) => c.column);

// The non-key columns, in UPSERT_COLUMNS order: the SET list and both sides of the guard.
const UPDATED_COLUMNS = UPSERT_COLUMNS.filter((c) => c !== "date");

// The column definition list of the jsonb document: the column names are the document keys,
// each with its type in the table.
// upsertSnapshots below spells the same lists out, because a registered statement is a tagged
// template whose text cannot be generated. tests/snapshot-columns.test.ts holds each list in it
// equal to SNAPSHOT_COLUMNS.
const UPSERT_RECORD_TYPES = SNAPSHOT_COLUMNS.map((c) => `${c.column} ${c.sqlType}`).join(", ");

const upsertRegime = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  // SELECT as well: ON CONFLICT (date) reads the arbiter column, which Postgres checks as a read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/analytics/store/regime-store:saveRegimeSnapshots",
  purpose: "Upsert regime snapshots on their date, so re-running a slot overwrites the row rather than duplicating it.",
  // The swarm route and the analytics route (through output-snapshot-store) publish snapshots; the
  // one-shot importer writes the vendored fixture.
  callers: ["src/api/routes/swarm", "src/api/routes/analytics", "src/db/import-regime-eq"],
  probe: {
    statement:
      `INSERT INTO regime_snapshots (${UPSERT_COLUMNS.join(", ")}) ` +
      `SELECT ${UPSERT_COLUMNS.join(", ")} FROM jsonb_to_recordset($1::text::jsonb) AS x(${UPSERT_RECORD_TYPES}) ` +
      `ON CONFLICT (date) DO UPDATE SET ${UPDATED_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(", ")} ` +
      `WHERE (${UPDATED_COLUMNS.map((c) => `regime_snapshots.${c}`).join(", ")}) ` +
      `IS DISTINCT FROM (${UPDATED_COLUMNS.map((c) => `EXCLUDED.${c}`).join(", ")})`,
    params: ["[]"],
  },
});

async function upsertSnapshots(rows: RegimeSnapshotRow[], db: DbHandle): Promise<void> {
  // One document per row, keyed by column (toDbRow: one cell per SNAPSHOT_COLUMNS entry).
  const documents = rows.map(toDbRow);
  await on(db, upsertRegime)`
      INSERT INTO regime_snapshots
        (date, composite, composite_percentile, regime,
         macro_regime, onchain_regime, factor_regime,
         macro_index, onchain_index, factor_index,
         macro_percentile, onchain_percentile, factor_percentile,
         panel_weights, version, source, percentiles, indicators,
         panels, bucket_thresholds, backtest, correlations, extras)
      SELECT date, composite, composite_percentile, regime,
         macro_regime, onchain_regime, factor_regime,
         macro_index, onchain_index, factor_index,
         macro_percentile, onchain_percentile, factor_percentile,
         panel_weights, version, source, percentiles, indicators,
         panels, bucket_thresholds, backtest, correlations, extras
      FROM jsonb_to_recordset(${JSON.stringify(documents)}::text::jsonb) AS x(date date, composite numeric, composite_percentile numeric, regime text,
        macro_regime text, onchain_regime text, factor_regime text,
        macro_index numeric, onchain_index numeric, factor_index numeric,
        macro_percentile numeric, onchain_percentile numeric, factor_percentile numeric,
        panel_weights jsonb, version text, source text, percentiles jsonb, indicators jsonb,
        panels jsonb, bucket_thresholds jsonb, backtest jsonb, correlations jsonb, extras jsonb)
      ON CONFLICT (date) DO UPDATE SET
        composite = EXCLUDED.composite,
        composite_percentile = EXCLUDED.composite_percentile,
        regime = EXCLUDED.regime,
        macro_regime = EXCLUDED.macro_regime,
        onchain_regime = EXCLUDED.onchain_regime,
        factor_regime = EXCLUDED.factor_regime,
        macro_index = EXCLUDED.macro_index,
        onchain_index = EXCLUDED.onchain_index,
        factor_index = EXCLUDED.factor_index,
        macro_percentile = EXCLUDED.macro_percentile,
        onchain_percentile = EXCLUDED.onchain_percentile,
        factor_percentile = EXCLUDED.factor_percentile,
        panel_weights = EXCLUDED.panel_weights,
        version = EXCLUDED.version,
        source = EXCLUDED.source,
        percentiles = EXCLUDED.percentiles,
        indicators = EXCLUDED.indicators,
        panels = EXCLUDED.panels,
        bucket_thresholds = EXCLUDED.bucket_thresholds,
        backtest = EXCLUDED.backtest,
        correlations = EXCLUDED.correlations,
        extras = EXCLUDED.extras
      WHERE (regime_snapshots.composite, regime_snapshots.composite_percentile, regime_snapshots.regime,
             regime_snapshots.macro_regime, regime_snapshots.onchain_regime, regime_snapshots.factor_regime,
             regime_snapshots.macro_index, regime_snapshots.onchain_index, regime_snapshots.factor_index,
             regime_snapshots.macro_percentile, regime_snapshots.onchain_percentile, regime_snapshots.factor_percentile,
             regime_snapshots.panel_weights, regime_snapshots.version, regime_snapshots.source,
             regime_snapshots.percentiles, regime_snapshots.indicators,
             regime_snapshots.panels, regime_snapshots.bucket_thresholds, regime_snapshots.backtest,
             regime_snapshots.correlations, regime_snapshots.extras)
        IS DISTINCT FROM
            (EXCLUDED.composite, EXCLUDED.composite_percentile, EXCLUDED.regime,
             EXCLUDED.macro_regime, EXCLUDED.onchain_regime, EXCLUDED.factor_regime,
             EXCLUDED.macro_index, EXCLUDED.onchain_index, EXCLUDED.factor_index,
             EXCLUDED.macro_percentile, EXCLUDED.onchain_percentile, EXCLUDED.factor_percentile,
             EXCLUDED.panel_weights, EXCLUDED.version, EXCLUDED.source,
             EXCLUDED.percentiles, EXCLUDED.indicators,
             EXCLUDED.panels, EXCLUDED.bucket_thresholds, EXCLUDED.backtest,
             EXCLUDED.correlations, EXCLUDED.extras)`;
}

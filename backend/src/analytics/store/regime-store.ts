// Store stage: persist regime snapshots to regime_snapshots, one row per date.
// Upserts on the date primary key so re-running a slot overwrites rather than
// duplicates. The only SQL write for the regime classifier.
//
// The row carries the full computeRegime output: composite/percentile/regime,
// per-panel indices + percentiles + regimes, the point-in-time
// inverse-correlation panel weights, the methodology `version`, the
// per-indicator `percentiles` map, and the richer per-indicator objects
// ({raw_value, raw_date, transformed_value, percentile, signed_percentile,
// panel_weight, sparkline}) in the `indicators` jsonb. Pure I/O — no compute.
import { sql } from "../../db/client.ts";
import type postgres from "postgres";
// The row shape lives in the pure (DB-free) projection module so the shared eq
// mapper can import it without pulling in this Postgres client. Re-exported here
// for the store's own long-standing consumers (analytics index, tests).
import type { RegimeSnapshotRow } from "../report/regime-projection.ts";
export type { RegimeSnapshotRow };

export async function saveRegimeSnapshots(snapshots: RegimeSnapshotRow[]): Promise<void> {
  // The orchestrator persists the full recomputed history (~3k rows) each run, so
  // pipeline the upserts in bounded concurrent chunks rather than one blocking
  // round-trip per row. Upsert semantics (ON CONFLICT (date)) are unchanged.
  const CHUNK = 250;
  for (let i = 0; i < snapshots.length; i += CHUNK) {
    await Promise.all(snapshots.slice(i, i + CHUNK).map(upsertSnapshot));
  }
}

async function upsertSnapshot(s: RegimeSnapshotRow): Promise<void> {
  await sql`
      INSERT INTO regime_snapshots
        (date, composite, composite_percentile, regime,
         macro_regime, onchain_regime, factor_regime,
         macro_index, onchain_index, factor_index,
         macro_percentile, onchain_percentile, factor_percentile,
         panel_weights, version, percentiles, indicators,
         panels, bucket_thresholds, backtest, correlations, extras)
      VALUES
        (${s.date}, ${s.composite}, ${s.compositePercentile}, ${s.regime},
         ${s.macroRegime}, ${s.onchainRegime}, ${s.factorRegime},
         ${s.macroIndex ?? null}, ${s.onchainIndex ?? null}, ${s.factorIndex ?? null},
         ${s.macroPercentile ?? null}, ${s.onchainPercentile ?? null}, ${s.factorPercentile ?? null},
         ${s.panelWeights == null ? null : sql.json(s.panelWeights)}, ${s.version ?? null},
         ${sql.json(s.percentiles)}, ${sql.json(s.indicators as unknown as postgres.JSONValue)},
         ${s.panels == null ? null : sql.json(s.panels as postgres.JSONValue)},
         ${s.bucketThresholds == null ? null : sql.json(s.bucketThresholds as postgres.JSONValue)},
         ${s.backtest == null ? null : sql.json(s.backtest as postgres.JSONValue)},
         ${s.correlations == null ? null : sql.json(s.correlations as postgres.JSONValue)},
         ${s.extras == null ? null : sql.json(s.extras as postgres.JSONValue)})
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
        percentiles = EXCLUDED.percentiles,
        indicators = EXCLUDED.indicators,
        panels = EXCLUDED.panels,
        bucket_thresholds = EXCLUDED.bucket_thresholds,
        backtest = EXCLUDED.backtest,
        correlations = EXCLUDED.correlations,
        extras = EXCLUDED.extras`;
}

// Read one snapshot back as a typed row (numerics coerced from Postgres text).
// Used by the store round-trip tests and available to the report stage.
export async function loadRegimeSnapshot(date: string): Promise<RegimeSnapshotRow | null> {
  const [row] = await sql`SELECT * FROM regime_snapshots WHERE date = ${date}`;
  if (!row) return null;
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    date: typeof row.date === "string" ? row.date : new Date(row.date).toISOString().slice(0, 10),
    composite: num(row.composite),
    compositePercentile: num(row.composite_percentile),
    regime: row.regime ?? null,
    macroRegime: row.macro_regime ?? null,
    onchainRegime: row.onchain_regime ?? null,
    factorRegime: row.factor_regime ?? null,
    macroIndex: num(row.macro_index),
    onchainIndex: num(row.onchain_index),
    factorIndex: num(row.factor_index),
    macroPercentile: num(row.macro_percentile),
    onchainPercentile: num(row.onchain_percentile),
    factorPercentile: num(row.factor_percentile),
    panelWeights: (row.panel_weights ?? null) as Record<string, Record<string, number>> | null,
    version: row.version ?? null,
    percentiles: (row.percentiles ?? {}) as Record<string, number>,
    indicators: (row.indicators ?? []) as RegimeSnapshotRow["indicators"],
    panels: (row.panels ?? null) as readonly string[] | null,
    bucketThresholds: (row.bucket_thresholds ?? null) as Record<string, unknown> | null,
    backtest: (row.backtest ?? null) as Record<string, unknown> | null,
    correlations: (row.correlations ?? null) as Record<string, unknown> | null,
    extras: (row.extras ?? null) as Record<string, unknown> | null,
  };
}

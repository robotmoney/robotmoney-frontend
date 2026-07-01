// Pure (no-I/O, no DB import) regime row → DTO projection. Kept in its own module
// so BOTH the live endpoint (projections.ts, over Postgres rows) and the offline
// eq-snapshot mapper (regime-eq-map.ts, over reshaped in-memory rows) share the
// EXACT same projection — guaranteeing the Playwright stub payload equals what
// GET /api/dashboards/regime-snapshots returns, without dragging in the DB client
// (which requires DATABASE_URL at import time).
import type { RegimeSnapshot } from "@robotmoney/contract";

// A JSON-serializable value. Declared here rather than imported from `postgres`
// so `RegimeSnapshotRow` — and every module that imports only the row TYPE (the
// Playwright stub's shared mapper via regime-eq-map.ts) — stays free of the
// backend-only `postgres` dependency. Structurally the same JSON shape.
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// Persistable snapshot row. Structurally a superset of the legacy
// analyze/regime.ts RegimeSnapshot (whose narrower shape stays assignable), with
// the v2 panel indices/percentiles, panel weights, and version added. `null` is
// accepted for any numeric/label field that a given panel didn't produce.
//
// Lives in this pure (DB-free) module — not in the store — so the shared mapper
// can reference the row shape without dragging in the Postgres client. The store
// re-exports it for its own consumers.
export interface RegimeSnapshotRow {
  date: string;
  composite: number | null;
  compositePercentile: number | null;
  regime: string | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  macroIndex?: number | null;
  onchainIndex?: number | null;
  factorIndex?: number | null;
  macroPercentile?: number | null;
  onchainPercentile?: number | null;
  factorPercentile?: number | null;
  panelWeights?: Record<string, Record<string, number>> | null;
  version?: string | null;
  percentiles: Record<string, number>;
  // Rich per-indicator objects ({raw_value, raw_date, transformed_value,
  // percentile, signed_percentile, panel_weight, sparkline}); JSON-serializable.
  indicators: readonly JsonValue[];
  // Dashboard-level blobs — written ONLY on the asof/latest row (undefined/null on
  // historical rows). Opaque JSON pass-through preserving snake_case inside. Typed
  // `unknown` because two producers feed them: the computed pipeline
  // (analytics/index.ts) passes strongly-typed `BacktestPayload`/`CorrelationsPayload`
  // (interfaces without index signatures), while the offline eq-snapshot mapper
  // passes loose objects — `unknown` accepts both; the store just `sql.json`s them.
  panels?: readonly string[] | null;
  bucketThresholds?: unknown | null;
  backtest?: unknown | null;
  correlations?: unknown | null;
  extras?: unknown | null;
}

// Postgres hands numerics back as text; coerce to number|null. `null`/undefined
// stay null so the DTO's nullable panel fields are honest.
export const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function rowToSnapshot(r: any): RegimeSnapshot {
  return {
    date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
    composite: num(r.composite),
    compositePercentile: num(r.composite_percentile),
    regime: r.regime,
    macroRegime: r.macro_regime,
    onchainRegime: r.onchain_regime,
    factorRegime: r.factor_regime,
    // v2 enrichment: panel indices/percentiles, point-in-time panel weights, version.
    macroIndex: num(r.macro_index),
    onchainIndex: num(r.onchain_index),
    factorIndex: num(r.factor_index),
    macroPercentile: num(r.macro_percentile),
    onchainPercentile: num(r.onchain_percentile),
    factorPercentile: num(r.factor_percentile),
    panelWeights: r.panel_weights ?? null,
    version: r.version ?? null,
    percentiles: r.percentiles ?? {},
    indicators: r.indicators ?? [],
    // Dashboard-level blobs — present only on the asof/latest row (NULL on history).
    panels: r.panels ?? null,
    bucketThresholds: r.bucket_thresholds ?? null,
    backtest: r.backtest ?? null,
    correlations: r.correlations ?? null,
    extras: r.extras ?? null,
  };
}

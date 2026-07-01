// Pure (no-I/O, no DB import) regime row → DTO projection. Kept in its own module
// so BOTH the live endpoint (projections.ts, over Postgres rows) and the offline
// eq-snapshot mapper (regime-eq-map.ts, over reshaped in-memory rows) share the
// EXACT same projection — guaranteeing the Playwright stub payload equals what
// GET /api/dashboards/regime-snapshots returns, without dragging in the DB client
// (which requires DATABASE_URL at import time).
import type { RegimeSnapshot } from "@robotmoney/contract";

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

// Pure (no-I/O) mapper from the canonical rich regime snapshot
// (regime-eq-snapshot.json) onto the two shapes this codebase persists/serves:
//   - eqSnapshotToRows(snap) → RegimeSnapshotRow[] for the store (one flat row per
//     history date, plus ONE enriched asof row carrying the dashboard-level blobs).
//   - mapEqSnapshotToDto(snap) → the exact { latest, history } DTO the live
//     endpoint (fetchRegimeSnapshots → rowToSnapshot) returns for this data, so the
//     Playwright stub and the live endpoint stay byte-identical.
//
// The dashboard-level blobs (panels/bucket_thresholds/backtest/correlations/extras)
// live ONLY on the asof/latest row; history rows stay blob-free. Blob contents keep
// their original snake_case (pass-through), matching the indicators[].panel_weight
// convention.
import type { RegimeHistoryPoint, RegimeSnapshot } from "@robotmoney/contract";
// Import the row type from the pure projection module (NOT the store) so this
// mapper — shared with the root-scoped Playwright stub — never transitively
// reaches the Postgres client. Keeps the module genuinely I/O-free.
import { rowToSnapshot, forHistory, type RegimeSnapshotRow } from "./regime-projection.ts";
import { SNAPSHOT_COLUMNS } from "./published-rows.ts";

// One enriched per-indicator object in the canonical snapshot.
interface EqIndicator {
  id: string;
  percentile: number | null;
  [k: string]: unknown;
}

// One flat historical row in the canonical snapshot's `history[]`.
interface EqHistoryRow {
  date: string;
  composite: number | null;
  regime: string | null;
  macro: number | null;
  macro_regime: string | null;
  onchain: number | null;
  onchain_regime: string | null;
  factor: number | null;
  factor_regime: string | null;
}

// The canonical rich regime snapshot (regime-eq-snapshot.json), snake_case as
// authored upstream. Only the fields consumed here are typed; extras are ignored.
export interface EqSnapshot {
  asof: string;
  version?: string | null;
  composite: number | null;
  composite_percentile: number | null;
  regime: string | null;
  macro_regime: string | null;
  onchain_regime: string | null;
  factor_regime: string | null;
  macro_index: number | null;
  onchain_index: number | null;
  factor_index: number | null;
  macro_percentile: number | null;
  onchain_percentile: number | null;
  factor_percentile: number | null;
  panel_weights?: Record<string, Record<string, number>> | null;
  panels?: string[] | null;
  bucket_thresholds?: Record<string, unknown> | null;
  backtest?: Record<string, unknown> | null;
  correlations?: Record<string, unknown> | null;
  extras?: Record<string, unknown> | null;
  indicators: EqIndicator[];
  history: EqHistoryRow[];
}

// Map one canonical `history[]` row → a blob-free flat RegimeSnapshotRow. Panel
// indices come from the history row's macro/onchain/factor; percentiles/panel
// weights/version/blobs are unset (they belong only on the asof row).
function historyRow(h: EqHistoryRow): RegimeSnapshotRow {
  return {
    date: h.date,
    composite: h.composite,
    compositePercentile: null,
    regime: h.regime,
    macroRegime: h.macro_regime,
    onchainRegime: h.onchain_regime,
    factorRegime: h.factor_regime,
    macroIndex: h.macro,
    onchainIndex: h.onchain,
    factorIndex: h.factor,
    // Provenance (issue #397): this whole snapshot comes from the vendored
    // reference-screenshot fixture, not a live/hermetic run — 'seed'.
    source: "seed",
    percentiles: {},
    indicators: [],
  };
}

// Build the ONE enriched asof row: composite/percentiles/panel weights/version +
// the rich indicators + the dashboard-level blobs.
function asofRow(snap: EqSnapshot): RegimeSnapshotRow {
  const percentiles: Record<string, number> = {};
  for (const ind of snap.indicators) {
    if (ind.percentile != null) percentiles[ind.id] = ind.percentile;
  }
  return {
    date: snap.asof,
    composite: snap.composite,
    compositePercentile: snap.composite_percentile,
    regime: snap.regime,
    macroRegime: snap.macro_regime,
    onchainRegime: snap.onchain_regime,
    factorRegime: snap.factor_regime,
    macroIndex: snap.macro_index,
    onchainIndex: snap.onchain_index,
    factorIndex: snap.factor_index,
    macroPercentile: snap.macro_percentile,
    onchainPercentile: snap.onchain_percentile,
    factorPercentile: snap.factor_percentile,
    panelWeights: snap.panel_weights ?? null,
    version: snap.version ?? "v3",
    source: "seed",
    percentiles,
    indicators: snap.indicators as unknown as RegimeSnapshotRow["indicators"],
    panels: snap.panels ?? null,
    bucketThresholds: snap.bucket_thresholds ?? null,
    backtest: snap.backtest ?? null,
    correlations: snap.correlations ?? null,
    extras: snap.extras ?? null,
  };
}

// Map the canonical snapshot → persistable rows: every history date as a flat row,
// then the enriched asof row LAST so an ON CONFLICT(date) upsert overwrites any
// same-date flat row with the enriched one.
export function eqSnapshotToRows(snap: EqSnapshot): RegimeSnapshotRow[] {
  return [...snap.history.map(historyRow), asofRow(snap)];
}

// Re-shape a camelCase RegimeSnapshotRow into the snake_case object a Postgres
// `SELECT * FROM regime_snapshots` row would yield, so it can pass through the
// endpoint's exact rowToSnapshot projection (parity with the live endpoint).
// One cell per SNAPSHOT_COLUMNS entry, in its order (issue 1765): a date or
// label cell as read, any other cell its value or null (NULL, as Postgres reads
// an unset column). The regime store writes these documents
// (store/regime-store.ts), and the ledger read mode serves rowToSnapshot of them
// (report/projections.ts).
export function toDbRow(r: RegimeSnapshotRow): Record<string, unknown> {
  const row = r as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of SNAPSHOT_COLUMNS) out[c.column] = c.kind === "date" || c.kind === "label" ? row[c.key] : (row[c.key] ?? null);
  return out;
}

// Produce the SAME { latest, history } DTO the live endpoint returns for this
// snapshot. Deduped by date (the asof row overwrites its same-date flat row, exactly
// as ON CONFLICT(date) does in the store), chronological ascending, latest = last.
export function mapEqSnapshotToDto(snap: EqSnapshot): {
  latest: RegimeSnapshot | null;
  history: RegimeHistoryPoint[];
} {
  const byDate = new Map<string, RegimeSnapshotRow>();
  for (const row of eqSnapshotToRows(snap)) byDate.set(row.date, row);
  const chronological = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const full = chronological.map((r) => rowToSnapshot(toDbRow(r)));
  const latest = full.length ? full[full.length - 1] : null;
  // Same forHistory projection the live endpoint applies (issue #866a) — the
  // parity this file's header promises, shared by construction.
  return { latest, history: full.map(forHistory) };
}

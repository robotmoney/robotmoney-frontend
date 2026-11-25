// The stored regime row shape and the canonical JSON it is written with
// (issue 1751). Pure: the backend hashes and stores the bytes these return.

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
  panelWeights?: Record<string, Record<string, number> | string | null> | null;
  version?: string | null;
  // Row-level provenance (issue #397): which data source wrote this row —
  // 'live' | 'hermetic' | 'fixture' | 'seed' going forward; `null`/undefined
  // on every pre-migration row (genuinely unknown, never fabricated).
  source?: string | null;
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

// Deterministic JSON: every object's keys sorted, recursively. The ONLY
// mechanism that makes canonicalization independent of input array order is
// sorting the ARRAY of members before this is ever called (see
// sortedMembers/buildVintageManifest in the backend's run-ledger.ts) — this
// function alone only guarantees key order within one object.
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  // A Date has to be a LEAF, checked before the generic object branch below:
  // Object.keys() on a Date instance is always [] (its instant lives in an
  // internal slot, not an enumerable own property), so recursing into it the
  // same way as a plain object silently rebuilds it as `{}` — discarding the
  // date entirely rather than canonicalizing it. Plain JSON.stringify never
  // has this problem (it calls Date.prototype.toJSON() before this function
  // ever runs), so anything that round-trips through an ORDINARY jsonb write
  // (postgres.js's .json(), used by every compatibility-table writer in this
  // repo) serializes a Date correctly while a naive canonicalStringify of the
  // exact same object silently zeroed it — found via issue #979's dual-write
  // parity check on a real published swarm brief (its embedded
  // `regime.date` is a raw Postgres Date).
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// The canonical bytes for one artifact kind. Deterministic key order
// (canonicalStringify, shared with the #977 run ledger) so the same logical
// content always produces the same bytes regardless of how the caller built
// the array in memory.
export function canonicalArtifactBytes(rows: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(rows));
}

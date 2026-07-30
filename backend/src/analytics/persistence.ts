// The analytics persistence PORT (issue #106). The orchestrator/updater stages
// (fetch → compute) never touch SQL: every read/write of the analytics data
// tables (raw_indicator_history, regime_snapshots, research_signals) goes
// through this interface. Two implementations exist:
//
//   • analytics/api-client.ts — the independent producer's HTTP client: typed
//     calls to the authenticated /api/analytics/* boundary with its scoped
//     bearer credential.
//   • analytics/store/direct.ts — the API-owned domain service backed by the
//     SQL store writers. ONLY the API process (and migration/demo tooling with
//     its own DB credentials) may use it.
//
// Pure types — no I/O, no SQL, no config.
import type { RawIndicatorHistory } from "./types.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import type { ResearchPayload } from "./analyze/research.ts";

export interface FloorSeedResult {
  seededPoints: number; // rows actually written this run (gap-fill only)
  existingPoints: number; // rows already present (skipped — DB floor wins)
  indicators: number; // distinct indicators touched by the seed
}

export interface AnalyticsPersistence {
  // Read the whole persisted raw floor, grouped by indicator, sorted by date.
  loadRawHistory(): Promise<RawIndicatorHistory>;
  // Upsert merged raw history on (date, indicator); fetched wins on overlap.
  saveRawHistory(byIndicator: RawIndicatorHistory): Promise<void>;
  // Cold-DB gap-fill: write only (date, indicator) points NOT already persisted
  // (existing rows always win). Idempotent — a warm floor makes this a no-op.
  seedRawHistory(byIndicator: RawIndicatorHistory): Promise<FloorSeedResult>;
  // Upsert regime snapshot rows on (date).
  saveRegimeSnapshots(rows: RegimeSnapshotRow[]): Promise<void>;
  // Upsert one research signal payload on (signal_key, date).
  saveResearchSignal(key: string, asof: string, payload: ResearchPayload): Promise<void>;
}

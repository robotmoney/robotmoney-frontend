// Store stage: the server-side GAP-FILL write for raw-floor seed ingestion
// (issues #13/#106). Given an already-parsed seed (the vendored floor, or the
// EDGAR seed a follow-up submits through POST /api/analytics/raw-history/seed),
// write ONLY the (date, indicator) points not already persisted. Existing rows
// are never overwritten (the DB floor wins on overlap → the honest append-only
// semantics of mergeSeries), which makes seeding idempotent: a second run finds
// every date present, writes nothing, and is a no-op.
//
// API-OWNED (issue #106): only the API process and migration/smoke tooling may
// import this module; updaters submit seeds through the AnalyticsPersistence
// port. File PARSING of the vendored seed lives in extract/floor-seed.ts (pure).
import { sql, type DbHandle } from "../../db/client.ts";
import {
  loadRawIndicatorHistory,
  saveRawIndicatorHistory,
} from "./raw-history-store.ts";
import type { RawIndicatorHistory } from "../types.ts";
import type { FloorSeedResult } from "../persistence.ts";
export type { FloorSeedResult };

export async function applyRawFloorSeed(
  seed: RawIndicatorHistory,
  db: DbHandle = sql,
): Promise<FloorSeedResult> {
  const existing = await loadRawIndicatorHistory(db);

  const toWrite: RawIndicatorHistory = {};
  let seededPoints = 0;
  let existingPoints = 0;
  for (const [id, pts] of Object.entries(seed)) {
    const have = new Set((existing[id] ?? []).map((p) => p.date));
    const missing = pts.filter((p) => !have.has(p.date));
    existingPoints += pts.length - missing.length;
    if (missing.length) {
      toWrite[id] = missing;
      seededPoints += missing.length;
    }
  }

  // Tag every gap-fill row 'seed' (issue #397): this is vendored real history,
  // not a fresh live/hermetic/fixture fetch from THIS run.
  await saveRawIndicatorHistory(toWrite, db, "seed");
  return { seededPoints, existingPoints, indicators: Object.keys(toWrite).length };
}

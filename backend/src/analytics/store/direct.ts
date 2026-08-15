// Direct (SQL-backed) implementation of the AnalyticsPersistence port (issue
// #106) — the API-owned domain service over the store writers. ONLY the API
// process (its /api/analytics + swarm regime routes), tests, and demo/e2e
// tooling that already holds DB credentials may use this; updater/worker
// processes use analytics/api-client.ts instead. Enforced by
// tests/analytics-api-boundary.test.ts.
import { sql } from "../../db/client.ts";
import type { AnalyticsPersistence } from "../persistence.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "./raw-history-store.ts";
import { applyRawFloorSeed } from "./floor-seed.ts";
import { saveRegimeSnapshots } from "./regime-store.ts";
import { persistResearchSignal, loadRecentResearchSignalDates } from "./research-store.ts";

export const directAnalyticsPersistence: AnalyticsPersistence = {
  loadRawHistory: () => loadRawIndicatorHistory(),
  saveRawHistory: (byIndicator, source) => saveRawIndicatorHistory(byIndicator, undefined, source),
  // Gap-fill inside one transaction so a mid-seed failure never leaves a
  // partially-seeded floor.
  seedRawHistory: (byIndicator) => sql.begin((tx) => applyRawFloorSeed(byIndicator, tx)),
  saveRegimeSnapshots: (rows) => saveRegimeSnapshots(rows),
  saveResearchSignal: (key, asof, payload) => persistResearchSignal(key, asof, payload),
  loadResearchSignalDates: (sinceDate) => loadRecentResearchSignalDates(sinceDate),
};

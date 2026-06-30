// Thin HTTP adapters for the dashboard surfaces. All query + DTO logic lives in
// the analytics report stage (analytics/report/projections.ts); these handlers
// only parse/clamp request params and forward. API paths, DTOs, and response
// shapes are unchanged.
import { fetchRegimeSnapshots, fetchLatestResearchSignal } from "../../analytics/report/projections.ts";

// GET /api/dashboards/research-signals/:key → latest research signal payload
export async function getResearchSignal(key: string) {
  return fetchLatestResearchSignal(key);
}

// GET /api/dashboards/regime-snapshots?range=<n days> → { latest, history }
export async function getRegimeSnapshots(url: URL) {
  const n = Math.trunc(Number(url.searchParams.get("range") ?? 180));
  const range = Number.isFinite(n) ? Math.min(3650, Math.max(1, n)) : 180;
  return fetchRegimeSnapshots(range);
}

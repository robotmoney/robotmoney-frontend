// EDGAR/MNA seed loader + offline repopulation client (issue #108). Both
// operations only ever talk to the authenticated analytics HTTP boundary
// (issue #106) — NEVER db/client.ts, db/worker-client.ts, or an analytics
// store writer (enforced by tests/analytics-api-boundary.test.ts, which scans
// this whole directory minus store/ and report/).
//
//   bootstrapEdgarSeed        — load the committed artifact + ingest it via
//                               POST /api/analytics/raw-history/seed (the
//                               #106 server-side gap-fill: existing real rows
//                               always win, a second run is a no-op).
//   enableResearchEligibility — flip job_schedules.research.refresh to
//                               enabled via POST
//                               /api/analytics/research-eligibility. Called
//                               ONLY after bootstrapEdgarSeed resolves, so a
//                               fresh boot's research schedule never becomes
//                               claimable before the floor is seeded.
//   repopulateEdgarSeed       — an operator-run offline repopulation client:
//                               diff the committed artifact against whatever
//                               is currently persisted, ingest through the
//                               SAME seed endpoint (still existing-wins), and
//                               report how many points were newly seeded,
//                               already present with the same value, or
//                               already present with a DIFFERENT (real) value
//                               that was correctly left standing.
import { ROUTES } from "@robotmoney/contract";
import { resolveAnalyticsApiConfig, analyticsApiClient, type AnalyticsApiConfig } from "./api-client.ts";
import { loadEdgarSeed, EDGAR_SEED_INDICATOR } from "./extract/edgar-seed.ts";
import type { FloorSeedResult } from "./persistence.ts";

export async function bootstrapEdgarSeed(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<FloorSeedResult> {
  const { history } = await loadEdgarSeed();
  return analyticsApiClient(cfg).seedRawHistory(history);
}

// Fail-loud: any non-2xx (401/403 missing or wrong ANALYTICS_TOKEN, or any
// other server error) throws — the caller (the demo/live bootstrap CLI) must
// never enable the research schedule on a rejected/uncertain ingestion.
export async function enableResearchEligibility(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetch(`${cfg.baseUrl}${ROUTES.analytics.researchEligibility}`, { method: "POST", headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `analytics API POST ${ROUTES.analytics.researchEligibility} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
    );
  }
}

export interface RepopulationReport {
  seeded: number; // rows the committed artifact restored (were missing)
  existing: number; // rows already present with the SAME value (no-op)
  rejected: number; // rows already present with a DIFFERENT (real) value — correctly left standing
}

export async function repopulateEdgarSeed(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<RepopulationReport> {
  const { history } = await loadEdgarSeed();
  const persistence = analyticsApiClient(cfg);
  const current = await persistence.loadRawHistory();

  let seeded = 0;
  let existing = 0;
  let rejected = 0;
  for (const [indicator, pts] of Object.entries(history)) {
    const have = new Map((current[indicator] ?? []).map((p) => [p.date, p.value] as const));
    for (const p of pts) {
      if (!have.has(p.date)) seeded++;
      else if (have.get(p.date) === p.value) existing++;
      else rejected++;
    }
  }

  // The actual write: still the server-owned gap-fill (existing rows always
  // win), so this call can never overwrite a real observation regardless of
  // the client-side diff above.
  await persistence.seedRawHistory(history);

  return { seeded, existing, rejected };
}

export { EDGAR_SEED_INDICATOR };

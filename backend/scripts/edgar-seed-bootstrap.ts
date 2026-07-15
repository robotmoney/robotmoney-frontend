// Demo/live-boot EDGAR/MNA seed gate (issue #108). Run ONCE after migrations
// and API readiness, BEFORE the research schedule may fire: loads the
// committed EDGAR seed artifact, ingests it through the authenticated
// analytics seed API (server-side gap-fill — existing real rows always win,
// a second run is a no-op), and ONLY on success flips
// job_schedules.research.refresh to enabled via the research-eligibility
// endpoint. A missing/invalid ANALYTICS_TOKEN — or any other ingestion
// failure — exits non-zero WITHOUT ever calling the eligibility endpoint
// (fail-closed: a boot that cannot prove the floor is seeded must never risk
// enabling a cold-DB research crawl).
//
// No SQL: this script only calls the authenticated HTTP boundary
// (analytics/api-client.ts + analytics/edgar-seed-loader.ts) — never
// db/client.ts, db/worker-client.ts, or an analytics store writer.
//
// Usage: ANALYTICS_API_URL=... ANALYTICS_TOKEN=... bun run scripts/edgar-seed-bootstrap.ts
import { resolveAnalyticsApiConfig } from "../src/analytics/api-client.ts";
import { bootstrapEdgarSeed, enableResearchEligibility } from "../src/analytics/edgar-seed-loader.ts";

export async function main(): Promise<void> {
  const cfg = resolveAnalyticsApiConfig();
  console.log(`[edgar-seed-bootstrap] loading + ingesting the committed EDGAR/MNA seed via ${cfg.baseUrl} ...`);
  const result = await bootstrapEdgarSeed(cfg);
  console.log(
    `[edgar-seed-bootstrap] ingested: seeded=${result.seededPoints} existing=${result.existingPoints} indicator(s)=${result.indicators}`,
  );
  console.log("[edgar-seed-bootstrap] enabling the research.refresh schedule...");
  await enableResearchEligibility(cfg);
  console.log("[edgar-seed-bootstrap] research schedule is now eligible — bootstrap complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(
      `[edgar-seed-bootstrap] FAILED (research schedule left disabled): ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
  });
}

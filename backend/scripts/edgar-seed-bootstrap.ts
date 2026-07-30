// Legacy-compatible EDGAR/MNA seed client (issue #108). Run after API readiness:
// loads the
// committed EDGAR seed artifact, ingests it through the authenticated
// analytics seed API (server-side gap-fill — existing real rows always win,
// a second run is a no-op). It never enables a consumer-DB schedule or enqueues
// research.refresh: D25 gives cadence and seed-time research execution to the
// independent analytics producer. A missing/invalid ANALYTICS_TOKEN — or any
// other ingestion failure — exits non-zero.
//
// No SQL: this script only calls the authenticated HTTP boundary
// (analytics/api-client.ts + analytics/edgar-seed-loader.ts) — never
// db/client.ts, db/worker-client.ts, or an analytics store writer.
//
// Usage: ANALYTICS_API_URL=... ANALYTICS_TOKEN=... bun run scripts/edgar-seed-bootstrap.ts
import { resolveAnalyticsApiConfig } from "../src/analytics/api-client.ts";
import { bootstrapEdgarSeed } from "../src/analytics/edgar-seed-loader.ts";

export async function main(): Promise<void> {
  const cfg = resolveAnalyticsApiConfig();
  console.log(`[edgar-seed-bootstrap] loading + ingesting the committed EDGAR/MNA seed via ${cfg.baseUrl} ...`);
  const result = await bootstrapEdgarSeed(cfg);
  console.log(
    `[edgar-seed-bootstrap] ingested: seeded=${result.seededPoints} existing=${result.existingPoints} indicator(s)=${result.indicators}`,
  );
  console.log("[edgar-seed-bootstrap] bootstrap complete; independent producer owns research execution.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(
      `[edgar-seed-bootstrap] FAILED (no research execution requested): ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
  });
}

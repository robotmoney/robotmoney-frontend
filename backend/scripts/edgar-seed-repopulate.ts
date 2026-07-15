// Offline EDGAR/MNA seed repopulation (issue #108). An operator-run command
// for a database that lost some (or all) of its persisted MNA history — it
// restores ONLY the missing rows from the committed seed artifact through the
// authenticated analytics API (the SAME server-side gap-fill the bootstrap
// step uses — existing real observations are NEVER overwritten) and reports
// how many points were newly seeded, already present with the same value, or
// already present with a different (real) value that was correctly left
// standing.
//
// No SQL: this script only calls the authenticated HTTP boundary
// (analytics/api-client.ts + analytics/edgar-seed-loader.ts).
//
// Usage: ANALYTICS_API_URL=... ANALYTICS_TOKEN=... bun run scripts/edgar-seed-repopulate.ts
import { resolveAnalyticsApiConfig } from "../src/analytics/api-client.ts";
import { repopulateEdgarSeed } from "../src/analytics/edgar-seed-loader.ts";

export async function main(): Promise<void> {
  const cfg = resolveAnalyticsApiConfig();
  const res = await repopulateEdgarSeed(cfg);
  console.log(
    `[edgar-seed-repopulate] seeded=${res.seeded} existing=${res.existing} rejected=${res.rejected} (rejected = artifact rows that disagreed with an already-persisted real value; the real value always wins)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[edgar-seed-repopulate] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}

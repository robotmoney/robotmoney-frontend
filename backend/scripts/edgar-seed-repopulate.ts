// Offline EDGAR/MNA seed repopulation (issue #108). An operator-run command
// for a database that lost some (or all) of its persisted MNA history — it
// restores ONLY the missing rows from the committed seed artifact through the
// authenticated analytics API (the SAME server-side gap-fill the bootstrap
// step uses — existing real observations are NEVER overwritten) and reports
// how many points were newly seeded, already present with the same value, or
// already present with a different (real) value that was correctly left
// standing.
//
// `--repair` (issue #509) switches to the REPAIR path instead: for a database
// whose MNA history was OVERWRITTEN rather than lost, the gap-fill above can
// restore nothing (every date is present, so every artifact row is
// "rejected"). `--repair` submits the artifact through the ordinary upsert so
// the archived baseline wins on overlap. Operator-only, never scheduled: it
// discards any genuine live revision that superseded the artifact.
//
// No SQL: this script only calls the authenticated HTTP boundary
// (analytics/api-client.ts + analytics/edgar-seed-loader.ts).
//
// Usage: ANALYTICS_API_URL=... ANALYTICS_TOKEN=... bun run scripts/edgar-seed-repopulate.ts [--repair]
import { resolveAnalyticsApiConfig } from "../src/analytics/api-client.ts";
import { repopulateEdgarSeed, repairEdgarSeed } from "../src/analytics/edgar-seed-loader.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cfg = resolveAnalyticsApiConfig();
  if (argv.includes("--repair")) {
    const res = await repairEdgarSeed(cfg);
    console.log(
      `[edgar-seed-repopulate] REPAIR: restored=${res.restored} unchanged=${res.unchanged} (restored = persisted rows that disagreed with the committed artifact and were overwritten back to it)`,
    );
    return;
  }
  const res = await repopulateEdgarSeed(cfg);
  console.log(
    `[edgar-seed-repopulate] seeded=${res.seeded} existing=${res.existing} rejected=${res.rejected} (rejected = artifact rows that disagreed with an already-persisted real value; the real value always wins — re-run with --repair to restore those from the artifact)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[edgar-seed-repopulate] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}

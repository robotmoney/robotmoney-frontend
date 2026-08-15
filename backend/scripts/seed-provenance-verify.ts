// One-time production verification/cleanup for the raw floor seed's
// provenance (issue #616 / D6). Checks every persisted source='seed' row in
// raw_indicator_history against its indicator's source-calendar (extract/
// floor-seed-calendar.ts) and reports any row dated on a day its source could
// never have published — the D6/D7 defect class the #616 full-universe purge
// regeneration eliminated from the committed vendored artifact. This script
// is the one-time PRODUCTION-side cleanup for a database that was seeded
// BEFORE that regeneration landed (applyRawFloorSeed's DB-rows-win gap fill
// means such rows are never overwritten by a later live fetch on their own).
//
// Exit-code contract:
//   0 — no calendar-invalid source='seed' rows found, or --clean removed all
//       of them
//   1 — calendar-invalid rows found and --clean was not passed
//
// Usage:
//   bun run scripts/seed-provenance-verify.ts           # report only
//   bun run scripts/seed-provenance-verify.ts --clean    # report + delete
import { verifySeedProvenance } from "../src/analytics/store/seed-provenance.ts";
import { sql, closeDb } from "../src/db/client.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const clean = argv.includes("--clean");
  const { invalid, deleted } = await verifySeedProvenance(sql, clean);

  if (invalid.length === 0) {
    console.log("[seed-provenance-verify] clean — no calendar-invalid source='seed' rows found");
    return 0;
  }

  console.error(`[seed-provenance-verify] found ${invalid.length} calendar-invalid source='seed' row(s):`);
  for (const row of invalid) {
    console.error(`  ${row.indicatorId} @ ${row.date} = ${row.value}`);
  }

  if (clean) {
    console.log(`[seed-provenance-verify] --clean: deleted ${deleted} row(s)`);
    return 0;
  }

  console.error("[seed-provenance-verify] re-run with --clean to delete these rows");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[seed-provenance-verify] FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}

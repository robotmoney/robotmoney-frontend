// Explicit LIVE EDGAR/MNA seed regeneration command (issue #108). The ONLY
// way the committed seed artifact + manifest are ever produced or replaced —
// NEVER implicit during migrations, smoke boot, or required per-PR CI (no
// other code path imports this file). An operator runs it deliberately,
// pinning the coverage range, then reviews and commits the result.
//
// Fetches live EDGAR full-text-search counts for every month in
// [--start, --end] (bounded — one request per month, each with its own
// retry/backoff from extract/edgar.ts's fetchEdgarMonthCount), REFUSES to
// write anything if even one month is unrecoverable (never a partial seed),
// and atomically replaces the committed artifact + manifest pair only after
// the freshly generated pair round-trips through the exact parse/validate
// path the loader uses.
//
// Usage:
//   bun run scripts/edgar-seed-regenerate.ts --end 2026-06-30 --asof 2026-07-01
//   bun run scripts/edgar-seed-regenerate.ts --start 2010-01-01 --end 2026-06-30 --asof 2026-07-01
//
// --start defaults to the declared January-2010 baseline (LATECYCLE_START).
// --end MUST be the last calendar day of a complete month. --asof MUST be a
// valid ISO date on/after --end's month (the pinned regeneration date).
import { DEFAULT_EDGAR_SEED_PATH, DEFAULT_EDGAR_SEED_MANIFEST_PATH } from "../src/analytics/extract/edgar-seed.ts";
import { generateEdgarSeedArtifact, replaceSeedArtifactAtomically } from "../src/analytics/extract/edgar-seed-generator.ts";

const LATECYCLE_START = "2010-01-01"; // matches analytics/access/data-source.ts's LATECYCLE_START

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  const startIso = arg("start") ?? LATECYCLE_START;
  const endIso = arg("end");
  const asOf = arg("asof");
  if (!endIso || !asOf) {
    console.error(
      "usage: bun run scripts/edgar-seed-regenerate.ts --end <YYYY-MM-DD, last day of a complete month> --asof <YYYY-MM-DD> [--start YYYY-MM-DD]",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[edgar-seed-regenerate] fetching live EDGAR S-4 monthly counts ${startIso} .. ${endIso} (asOf ${asOf})...`);
  const generated = await generateEdgarSeedArtifact({ startIso, endIso, asOf });
  console.log(
    `[edgar-seed-regenerate] fetched ${generated.rows.length} month(s); checksum=${generated.manifest.checksum}`,
  );

  const outPath = arg("out") ?? DEFAULT_EDGAR_SEED_PATH;
  const manifestOutPath = arg("manifest-out") ?? DEFAULT_EDGAR_SEED_MANIFEST_PATH;
  replaceSeedArtifactAtomically(outPath, manifestOutPath, generated);
  console.log(`[edgar-seed-regenerate] wrote ${outPath} + ${manifestOutPath} (atomic replace, prior pair untouched on any failure)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[edgar-seed-regenerate] FAILED (committed artifact untouched): ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}

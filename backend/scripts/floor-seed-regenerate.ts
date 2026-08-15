// Explicit LIVE floor-seed regeneration command (issue #400). An operator
// runs this deliberately to add/refresh ONE registry indicator's real history
// in the committed vendored floor (backend/tests/fixtures/regime/raw-indicator-
// history.csv.gz), merged additively (append-only — fetched wins on overlap)
// against whatever is already committed, then reviews and commits the result.
// Never implicit during migrations, demo boot, or required per-PR CI (no
// other code path imports floor-seed-generator.ts).
//
// Usage (regenerate BTC_MVRV from Coinmetrics — the default; #127 repointed
// the live fetcher here after blockchain.com's mvrv chart 404'd):
//   bun run scripts/floor-seed-regenerate.ts --indicator BTC_MVRV --asset btc --metric CapMVRVCur
//
// By default the fetched history is capped to the existing floor's own max
// date across every OTHER indicator (so one indicator's regeneration never
// silently drags the vendored asof coverage forward — bumping every
// indicator's vintage together is a separate, independently reviewed change).
// Pass --max-date to override, or --no-cap to keep every fetched row.
//
// `--purge` (issue #616): a SEPARATE, explicitly-invoked full-universe purge
// regeneration mode that rebuilds the ENTIRE committed floor from this repo's
// own live fetchers (extract/sources.ts fetchAll) — purging every recoverable
// indicator's prior history and preserving (calendar-filtered) only the
// unrecoverable spans. See floor-seed-generator.ts's generateFullUniversePurge
// header for the preserve-list rationale. Removes the D6/D7 fabricated rows
// (docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md)
// the additive path above cannot reach (it only ever adds).
import { fetchCoinmetrics } from "../src/analytics/extract/coinmetrics.ts";
import { fetchAll } from "../src/analytics/extract/sources.ts";
import {
  generateFloorSeedArtifact,
  generateFullUniversePurge,
  replaceFloorSeedAtomically,
  UNRECOVERABLE_PRESERVE_IDS,
} from "../src/analytics/extract/floor-seed-generator.ts";
import { DEFAULT_FLOOR_SEED_PATH } from "../src/analytics/extract/floor-seed.ts";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export async function main(): Promise<void> {
  const seedPath = arg("out") ?? DEFAULT_FLOOR_SEED_PATH;

  if (flag("purge")) {
    console.log(
      `[floor-seed-regenerate] PURGE mode: rebuilding the FULL registry from live sources only ` +
        `(preserve-list: ${UNRECOVERABLE_PRESERVE_IDS.join(", ")})...`,
    );
    const purged = await generateFullUniversePurge({ fetchAll: () => fetchAll(), seedPath });
    for (const [id, c] of Object.entries(purged.perIndicator)) {
      console.log(`  ${id.padEnd(14)} fetched=${String(c.fetched).padStart(6)} preserved=${String(c.preserved).padStart(6)} total=${String(c.total).padStart(6)}`);
    }
    replaceFloorSeedAtomically(seedPath, { gz: purged.gz });
    console.log(`[floor-seed-regenerate] wrote ${seedPath} (full-universe purge, atomic replace, prior file untouched on any failure)`);
    return;
  }

  const indicatorId = arg("indicator") ?? "BTC_MVRV";
  const asset = arg("asset") ?? "btc";
  const metric = arg("metric") ?? "CapMVRVCur";
  const start = arg("start") ?? "2018-01-01";
  const maxDate = flag("no-cap") ? undefined : arg("max-date");

  console.log(
    `[floor-seed-regenerate] fetching live ${indicatorId} (coinmetrics ${asset}/${metric}, start=${start})...`,
  );
  const generated = await generateFloorSeedArtifact({
    indicatorId,
    fetch: () => fetchCoinmetrics(asset, metric, start),
    maxDate,
    seedPath,
  });
  console.log(
    `[floor-seed-regenerate] merged ${generated.addedPoints} new ${indicatorId} row(s) into the committed floor (capped at ${generated.cappedAt || "no cap"})`,
  );

  replaceFloorSeedAtomically(seedPath, generated);
  console.log(`[floor-seed-regenerate] wrote ${seedPath} (atomic replace, prior file untouched on any failure)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[floor-seed-regenerate] FAILED (committed artifact untouched): ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}

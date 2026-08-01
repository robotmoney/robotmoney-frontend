// Extract stage: regenerate the vendored raw-indicator floor seed
// (raw-indicator-history.csv.gz) with LIVE data for one indicator, merged
// additively (append-only mergeSeries — fetched wins on any overlap) into the
// existing committed floor. Pure orchestration + atomic filesystem replace —
// no SQL, no analytics store writer, no demo/bootstrap wiring. Used ONLY by
// the explicit `backend/scripts/floor-seed-regenerate.ts` operator command —
// never implicitly by migrations, demo boot, or required per-PR CI. Mirrors
// the edgar-seed-generator.ts convention for the EDGAR/MNA seed (issue #108).
import { gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mergeSeries } from "../transform/math.ts";
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "./floor-seed.ts";
import type { Point, RawIndicatorHistory } from "../types.ts";

export interface RegenerateFloorSeedOptions {
  indicatorId: string; // e.g. "BTC_MVRV"
  // Injectable — tests supply deterministic mocked responses instead of a
  // real network fetch.
  fetch: (indicatorId: string) => Promise<Point[]>;
  // Cap fetched observations to <= this date. Defaults to the existing
  // floor's own max date across every OTHER indicator, so a routine
  // regeneration never silently extends the vendored asof coverage — that
  // is a separate, independently reviewed change (bumping every indicator's
  // vintage together).
  maxDate?: string;
  seedPath?: string;
}

export interface GeneratedFloorSeed {
  merged: RawIndicatorHistory;
  gz: Buffer;
  addedPoints: number;
  indicatorId: string;
  cappedAt: string;
}

function existingMaxDate(floor: RawIndicatorHistory, excludeId: string): string {
  let max = "";
  for (const id in floor) {
    if (id === excludeId) continue;
    const rows = floor[id];
    if (rows.length && rows[rows.length - 1].date > max) max = rows[rows.length - 1].date;
  }
  return max;
}

// Serialize the FULL merged floor back to the committed `date,indicator,value`
// CSV shape. Row order is date-major (ascending); every loader (production
// extract/floor-seed.ts AND the test fixture loader) rebuilds per-indicator
// arrays and re-sorts them by date, so cross-indicator ordering within a date
// is not semantically significant — kept stable/deterministic anyway so diffs
// stay readable.
function toCsv(floor: RawIndicatorHistory): string {
  const byDate = new Map<string, { id: string; value: number }[]>();
  for (const id of Object.keys(floor)) {
    for (const p of floor[id]) {
      if (!byDate.has(p.date)) byDate.set(p.date, []);
      byDate.get(p.date)!.push({ id, value: p.value });
    }
  }
  const lines = ["date,indicator,value"];
  for (const date of [...byDate.keys()].sort()) {
    for (const { id, value } of byDate.get(date)!) lines.push(`${date},${id},${value}`);
  }
  return lines.join("\n") + "\n";
}

// Fetch → cap → additive merge → gzip. Throws loudly if the fetch yields
// nothing usable — a regeneration that silently no-ops would be a
// silent-skip.
export async function generateFloorSeedArtifact(opts: RegenerateFloorSeedOptions): Promise<GeneratedFloorSeed> {
  const seedPath = opts.seedPath ?? DEFAULT_FLOOR_SEED_PATH;
  const floor = await loadRawFloorSeed(seedPath);
  const prior = floor[opts.indicatorId] ?? [];
  const fetchedAll = await opts.fetch(opts.indicatorId);
  const cap = opts.maxDate ?? existingMaxDate(floor, opts.indicatorId);
  const fetched = cap ? fetchedAll.filter((p) => p.date <= cap) : fetchedAll;
  if (fetched.length === 0) {
    throw new Error(
      `floor-seed-regenerate: fetch for ${opts.indicatorId} returned 0 usable row(s) (cap<=${cap || "none"}) — refusing to write an empty regeneration`,
    );
  }
  const mergedSeries = mergeSeries(prior, fetched);
  const merged: RawIndicatorHistory = { ...floor, [opts.indicatorId]: mergedSeries };
  const gz = gzipSync(Buffer.from(toCsv(merged), "utf8"));
  return { merged, gz, addedPoints: mergedSeries.length - prior.length, indicatorId: opts.indicatorId, cappedAt: cap };
}

// Atomically replace the committed artifact: write to a temp file, round-trip
// it through the exact production parser, THEN rename into place. If
// anything fails before the rename, the ORIGINAL committed file is left
// completely untouched.
export function replaceFloorSeedAtomically(seedPath: string, generated: GeneratedFloorSeed): void {
  mkdirSync(dirname(seedPath), { recursive: true });
  const tmp = `${seedPath}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(tmp, generated.gz);
    const text = gunzipSync(readFileSync(tmp)).toString("utf8");
    if (!text.startsWith("date,indicator,value")) {
      throw new Error("floor-seed-regenerate: round-tripped file failed the header self-check");
    }
    renameSync(tmp, seedPath);
  } finally {
    try { unlinkSync(tmp); } catch { /* already renamed, or never written */ }
  }
}

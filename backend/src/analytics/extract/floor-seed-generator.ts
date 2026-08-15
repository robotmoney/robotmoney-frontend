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
import { INDICATORS } from "../analyze/indicators.ts";
import { filterCalendarValid, validateFloorCalendar } from "./floor-seed-calendar.ts";
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
export function replaceFloorSeedAtomically(seedPath: string, generated: { gz: Buffer }): void {
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

// ── Full-universe purge mode (issue #616 / D6) ──────────────────────────────
//
// The additive path above only ADDS one indicator's history over whatever is
// already committed — it cannot remove the D6/D7 fabricated rows the vendored
// floor inherited from v0's dense forward-fill CSV (docs/code-review/
// 20260814-review-data-integrity-macro-index-discrepancy.md). This mode
// rebuilds the WHOLE registry from this repo's own live fetchers
// (extract/sources.ts fetchAll): every indicator NOT in the preserve list is
// fully purged — only freshly fetched rows survive — and every indicator IN
// the preserve list keeps its existing rows, filtered to calendar-valid dates
// only, merged with the live fetch (fetched wins on overlap, the same honest
// mergeSeries semantics the additive path uses).
//
// Preserve list (unrecoverable spans — a live fetch alone cannot rebuild
// them):
//   - HY_OAS: FRED serves BAMLH0A0HYM2 only as a trailing ~3y window
//     regardless of the `cosd` start-date override (D7) — pre-window history
//     exists only in the persisted floor.
//   - NEW_TOKENS: GeckoTerminal exposes only the live 24h firehose, no bulk-
//     history endpoint — the accumulated daily series exists only because
//     every past run appended one more point.
//   - BTC_ACTIVE: blockchain.com's n-unique-addresses chart's live coverage
//     does not reliably extend as far back as the accumulated floor.
//   - SHILLER_CAPE: the primary (multpl) and fallback (datahub) live sources
//     are not guaranteed to reproduce the floor's full monthly history.
export const UNRECOVERABLE_PRESERVE_IDS: readonly string[] = ["HY_OAS", "NEW_TOKENS", "BTC_ACTIVE", "SHILLER_CAPE"];

export interface PurgeOptions {
  // Injectable — tests supply deterministic mocked responses instead of a
  // real network fetch. Production passes extract/sources.ts's fetchAll.
  fetchAll: () => Promise<Record<string, Point[]>>;
  seedPath?: string;
  indicatorIds?: string[]; // defaults to the full registry (analyze/indicators.ts)
  preserveIds?: readonly string[]; // defaults to UNRECOVERABLE_PRESERVE_IDS
}

export interface PurgedFloorSeed {
  merged: RawIndicatorHistory;
  gz: Buffer;
  perIndicator: Record<string, { fetched: number; preserved: number; total: number }>;
}

// Rebuild the full raw-indicator floor from live sources only, purging every
// recoverable indicator's prior history and preserving (calendar-filtered)
// the unrecoverable spans. Throws loudly — never a silent no-op — if a
// recoverable indicator's live fetch returns 0 usable rows (that would delete
// its entire history), or if any calendar-invalid row survives into the
// merged result.
export async function generateFullUniversePurge(opts: PurgeOptions): Promise<PurgedFloorSeed> {
  const seedPath = opts.seedPath ?? DEFAULT_FLOOR_SEED_PATH;
  const existing = await loadRawFloorSeed(seedPath);
  const fetched = await opts.fetchAll();
  const ids = opts.indicatorIds ?? INDICATORS.map((i) => i.id);
  const preserveIds = new Set(opts.preserveIds ?? UNRECOVERABLE_PRESERVE_IDS);

  const merged: RawIndicatorHistory = {};
  const perIndicator: PurgedFloorSeed["perIndicator"] = {};
  for (const id of ids) {
    const fetchedRows = fetched[id] ?? [];
    const isPreserved = preserveIds.has(id);
    if (!isPreserved && fetchedRows.length === 0) {
      throw new Error(
        `floor-seed-regenerate --purge: fetch for recoverable indicator ${id} returned 0 rows — refusing a purge that would delete its entire history`,
      );
    }
    const preserved = isPreserved ? filterCalendarValid(id, existing[id] ?? []) : [];
    const combined = mergeSeries(preserved, filterCalendarValid(id, fetchedRows));
    merged[id] = combined;
    perIndicator[id] = { fetched: fetchedRows.length, preserved: preserved.length, total: combined.length };
  }

  const violations = validateFloorCalendar(merged);
  if (violations.length > 0) {
    throw new Error(
      `floor-seed-regenerate --purge: ${violations.length} calendar-invalid row(s) survived filtering ` +
        `(e.g. ${JSON.stringify(violations[0])}) — refusing to write`,
    );
  }

  const gz = gzipSync(Buffer.from(toCsv(merged), "utf8"));
  return { merged, gz, perIndicator };
}

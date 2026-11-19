// Extract stage: regenerate the vendored raw-indicator floor seed
// (raw-indicator-history.csv.gz) with LIVE data for one indicator, merged
// additively (append-only mergeSeries — fetched wins on any overlap) into the
// existing committed floor. Pure orchestration + atomic filesystem replace —
// no SQL, no analytics store writer, no smoke/bootstrap wiring. Used ONLY by
// the explicit `backend/scripts/floor-seed-regenerate.ts` operator command —
// never implicitly by migrations, smoke boot, or required per-PR CI. Mirrors
// the edgar-seed-generator.ts convention for the EDGAR/MNA seed (issue #108).
import { gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mergeSeries } from "../transform/math.ts";
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "./floor-seed.ts";
import { collectionRegistry } from "../../../../packages/analyst-sdk/src/extract/collected-series.ts";
import { RATIO_IDS, RATIO_LEG_KEYS } from "../extras.ts";
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

// The committed CSV with one indicator's rows replaced by `series` (issue
// 1653). Every other line is kept byte for byte, in its order: the new rows
// are merged in date-major, after the lines already on their date. So a
// one-indicator regeneration never rewrites another series' values.
function spliceCsv(text: string, indicatorId: string, series: Point[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const kept = lines.slice(1).filter((l) => l.split(",")[1] !== indicatorId);
  const added = [...series].sort((a, b) => a.date.localeCompare(b.date)).map((p) => `${p.date},${indicatorId},${p.value}`);
  const out = [lines[0]!];
  let k = 0;
  for (const line of added) {
    const date = line.slice(0, 10);
    while (k < kept.length && kept[k]!.slice(0, 10) <= date) out.push(kept[k++]!);
    out.push(line);
  }
  while (k < kept.length) out.push(kept[k++]!);
  return out.join("\n") + "\n";
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
  const text = gunzipSync(readFileSync(seedPath)).toString("utf8");
  const gz = gzipSync(Buffer.from(spliceCsv(text, opts.indicatorId, mergedSeries), "utf8"));
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
//     regardless of the `cosd` start-date override — pre-window history exists
//     only in the persisted floor. Verified directly (not merely asserted):
//     the above review's finding D7 (§14.4) hit the anonymous
//     fredgraph.csv?id=BAMLH0A0HYM2&cosd=2010-01-01 endpoint and got rows
//     starting 2023-08-15 (787 observations), not 2010. [That D-number is
//     THIS review doc's own finding numbering, unrelated to docs/decisions.md's
//     D-series — issue #634.] Re-verify anytime the truncation window is in
//     question: `RUN_LIVE_FETCHERS=1 bun test backend/tests/fetchers-live.test.ts`
//     hits the real endpoint; backend/tests/api/regime-fetchers.test.ts pins the
//     documented behavior with a mocked response and proves the merge below
//     still recovers pre-window history from the committed floor.
//   - NEW_TOKENS: GeckoTerminal exposes only the live 24h firehose, no bulk-
//     history endpoint — the accumulated daily series exists only because
//     every past run appended one more point.
//   - BTC_ACTIVE: blockchain.com's n-unique-addresses chart's live coverage
//     does not reliably extend as far back as the accumulated floor.
//   - SHILLER_CAPE: the primary (multpl) and fallback (datahub) live sources
//     are not guaranteed to reproduce the floor's full monthly history.
//   - The eight Yahoo ratios (issue 1644): the stored ratio rows are the
//     frozen historical record the fixtures, goldens and originals comparisons
//     read, so they are kept exactly and never refetched (a fresh download
//     cannot reproduce them: an adjusted close moves on every later
//     dividend). Their 28 legs (`yahoo:<SYMBOL>.close`, `.adjclose`) are
//     recoverable and refetched like any series.
//   - BAA10Y (issue 1653): the daily fetch requests FRED's default cosd of
//     2010-01-01, so a live fetch never returns the 1986-2009 rows the
//     committed floor holds. They came from the one-off FRED backfill below.
export const UNRECOVERABLE_PRESERVE_IDS: readonly string[] = ["HY_OAS", "NEW_TOKENS", "BTC_ACTIVE", "SHILLER_CAPE", ...RATIO_IDS, "BAA10Y"];

export interface PurgeOptions {
  // Injectable — tests supply deterministic mocked responses instead of a
  // real network fetch. Production passes extract/sources.ts's fetchAll.
  fetchAll: () => Promise<Record<string, Point[]>>;
  seedPath?: string;
  indicatorIds?: string[]; // defaults to every collected id (collectionRegistry(), issue 1653)
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
  const ids = opts.indicatorIds ?? [...collectionRegistry().map((i) => i.id), ...RATIO_LEG_KEYS];
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

// ── FRED backfill (issue 1653, D74 amendment) ───────────────────────────────
//
// Adds one FRED series' full history to the committed floor. Each date takes
// its ALFRED first-release value where ALFRED holds a vintage of it, and
// FRED's current value elsewhere. Only that series' rows change; every other
// row of the floor stays byte-identical (spliceCsv). The rows reach a store
// through the gap-filling seed ingestion, as 'seed' versions stamped with the
// ingestion's own knowledge_time: a backfill is learned now, never in the past.

/** FRED's current values, each replaced by its first-release value where one exists; dates of both. Sorted. */
export function resolveFirstRelease(current: readonly Point[], firstRelease: readonly Point[]): Point[] {
  const byDate = new Map<string, number>();
  for (const p of current) byDate.set(p.date, p.value);
  for (const p of firstRelease) byDate.set(p.date, p.value);
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export interface FredBackfillOptions {
  indicatorId: string;
  // FRED's current values, from the series' first observation.
  fetchCurrent: () => Promise<Point[]>;
  // ALFRED first-release values (extract/fred.ts fetchAlfredFirstRelease).
  fetchFirstRelease: () => Promise<Point[]>;
  maxDate?: string;
  seedPath?: string;
}

export async function generateFredBackfill(opts: FredBackfillOptions): Promise<GeneratedFloorSeed & { firstRelease: number }> {
  const [current, firstRelease] = await Promise.all([opts.fetchCurrent(), opts.fetchFirstRelease()]);
  const resolved = filterCalendarValid(opts.indicatorId, resolveFirstRelease(current, firstRelease));
  const generated = await generateFloorSeedArtifact({ indicatorId: opts.indicatorId, fetch: async () => resolved, maxDate: opts.maxDate, seedPath: opts.seedPath });
  return { ...generated, firstRelease: firstRelease.length };
}

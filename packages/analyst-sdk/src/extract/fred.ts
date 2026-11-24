// Extract stage: FRED (St. Louis Fed) source client — KEYLESS.
// Ported from agentjuno/robotmoney scripts/regime/fetchers/fred.js.
//
// Uses the public CSV download endpoint (no API key required):
//   https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES>&cosd=<YYYY-MM-DD>
//
// The `cosd` (change-of-start-date) parameter forces FRED to serve from the
// requested start rather than its default ~3y window (some series silently
// truncate otherwise). We pin to 2010-01-01 — well before our 2018 backfill —
// so the whole window always comes back; append-only merge preserves older.
// `cosd` does not widen BAMLH0A0HYM2 (HY_OAS): since April 2026 FRED serves
// that series as a trailing 3-year window whatever the start date, and ALFRED
// holds no older vintage (issue 1653). Its older rows exist only in the stored
// floor, which keeps every row as the window moves.
//
// FRED publishes missing days as "." → NaN (dropped); consumers forward-fill.
// Day boundary (issue 1733, finding E5): FRED dates are period dates, kept as
// served. The day a value is known is the indicator's publication rule
// (transform/knowledge-time.ts), not this date.
import type { Point } from "../types.ts";
import { fetchText } from "./http.ts";

const BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const COSD = "2010-01-01";

export const fredUrl = (seriesId: string, start = COSD) =>
  `${BASE}?id=${encodeURIComponent(seriesId)}&cosd=${start}`;

// Parse FRED's two-column CSV (DATE,VALUE). "." (missing) rows are dropped.
// FRED answers its maintenance page as HTTP 200 HTML (issue #1413), so a body
// whose first line is not a two-column `DATE|observation_date,<column>` header
// throws, and a row is kept only with an ISO YYYY-MM-DD date and a finite value.
const HEADER = /^(date|observation_date),[^,<>\s]+$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFredCsv(text: string, seriesId: string): Point[] {
  const lines = text.trim().split("\n");
  if (lines[0] === "") return [];
  if (!HEADER.test(lines[0].trim())) throw new Error(`FRED ${seriesId}: response is not CSV`);
  const out: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(",");
    if (comma < 0) continue;
    const date = lines[i].slice(0, comma).trim();
    if (!ISO_DATE.test(date)) continue;
    const v = parseFloat(lines[i].slice(comma + 1));
    if (!Number.isFinite(v)) continue; // FRED uses "." for missing
    out.push({ date, value: v });
  }
  return out;
}

// `start` moves `cosd` for a caller that wants another window (the supplementary
// fetch); the collectors keep the 2010-01-01 default.
export async function fetchFred(seriesId: string, timeoutMs = 15000, start = COSD): Promise<Point[]> {
  const text = await fetchText(fredUrl(seriesId, start), timeoutMs);
  return parseFredCsv(text, seriesId);
}

// ── ALFRED first-release values (issue 1653, D74 backfill rule) ─────────────
// ALFRED serves a past vintage of a FRED series as the same two-column CSV, and
// several vintages side by side in one request: `id`, `vintage_date` and
// `cosd` each take a comma-separated list, one entry per column. A requested
// vintage date that is not itself a vintage answers the vintage in effect on
// that date. The column header names the requested date (`<SERIES>_YYYYMMDD`).
const ALFRED_BASE = "https://alfred.stlouisfed.org/graph/alfredgraph.csv";

export interface AlfredVintage {
  // The requested vintage date (YYYY-MM-DD): the values known on that day.
  vintage: string;
  points: Point[];
}

export function alfredUrl(seriesId: string, vintages: readonly string[], starts: readonly string[]): string {
  if (vintages.length === 0 || vintages.length !== starts.length) throw new Error("alfredUrl: one start per vintage");
  const id = encodeURIComponent(seriesId);
  return `${ALFRED_BASE}?id=${vintages.map(() => id).join(",")}&vintage_date=${vintages.join(",")}&cosd=${starts.join(",")}`;
}

const ALFRED_COLUMN = /^(.+)_(\d{4})(\d{2})(\d{2})$/;

// Parse ALFRED's multi-column CSV into one vintage per column. An empty cell
// is a date that vintage does not hold.
export function parseAlfredCsv(text: string, seriesId: string): AlfredVintage[] {
  const lines = text.trim().split("\n");
  const header = lines[0]?.trim().split(",") ?? [];
  if (!/^(date|observation_date)$/i.test(header[0] ?? "") || header.length < 2) throw new Error(`ALFRED ${seriesId}: response is not CSV`);
  const out: AlfredVintage[] = header.slice(1).map((col) => {
    const m = ALFRED_COLUMN.exec(col.trim());
    if (!m) throw new Error(`ALFRED ${seriesId}: column ${JSON.stringify(col)} names no vintage`);
    return { vintage: `${m[2]}-${m[3]}-${m[4]}`, points: [] };
  });
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const date = cells[0]!.trim();
    if (!ISO_DATE.test(date)) continue;
    for (let k = 0; k < out.length; k++) {
      const cell = (cells[k + 1] ?? "").trim();
      if (cell === "" || cell === ".") continue;
      const v = parseFloat(cell);
      if (Number.isFinite(v)) out[k]!.points.push({ date, value: v });
    }
  }
  return out;
}

/**
 * The first-release value of every date any vintage holds: its value in the
 * earliest vintage that holds the date. Pure; sorted by date.
 */
export function firstReleaseValues(vintages: readonly AlfredVintage[]): Point[] {
  const first = new Map<string, number>();
  for (const v of [...vintages].sort((a, b) => a.vintage.localeCompare(b.vintage))) {
    for (const p of v.points) if (!first.has(p.date)) first.set(p.date, p.value);
  }
  return [...first.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Every first-release value ALFRED holds for `seriesId`. The first vintage
 * (`firstVintage`) is read whole; each later calendar day up to `lastVintage`
 * is read as the vintage in effect that day, from `windowDays` before it, so
 * a date's first appearance is caught on the day it was published. Requests
 * `perRequest` vintages at a time, one request after another.
 */
export async function fetchAlfredFirstRelease(
  seriesId: string,
  opts: { firstVintage: string; lastVintage: string; perRequest?: number; windowDays?: number; timeoutMs?: number },
): Promise<Point[]> {
  const perRequest = opts.perRequest ?? 40;
  const windowDays = opts.windowDays ?? 31;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const vintages: AlfredVintage[] = parseAlfredCsv(await fetchText(alfredUrl(seriesId, [opts.firstVintage], ["1900-01-01"]), timeoutMs), seriesId);
  const days: string[] = [];
  for (let d = addDays(opts.firstVintage, 1); d <= opts.lastVintage; d = addDays(d, 1)) days.push(d);
  for (let i = 0; i < days.length; i += perRequest) {
    const batch = days.slice(i, i + perRequest);
    const text = await fetchText(alfredUrl(seriesId, batch, batch.map((d) => addDays(d, -windowDays))), timeoutMs);
    vintages.push(...parseAlfredCsv(text, seriesId));
  }
  return firstReleaseValues(vintages);
}

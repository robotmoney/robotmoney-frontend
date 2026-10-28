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
//
// FRED publishes missing days as "." → NaN (dropped); consumers forward-fill.
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

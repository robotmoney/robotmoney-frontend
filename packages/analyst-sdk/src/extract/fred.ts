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

export const fredUrl = (seriesId: string) =>
  `${BASE}?id=${encodeURIComponent(seriesId)}&cosd=${COSD}`;

// Parse FRED's two-column CSV (DATE,VALUE). "." (missing) rows are dropped.
export function parseFredCsv(text: string): Point[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const out: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(",");
    if (comma < 0) continue;
    const date = lines[i].slice(0, comma).trim();
    if (!date) continue;
    const v = parseFloat(lines[i].slice(comma + 1));
    if (!Number.isFinite(v)) continue; // FRED uses "." for missing
    out.push({ date, value: v });
  }
  return out;
}

export async function fetchFred(seriesId: string, timeoutMs = 15000): Promise<Point[]> {
  const text = await fetchText(fredUrl(seriesId), timeoutMs);
  return parseFredCsv(text);
}

// Extract stage: parse the vendored raw-indicator floor seed file (issue #13).
// A full live cold boot would otherwise re-fetch years of history from ~8
// sources (esp. ~200 SEC-EDGAR requests) before the first regime could
// classify; the orchestrator loads this REAL vendored history once and submits
// it through the analytics API's seed-ingestion endpoint (issue #106), whose
// server-side gap-fill keeps the append-only honesty semantics (existing DB
// rows always win; running twice writes nothing the second time).
//
// Pure file parsing — no SQL, no network. The gap-fill WRITE lives behind the
// AnalyticsPersistence port (API-owned store/floor-seed.ts).
import { gunzipSync } from "node:zlib";
import type { RawIndicatorHistory } from "../types.ts";

// Default vendored seed: the raw-indicator-history fixture already in the repo
// (same CSV.gz shape as update.js writeRawHistoryCsv). A smoke/operator can point
// at a different file via FLOOR_SEED_PATH. Kept out of the source tree so we do not
// duplicate the ~530 KB payload; a smoke that seeds passes the path explicitly.
export const DEFAULT_FLOOR_SEED_PATH = new URL(
  "../../../tests/fixtures/regime/raw-indicator-history.csv.gz",
  import.meta.url,
).pathname;

function resolveSeedPath(explicit?: string): string {
  return explicit || process.env.FLOOR_SEED_PATH || DEFAULT_FLOOR_SEED_PATH;
}

// Parse a gzipped `date,indicator,value` CSV into RawIndicatorHistory (id → sorted
// {date,value}[]). Rows with a missing field or non-finite value are dropped. FAIL
// LOUDLY if the file is absent — a requested seed that silently no-ops would be a
// silent-skip. Mirrors tests/fixtures/regime/load.ts's parser.
export async function loadRawFloorSeed(path?: string): Promise<RawIndicatorHistory> {
  const p = resolveSeedPath(path);
  const file = Bun.file(p);
  if (!(await file.exists())) {
    throw new Error(`floor seed not found at ${p} — set FLOOR_SEED_PATH or ship the vendored seed`);
  }
  const buf = await file.arrayBuffer();
  const text = gunzipSync(Buffer.from(buf)).toString("utf8");
  const lines = text.split("\n");
  const out: RawIndicatorHistory = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.indexOf(",");
    const c2 = line.indexOf(",", c + 1);
    if (c < 0 || c2 < 0) continue;
    const date = line.slice(0, c);
    const id = line.slice(c + 1, c2);
    const v = parseFloat(line.slice(c2 + 1));
    if (!date || !id || !Number.isFinite(v)) continue;
    (out[id] ??= []).push({ date, value: v });
  }
  for (const id in out) out[id].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

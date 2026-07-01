// Store stage: the one-time COLD-DB raw floor seed for the opt-in real-live
// pipeline (issue #13). A full live cold boot would otherwise re-fetch years of
// history from ~8 sources (esp. ~200 SEC-EDGAR requests) before the first regime
// could classify. This loads a vendored `raw_indicator_history` floor ONCE so a
// fresh DB starts with real persisted history; subsequent live fetches merge fresh
// points OVER it via the existing append-only mergeSeries path (fetched wins on
// overlap; the floor is never deleted).
//
// HONESTY MODEL: the seed is REAL vendored history (the same
// raw-indicator-history.csv.gz shape the fidelity suite replays), never synthetic.
// It is a FLOOR: existing DB rows win on any (date,indicator) overlap — the seed
// only fills gaps. That makes this loader idempotent (running twice writes nothing
// the second time) and safe to run on every boot; it is a no-op once the floor is warm.
import { gunzipSync } from "node:zlib";
import {
  loadRawIndicatorHistory,
  saveRawIndicatorHistory,
  type RawIndicatorHistory,
} from "./raw-history-store.ts";
import type { Logger } from "../access/data-source.ts";

// Default vendored seed: the raw-indicator-history fixture already in the repo
// (same CSV.gz shape as update.js writeRawHistoryCsv). A demo/operator can point
// at a different file via FLOOR_SEED_PATH. Kept out of the source tree so we do not
// duplicate the ~530 KB payload; a demo that seeds passes the path explicitly.
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

export interface FloorSeedResult {
  seededPoints: number; // rows actually written this run (gap-fill only)
  existingPoints: number; // rows already present (skipped — DB floor wins)
  indicators: number; // distinct indicators touched by the seed
}

// Idempotent cold-DB seed. Loads the vendored floor, and for each (date,indicator)
// NOT already persisted, writes it. Existing rows are never overwritten (the DB
// floor wins on overlap → the honest append-only semantics of mergeSeries). Second
// run finds every date present → writes nothing → no-op.
export async function seedRawIndicatorFloor(
  opts: { path?: string; logger?: Logger } = {},
): Promise<FloorSeedResult> {
  const logger: Logger = opts.logger ?? console;
  const seed = await loadRawFloorSeed(opts.path);
  const existing = await loadRawIndicatorHistory();

  const toWrite: RawIndicatorHistory = {};
  let seededPoints = 0;
  let existingPoints = 0;
  for (const [id, pts] of Object.entries(seed)) {
    const have = new Set((existing[id] ?? []).map((p) => p.date));
    const missing = pts.filter((p) => !have.has(p.date));
    existingPoints += pts.length - missing.length;
    if (missing.length) {
      toWrite[id] = missing;
      seededPoints += missing.length;
    }
  }

  await saveRawIndicatorHistory(toWrite);
  const indicators = Object.keys(toWrite).length;
  if (seededPoints > 0) {
    logger.log?.(
      `[analytics] floor seed: wrote ${seededPoints} real rows across ${indicators} indicator(s) (cold-DB gap fill); ${existingPoints} already present`,
    );
  } else {
    logger.log?.(`[analytics] floor seed: no-op — floor already warm (${existingPoints} rows present)`);
  }
  return { seededPoints, existingPoints, indicators };
}

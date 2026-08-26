// Store stage: the append-only persisted-real floor for raw indicator inputs.
// `raw_indicator_history` holds one row per (date, indicator); the orchestrator
// loads this floor, merges freshly-fetched points over it (fetched wins on
// overlap, never deletes — see mergeSeries), and writes the merged result back.
// This is what keeps the pipeline honest: a failed/empty fetch degrades to real
// persisted history, never to synthetic data. Pure I/O — no compute.
//
// API-OWNED (issue #106): only the API process (via api/routes/analytics.ts +
// store/direct.ts) and migration/smoke tooling may import this module. Updater/
// orchestrator/worker code persists through the AnalyticsPersistence port
// (analytics/persistence.ts) instead — enforced by
// tests/analytics-api-boundary.test.ts. Writers accept an injectable Sql handle
// so the API routes can wrap a whole ingestion batch in ONE transaction.
import { sql, type DbHandle } from "../../db/client.ts";
import type { Point, RawIndicatorHistory } from "../types.ts";

// Back-compat aliases: the row shapes now live in the pure types module
// (analytics/types.ts) so updater/API-client code can import them without
// touching this SQL module.
export type DatedValue = Point;
export type { RawIndicatorHistory };

// Load the whole persisted floor, grouped by indicator id and sorted by date
// ascending. `date::text` yields a clean 'YYYY-MM-DD' string (postgres.js would
// otherwise hand back a JS Date).
export async function loadRawIndicatorHistory(db: DbHandle = sql): Promise<RawIndicatorHistory> {
  const rows = await db<{ indicator: string; date: string; value: number }[]>`
    SELECT indicator, date::text AS date, value
    FROM raw_indicator_history
    ORDER BY indicator, date`;
  const out: RawIndicatorHistory = {};
  for (const r of rows) {
    (out[r.indicator] ??= []).push({ date: r.date, value: Number(r.value) });
  }
  return out;
}

// Persist merged history back, upserting on (date, indicator) so re-runs
// overwrite rather than duplicate. Non-finite values are skipped (the floor only
// stores real observations). No-op for empty input.
//
// `source` (issue #397) tags every row in this call with the data source that
// produced it — 'live' by default (the orchestrator's production merge path),
// or an explicit override (store/floor-seed.ts passes 'seed' for its vendored
// gap-fill writer). ON CONFLICT overwrites `source` along with `value` so a
// genuine live fetch upgrades a previously-seeded row's provenance, matching
// the existing "fetched wins on overlap" honesty semantics.
export async function saveRawIndicatorHistory(
  byIndicator: RawIndicatorHistory,
  db: DbHandle = sql,
  source: string = "live",
): Promise<void> {
  const rows: { date: string; indicator: string; value: number; source: string }[] = [];
  for (const [indicator, points] of Object.entries(byIndicator)) {
    for (const p of points) {
      if (!Number.isFinite(p.value)) continue;
      rows.push({ date: p.date, indicator, value: p.value, source });
    }
  }
  if (rows.length === 0) return;
  // The full floor is tens of thousands of (date,indicator) rows; a single
  // multi-row INSERT would blow past Postgres' 65534 bind-parameter cap (4 params
  // per row). Chunk so each statement stays well under the limit.
  const CHUNK = 5000; // 5000 × 4 = 20000 params per statement
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await db`
      INSERT INTO raw_indicator_history ${db(batch, "date", "indicator", "value", "source")}
      ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`;
  }
}

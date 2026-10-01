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
import { on, registerQuery } from "../../db/registry.ts";
import type { Point, RawIndicatorHistory } from "../types.ts";
import { rawIndicatorSourceKey, withinTolerance } from "../source-tolerance.ts";

// Registered queries (smoke-production-spec.md §7.1), reached only through the
// analytics ingestion routes (directly, and through the floor-seed gap fill).
const readFloor = registerQuery({
  role: "rm_app",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/analytics/store/raw-history-store:loadRawIndicatorHistory",
  purpose: "Read the whole persisted raw-indicator floor, grouped by indicator, for the orchestrator's merge.",
  callers: ["src/api/routes/analytics"],
  probe: { statement: "SELECT indicator, date::text AS date, value FROM raw_indicator_history ORDER BY indicator, date" },
});

const readFloorForIndicators = registerQuery({
  role: "rm_app",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/analytics/store/raw-history-store:saveRawIndicatorHistory.readStored",
  purpose: "Read the stored value of the indicators about to be rewritten, so a sub-tolerance rewrite is skipped (issue #1035).",
  callers: ["src/api/routes/analytics"],
  probe: {
    statement: `SELECT indicator, date::text AS date, value
    FROM raw_indicator_history
    WHERE indicator = ANY($1::text[])`,
    params: ["{}"],
  },
});

const upsertFloor = registerQuery({
  role: "rm_app",
  object: "raw_indicator_history",
  // UPDATE for ON CONFLICT DO UPDATE ("fetched wins on overlap"); SELECT
  // because the conflict target and EXCLUDED are read. Never DELETE.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/analytics/store/raw-history-store:saveRawIndicatorHistory",
  purpose: "Upsert merged raw-indicator points on (date, indicator), tagging each row with its source.",
  callers: ["src/api/routes/analytics"],
  probe: {
    statement: `INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES ($1::date, $2, $3, $4)
      ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`,
    params: ["2026-01-01", "probe_indicator", 1.5, "live"],
  },
});

// Back-compat aliases: the row shapes now live in the pure types module
// (analytics/types.ts) so updater/API-client code can import them without
// touching this SQL module.
export type DatedValue = Point;
export type { RawIndicatorHistory };

// Load the whole persisted floor, grouped by indicator id and sorted by date
// ascending. `date::text` yields a clean 'YYYY-MM-DD' string (postgres.js would
// otherwise hand back a JS Date).
export async function loadRawIndicatorHistory(db: DbHandle = sql): Promise<RawIndicatorHistory> {
  const rows = await on(db, readFloor)<{ indicator: string; date: string; value: number }>`
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
// gap-fill writer). ON CONFLICT overwrites `source` along with `value`, so a
// row's label is the label of the write that last changed its value.
//
// A SUB-TOLERANCE REWRITE IS SKIPPED (issue #1035). The orchestrator writes its
// whole merged floor back every run, so every point is re-submitted many times a
// day; migration 0056's trigger records an analytics_overwrite_events row for any
// UPDATE that changes the row at all, and Yahoo's float32 jitter changed
// hundreds of thousands a day by a relative 1e-9..1e-6. A point whose value is
// within its source's tolerance of the stored one (source-tolerance.ts, decision
// D56) is left alone WHATEVER its label: no UPDATE, so no overwrite event. A
// label change alone is not a change (owner, 2026-09-29): the live fetch and the
// producer's 'seed' catch-up rewrite the same points, and relabelling on every
// turn recorded ~13 rewrites per point. This is the same rule
// store/source-ledger-store.ts applies to the ledger head, from the same
// function, so the two stay in parity.
export async function saveRawIndicatorHistory(
  byIndicator: RawIndicatorHistory,
  db: DbHandle = sql,
  source: string = "live",
): Promise<void> {
  const indicators = Object.keys(byIndicator);
  if (indicators.length === 0) return;
  const stored = new Map<string, number>();
  const current = await on(db, readFloorForIndicators)<{ indicator: string; date: string; value: number }>`
    SELECT indicator, date::text AS date, value
    FROM raw_indicator_history
    WHERE indicator = ANY(${indicators}::text[])`;
  for (const r of current) stored.set(`${r.indicator}|${r.date}`, Number(r.value));

  const rows: { date: string; indicator: string; value: number; source: string }[] = [];
  for (const [indicator, points] of Object.entries(byIndicator)) {
    const sourceKey = rawIndicatorSourceKey(indicator);
    for (const p of points) {
      if (!Number.isFinite(p.value)) continue;
      const prior = stored.get(`${indicator}|${p.date}`);
      if (prior !== undefined && withinTolerance(sourceKey, prior, p.value)) continue;
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
    await on(db, upsertFloor)`
      INSERT INTO raw_indicator_history ${db(batch, "date", "indicator", "value", "source")}
      ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`;
  }
}

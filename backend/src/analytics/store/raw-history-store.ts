// Store stage: the append-only persisted-real floor for raw indicator inputs.
// `raw_indicator_history` holds one row per (date, indicator); the orchestrator
// loads this floor, merges freshly-fetched points over it (fetched wins on
// overlap, never deletes — see mergeSeries), and writes the merged result back.
// This is what keeps the pipeline honest: a failed/empty fetch degrades to real
// persisted history, never to synthetic data. Pure I/O — no compute.
import { sql } from "../../db/client.ts";

export interface DatedValue {
  date: string; // YYYY-MM-DD
  value: number;
}

export type RawIndicatorHistory = Record<string, DatedValue[]>;

// Load the whole persisted floor, grouped by indicator id and sorted by date
// ascending. `date::text` yields a clean 'YYYY-MM-DD' string (postgres.js would
// otherwise hand back a JS Date).
export async function loadRawIndicatorHistory(): Promise<RawIndicatorHistory> {
  const rows = await sql<{ indicator: string; date: string; value: number }[]>`
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
export async function saveRawIndicatorHistory(byIndicator: RawIndicatorHistory): Promise<void> {
  const rows: { date: string; indicator: string; value: number }[] = [];
  for (const [indicator, points] of Object.entries(byIndicator)) {
    for (const p of points) {
      if (!Number.isFinite(p.value)) continue;
      rows.push({ date: p.date, indicator, value: p.value });
    }
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO raw_indicator_history ${sql(rows, "date", "indicator", "value")}
    ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value`;
}

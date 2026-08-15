// Store stage: persist a research signal to research_signals, keyed by signal +
// date. Upserts on the natural key so re-running a slot overwrites rather than
// duplicates. The only SQL write for research payloads.
//
// API-OWNED (issue #106): only the API process (api/routes/analytics.ts +
// store/direct.ts) may import this writer; updaters submit through the
// AnalyticsPersistence port. Accepts an injectable Sql handle so the API route
// can wrap a whole signal batch in one transaction.
import { jsonValue, sql, type DbHandle } from "../../db/client.ts";
import type { ResearchPayload } from "../analyze/research.ts";

export async function persistResearchSignal(
  key: string,
  asof: string,
  payload: ResearchPayload,
  db: DbHandle = sql,
): Promise<void> {
  await db`
    INSERT INTO research_signals (signal_key, date, payload)
    VALUES (${key}, ${asof}, ${db.json(jsonValue(payload))})
    ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload`;
}

// Which (signal_key, date) pairs exist on/after `sinceDate` — the read side of
// the producer catch-up mechanism (issue #614 AC4). Deliberately narrow (no
// payload) — this exists only to answer "which days are missing", never to
// serve signal content (that stays behind the allowlisted admin read at
// GET /api/admin/research/signals/:key).
export async function loadRecentResearchSignalDates(
  sinceDate: string,
  db: DbHandle = sql,
): Promise<{ signalKey: string; date: string }[]> {
  const rows = await db<{ signal_key: string; date: Date }[]>`
    SELECT signal_key, date FROM research_signals WHERE date >= ${sinceDate}::date ORDER BY date ASC`;
  return rows.map((r) => ({
    signalKey: r.signal_key,
    date: (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10),
  }));
}

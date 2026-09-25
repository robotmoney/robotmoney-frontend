// Store stage: persist a research signal to research_signals, keyed by signal +
// date. Upserts on the natural key so re-running a slot overwrites rather than
// duplicates. The only SQL write for research payloads.
//
// API-OWNED (issue #106): only the API process (api/routes/analytics.ts +
// store/direct.ts) may import this writer; updaters submit through the
// AnalyticsPersistence port. Accepts an injectable Sql handle so the API route
// can wrap a whole signal batch in one transaction.
import { jsonValue, sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import type { ResearchPayload } from "../analyze/research.ts";

// Registered queries (smoke-production-spec.md §7.1). Both are reached only
// through the analytics ingestion routes: the writer inside the output
// snapshot transaction, the date read by the producer catch-up endpoint.
const upsertSignal = registerQuery({
  role: "rm_app",
  object: "research_signals",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target and
  // EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/analytics/store/research-store:persistResearchSignal",
  purpose: "Upsert one research signal payload on its (signal_key, date) natural key.",
  callers: ["src/api/routes/analytics"],
  probe: {
    statement: `INSERT INTO research_signals (signal_key, date, payload) VALUES ($1, $2::date, $3::jsonb)
      ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload`,
    params: ["probe_signal", "2026-01-01", "{\"probe\":true}"],
  },
});

const recentSignalDates = registerQuery({
  role: "rm_app",
  object: "research_signals",
  privileges: ["SELECT"],
  site: "src/analytics/store/research-store:loadRecentResearchSignalDates",
  purpose: "List which (signal_key, date) pairs exist since a date, so the producer can fill only the missing days.",
  callers: ["src/api/routes/analytics"],
  probe: {
    statement: "SELECT signal_key, date FROM research_signals WHERE date >= $1::date ORDER BY date ASC",
    params: ["2026-01-01"],
  },
});

export async function persistResearchSignal(
  key: string,
  asof: string,
  payload: ResearchPayload,
  db: DbHandle = sql,
): Promise<void> {
  await on(db, upsertSignal)`
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
  const rows = await on(db, recentSignalDates)<{ signal_key: string; date: Date }>`
    SELECT signal_key, date FROM research_signals WHERE date >= ${sinceDate}::date ORDER BY date ASC`;
  return rows.map((r) => ({
    signalKey: r.signal_key,
    date: (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10),
  }));
}

// Report stage: the read/projection layer over the persisted analytics. Owns all
// SQL reads + the row→DTO map for the dashboard surfaces, so the HTTP route is a
// thin adapter (parse/clamp `range`, call here). MCP and frontend stay consumers
// over the HTTP boundary; this is the single backend projection layer.
import { sql } from "../../db/client.ts";
import type { RegimeSnapshot } from "@robotmoney/contract";

function rowToSnapshot(r: any): RegimeSnapshot {
  return {
    date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
    composite: r.composite === null ? null : Number(r.composite),
    compositePercentile: r.composite_percentile === null ? null : Number(r.composite_percentile),
    regime: r.regime,
    macroRegime: r.macro_regime,
    onchainRegime: r.onchain_regime,
    factorRegime: r.factor_regime,
    percentiles: r.percentiles ?? {},
    indicators: r.indicators ?? {},
  };
}

// Latest research-signal payload for a key (or null).
export async function fetchLatestResearchSignal(key: string) {
  const rows = await sql`SELECT signal_key, date, payload FROM research_signals WHERE signal_key = ${key} ORDER BY date DESC LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  const date = typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10);
  return { signalKey: r.signal_key, date, payload: r.payload };
}

// The most recent `range` regime snapshots → { latest, history } (chronological).
export async function fetchRegimeSnapshots(range: number): Promise<{ latest: RegimeSnapshot | null; history: RegimeSnapshot[] }> {
  const rows = await sql`
    SELECT * FROM regime_snapshots
    ORDER BY date DESC
    LIMIT ${range}
  `;
  const history = rows.map(rowToSnapshot).reverse(); // chronological
  const latest = history.length ? history[history.length - 1] : null;
  return { latest, history };
}

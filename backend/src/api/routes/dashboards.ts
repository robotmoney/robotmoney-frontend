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

// GET /api/dashboards/research-signals/:key → latest research signal payload
export async function getResearchSignal(key: string) {
  const rows = await sql`SELECT signal_key, date, payload FROM research_signals WHERE signal_key = ${key} ORDER BY date DESC LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  const date = typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10);
  return { signalKey: r.signal_key, date, payload: r.payload };
}

// GET /api/dashboards/regime-snapshots?range=<n days> → { latest, history }
export async function getRegimeSnapshots(url: URL): Promise<{ latest: RegimeSnapshot | null; history: RegimeSnapshot[] }> {
  const range = Math.min(3650, Math.max(1, Number(url.searchParams.get("range") ?? 180)));
  const rows = await sql`
    SELECT * FROM regime_snapshots
    ORDER BY date DESC
    LIMIT ${range}
  `;
  const history = rows.map(rowToSnapshot).reverse(); // chronological
  const latest = history.length ? history[history.length - 1] : null;
  return { latest, history };
}

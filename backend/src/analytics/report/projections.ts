// Report stage: the read/projection layer over the persisted analytics. Owns all
// SQL reads + the row→DTO map for the dashboard surfaces, so the HTTP route is a
// thin adapter (parse/clamp `range`, call here). MCP and frontend stay consumers
// over the HTTP boundary; this is the single backend projection layer.
import { sql } from "../../db/client.ts";
import type { RegimeSnapshot } from "@robotmoney/contract";

// Postgres hands numerics back as text; coerce to number|null. `null`/undefined
// stay null so the DTO's nullable panel fields are honest.
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function rowToSnapshot(r: any): RegimeSnapshot {
  return {
    date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
    composite: num(r.composite),
    compositePercentile: num(r.composite_percentile),
    regime: r.regime,
    macroRegime: r.macro_regime,
    onchainRegime: r.onchain_regime,
    factorRegime: r.factor_regime,
    // v2 enrichment: panel indices/percentiles, point-in-time panel weights, version.
    macroIndex: num(r.macro_index),
    onchainIndex: num(r.onchain_index),
    factorIndex: num(r.factor_index),
    macroPercentile: num(r.macro_percentile),
    onchainPercentile: num(r.onchain_percentile),
    factorPercentile: num(r.factor_percentile),
    panelWeights: r.panel_weights ?? null,
    version: r.version ?? null,
    percentiles: r.percentiles ?? {},
    indicators: r.indicators ?? [],
    // Asof-only backtest + predictive correlations (latest row only; null on history).
    backtest: r.backtest ?? null,
    correlations: r.correlations ?? null,
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

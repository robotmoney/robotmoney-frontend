// Report stage: the read/projection layer over the persisted analytics. Owns all
// SQL reads + the row→DTO map for the dashboard surfaces, so the HTTP route is a
// thin adapter (parse/clamp `range`, call here). MCP and frontend stay consumers
// over the HTTP boundary; this is the single backend projection layer.
import { sql } from "../../db/client.ts";
import type { RegimeHistoryPoint, RegimeSnapshot } from "@robotmoney/contract";
// The row→DTO projection lives in a pure, DB-free module so the offline
// eq-snapshot mapper can reuse the EXACT same projection (see regime-projection.ts).
import { rowToSnapshot, forHistory, computeRegimeSnapshotStaleness, type RegimeStaleness } from "./regime-projection.ts";

// The read an agent actually makes: today's classifier read without the ~500
// KB of backtests/correlations/indicators/percentiles that ride along on the
// full response (issue #866c). Purely additive — a new response shape behind
// a new query param, nothing existing changes.
export interface RegimeSummary {
  date: string;
  composite: number | null;
  compositePercentile: number | null;
  regime: string | null;
  macroIndex: number | null;
  onchainIndex: number | null;
  factorIndex: number | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  staleness: RegimeStaleness;
}

export function toRegimeSummary(latest: RegimeSnapshot | null, staleness: RegimeStaleness): RegimeSummary | null {
  if (!latest) return null;
  return {
    date: latest.date,
    composite: latest.composite,
    compositePercentile: latest.compositePercentile,
    regime: latest.regime,
    macroIndex: latest.macroIndex ?? null,
    onchainIndex: latest.onchainIndex ?? null,
    factorIndex: latest.factorIndex ?? null,
    macroRegime: latest.macroRegime,
    onchainRegime: latest.onchainRegime,
    factorRegime: latest.factorRegime,
    staleness,
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

// The most recent `range` regime snapshots → { latest, history, staleness }
// (chronological). `staleness` flags whether the newest served snapshot is fresh
// enough to trust: a frozen snapshot (analytics job not running in the deployment)
// would otherwise be served silently as current — the frontend renders history[]
// verbatim. Additive: existing `latest`/`history` are unchanged.
//
// `date <= today` is enforced here as a read-side boundary (issue #382): a
// future-dated row — from a smoke/seed bug, a manual insert, or clock skew on
// whatever produced it — would otherwise sort first under `ORDER BY date DESC`
// and be served as `latest`, SHADOWING the real current snapshot and reading
// as fresh (`stale: false`) when the deployment's actual data may be stale or
// absent. This holds regardless of whether the row's producer is itself
// well-behaved, so it is not redundant with any upstream generator fix.
//
// `staleness` is derived from `latest.indicators[].raw_date` (the REAL
// per-panel observation dates), never from `latest.date` — the pipeline
// forward-fills that column to today on every run regardless of whether the
// underlying sources actually refreshed, so it can't detect a frozen source
// (issue #398). See computeRegimeSnapshotStaleness.
export async function fetchRegimeSnapshots(
  range: number,
): Promise<{ latest: RegimeSnapshot | null; history: RegimeHistoryPoint[]; staleness: RegimeStaleness }> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql`
    SELECT * FROM regime_snapshots
    WHERE date <= ${today}
    ORDER BY date DESC
    LIMIT ${range}
  `;
  const full = rows.map(rowToSnapshot).reverse(); // chronological
  const latest = full.length ? full[full.length - 1] : null;
  const staleness = computeRegimeSnapshotStaleness(latest?.indicators ?? null, today);
  // `latest` keeps every field; history rows are projected via forHistory
  // (issue #866a), which also ends the double-serialization the old
  // `history[-1] === latest` aliasing caused — they're now separate objects,
  // one full and one projected, rather than the same object twice.
  return { latest, history: full.map(forHistory), staleness };
}

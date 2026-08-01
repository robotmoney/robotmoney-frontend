// Report stage: the read/projection layer over the persisted analytics. Owns all
// SQL reads + the row→DTO map for the dashboard surfaces, so the HTTP route is a
// thin adapter (parse/clamp `range`, call here). MCP and frontend stay consumers
// over the HTTP boundary; this is the single backend projection layer.
import { sql } from "../../db/client.ts";
import type { RegimeSnapshot } from "@robotmoney/contract";
// The row→DTO projection lives in a pure, DB-free module so the offline
// eq-snapshot mapper can reuse the EXACT same projection (see regime-projection.ts).
import { rowToSnapshot, computeRegimeStaleness, type RegimeStaleness } from "./regime-projection.ts";

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
// future-dated row — from a demo/seed bug, a manual insert, or clock skew on
// whatever produced it — would otherwise sort first under `ORDER BY date DESC`
// and be served as `latest`, SHADOWING the real current snapshot and reading
// as fresh (`stale: false`) when the deployment's actual data may be stale or
// absent. This holds regardless of whether the row's producer is itself
// well-behaved, so it is not redundant with any upstream generator fix.
export async function fetchRegimeSnapshots(
  range: number,
): Promise<{ latest: RegimeSnapshot | null; history: RegimeSnapshot[]; staleness: RegimeStaleness }> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql`
    SELECT * FROM regime_snapshots
    WHERE date <= ${today}
    ORDER BY date DESC
    LIMIT ${range}
  `;
  const history = rows.map(rowToSnapshot).reverse(); // chronological
  const latest = history.length ? history[history.length - 1] : null;
  const staleness = computeRegimeStaleness(latest?.date ?? null, today);
  return { latest, history, staleness };
}

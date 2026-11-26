// Report stage: the read/projection layer over the persisted analytics. Owns all
// SQL reads + the row→DTO map for the dashboard surfaces, so the HTTP route is a
// thin adapter (parse/clamp `range`, call here). MCP and frontend stay consumers
// over the HTTP boundary; this is the single backend projection layer.
import { sql } from "../../db/client.ts";
import type { RegimeHistoryPoint, RegimeSnapshot } from "@robotmoney/contract";
// The row→DTO projection lives in a pure, DB-free module so the offline
// eq-snapshot mapper can reuse the EXACT same projection (see regime-projection.ts).
import { rowToSnapshot, shapeRegimeSnapshots, type RegimeStaleness } from "./regime-projection.ts";
// Issue 1182 (D83): in BOTH read modes these two reads serve the PUBLISHED
// figures, selected from the frozen run ledger (cutover/ledger-current.ts),
// never the newest run's recomputation the compatibility tables hold. The
// tables are read only on a database where no run has published anything.
import { getAnalyticsReadMode } from "../cutover/read-mode.ts";
import { MAIN_REGIME_LINE, besideRegimeLine, ledgerCurrentLatestResearchSignal, ledgerPublishedRegimeHistory, type RegimeLineSelector } from "../cutover/ledger-current.ts";
import { REGIME_LINE, type RegimeVersion } from "../analyze/regime-versions.ts";
import type { RegimeSnapshotRow } from "./regime-projection.ts";
import { toDbRow } from "./regime-eq-map.ts";
import { on, registerQuery } from "../../db/registry.ts";

// Registered queries (smoke-production-spec.md §7.1): the compatibility-mode
// reads, reached only through the dashboards routes.
const latestSignal = registerQuery({
  role: "rm_app",
  object: "research_signals",
  privileges: ["SELECT"],
  site: "src/analytics/report/projections:fetchLatestResearchSignal",
  purpose: "Read the newest research-signal payload for a key, in compatibility read mode.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: "SELECT signal_key, date, payload FROM research_signals WHERE signal_key = $1 ORDER BY date DESC LIMIT 1",
    params: ["probe_signal"],
  },
});

const recentSnapshots = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/report/projections:fetchRegimeSnapshots",
  purpose: "Read the newest `range` regime snapshots dated no later than today, in compatibility read mode.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: "SELECT * FROM regime_snapshots WHERE date <= $1::date ORDER BY date DESC LIMIT $2",
    params: ["2026-01-01", 30],
  },
});

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
//
// Issue 1182 (D83): the latest day's PUBLISHED payload, from the frozen
// ledger in both read modes, so a run written after that day never replaces
// what readers were shown. The research_signals table is read only when the
// ledger holds no publication of the key (compatibility mode; a database no
// run has written, or a key seeded outside the runs).
export async function fetchLatestResearchSignal(key: string) {
  const signal = await ledgerCurrentLatestResearchSignal(key);
  if (signal) return { signalKey: signal.signalKey, date: signal.date, payload: signal.payload };
  if ((await getAnalyticsReadMode()) === "ledger") return null;
  const rows = await on(sql, latestSignal)<{ signal_key: string; date: string | Date; payload: unknown }>`
    SELECT signal_key, date, payload FROM research_signals WHERE signal_key = ${key} ORDER BY date DESC LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  const date = typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10);
  return { signalKey: r.signal_key, date, payload: r.payload };
}

// Normalize a ledger-replayed store row (camelCase, JS numbers already —
// JSON.parse's inverse of the exact canonicalStringify the ledger writer
// serialized) into the same DTO shape rowToSnapshot produces from a raw SQL
// row, so a caller cannot tell which mode answered it. By construction (issue
// 1765): the row as the table would hold it (toDbRow, one cell per
// SNAPSHOT_COLUMNS entry), through rowToSnapshot itself.
export function ledgerRowToSnapshot(r: RegimeSnapshotRow): RegimeSnapshot {
  return rowToSnapshot(toDbRow(r)) as unknown as RegimeSnapshot;
}

// Which read path produced a regime response (issue #1095): the compatibility
// table or the immutable ledger. Stated in the response so an auditor pulling
// regime outputs from the dashboards endpoint knows what they are looking at.
export type RegimeReadSource = "regime_snapshots" | "ledger";

// The most recent `range` regime snapshots → { latest, history, staleness, source }
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
// `includeBacktest` (issue #866b): `latest.backtest` is ~126 KB and only
// /regime's backtest panel reads it. Off by default; the caller opts in with
// ?include=backtest. Do-not-ship-alone: regime.js has to start asking for it
// explicitly in the SAME release, or its backtest panel goes blank.
//
// `methodology` (issue 1753, decision D96): the line of one methodology
// version, named in the response's `methodology` field. A version published
// beside the main line (v5) is read from its own frozen artifacts
// (`regime_beside_snapshots`); a main-line version from the main line's
// artifacts stamped with it. Only the ledger is read, and only rows that have
// a label are served (a beside line also keeps unlabelled rows, so a later run
// can rebuild its record). A version that has published nothing answers
// `latest` null and an empty history. Absent, the response is the main line,
// byte for byte as before, with no `methodology` field.
export async function fetchRegimeSnapshots(
  range: number,
  includeBacktest = false,
  methodology?: RegimeVersion,
): Promise<{
  latest: RegimeSnapshot | null;
  history: RegimeHistoryPoint[];
  staleness: RegimeStaleness;
  source: RegimeReadSource;
  methodology?: RegimeVersion;
}> {
  const today = new Date().toISOString().slice(0, 10);
  if (methodology !== undefined) {
    const line: RegimeLineSelector = REGIME_LINE[methodology] === "beside" ? besideRegimeLine(methodology) : { ...MAIN_REGIME_LINE, version: methodology };
    const rows = ((await ledgerPublishedRegimeHistory(today, sql, line)) ?? []).filter((r) => r.regime != null);
    return { ...shapeRegimeSnapshots(rows.slice(-range).map(ledgerRowToSnapshot), today, includeBacktest), source: "ledger", methodology };
  }
  // Issue 1182 (D83): every day's PUBLISHED row, selected from the frozen
  // ledger in both read modes (cutover/ledger-current.ts states the rule).
  // regime_snapshots, which every run rewrites for every day, is read only
  // when no run has published anything (compatibility mode).
  const published = await ledgerPublishedRegimeHistory(today);
  const mode = await getAnalyticsReadMode();
  const source: RegimeReadSource = published !== null || mode === "ledger" ? "ledger" : "regime_snapshots";
  const full =
    source === "ledger"
      ? (published ?? []).slice(-range).map(ledgerRowToSnapshot)
      : (
          await on(sql, recentSnapshots)`
    SELECT * FROM regime_snapshots
    WHERE date <= ${today}
    ORDER BY date DESC
    LIMIT ${range}
  `
        ).map(rowToSnapshot).reverse(); // chronological
  // `latest` keeps every field except backtest, opt-in via includeBacktest
  // (issue #866b); history rows are projected via forHistory (issue #866a),
  // which also ends the double-serialization the old `history[-1] === latest`
  // aliasing caused — they're now separate objects, one full (minus backtest
  // unless asked for) and one projected, rather than the same object twice.
  // The shaping is the SDK's shapeRegimeSnapshots (issue 1751).
  return { ...shapeRegimeSnapshots(full, today, includeBacktest), source };
}

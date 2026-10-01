// Report stage: the read/projection layer over the persisted analytics. Owns all
// SQL reads + the row→DTO map for the dashboard surfaces, so the HTTP route is a
// thin adapter (parse/clamp `range`, call here). MCP and frontend stay consumers
// over the HTTP boundary; this is the single backend projection layer.
import { sql } from "../../db/client.ts";
import type { RegimeHistoryPoint, RegimeSnapshot } from "@robotmoney/contract";
// The row→DTO projection lives in a pure, DB-free module so the offline
// eq-snapshot mapper can reuse the EXACT same projection (see regime-projection.ts).
import { rowToSnapshot, forHistory, computeRegimeSnapshotStaleness, type RegimeStaleness } from "./regime-projection.ts";
// Issue #979: once cutover is armed (analytics_read_mode = 'ledger'), these
// two reads resolve from the immutable Phase A ledger instead of the mutable
// regime_snapshots/research_signals tables — see cutover/ledger-current.ts's
// header for the replay rule that makes the two reads equivalent.
import { getAnalyticsReadMode } from "../cutover/read-mode.ts";
import { ledgerCurrentLatestResearchSignal, ledgerCurrentRegimeSnapshots } from "../cutover/ledger-current.ts";
import type { RegimeSnapshotRow } from "./regime-projection.ts";
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
// Issue #979: when analytics_read_mode is 'ledger', this is derived PURELY
// from analytics_output_snapshots (never from research_signals) — see
// cutover/ledger-current.ts's replay rule. The compatibility table keeps
// being dual-written either way; only the READ resolves differently.
export async function fetchLatestResearchSignal(key: string) {
  if ((await getAnalyticsReadMode()) === "ledger") {
    const signal = await ledgerCurrentLatestResearchSignal(key);
    return signal ? { signalKey: signal.signalKey, date: signal.date, payload: signal.payload } : null;
  }
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
// row, so a caller cannot tell which mode answered it.
function ledgerRowToSnapshot(r: RegimeSnapshotRow): RegimeSnapshot {
  return {
    date: r.date,
    composite: r.composite,
    compositePercentile: r.compositePercentile,
    regime: r.regime,
    macroRegime: r.macroRegime,
    onchainRegime: r.onchainRegime,
    factorRegime: r.factorRegime,
    macroIndex: r.macroIndex ?? null,
    onchainIndex: r.onchainIndex ?? null,
    factorIndex: r.factorIndex ?? null,
    macroPercentile: r.macroPercentile ?? null,
    onchainPercentile: r.onchainPercentile ?? null,
    factorPercentile: r.factorPercentile ?? null,
    panelWeights: r.panelWeights ?? null,
    version: r.version ?? null,
    source: r.source ?? null,
    percentiles: r.percentiles ?? {},
    indicators: r.indicators ?? [],
    panels: r.panels ?? null,
    bucketThresholds: r.bucketThresholds ?? null,
    backtest: r.backtest ?? null,
    correlations: r.correlations ?? null,
    extras: r.extras ?? null,
  } as unknown as RegimeSnapshot;
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
// `includeBacktest` (issue #866b): `latest.backtest` is ~126 KB and only
// /regime's backtest panel reads it. Off by default; the caller opts in with
// ?include=backtest. Do-not-ship-alone: regime.js has to start asking for it
// explicitly in the SAME release, or its backtest panel goes blank.
export async function fetchRegimeSnapshots(
  range: number,
  includeBacktest = false,
): Promise<{ latest: RegimeSnapshot | null; history: RegimeHistoryPoint[]; staleness: RegimeStaleness }> {
  const today = new Date().toISOString().slice(0, 10);
  // Issue #979: ledger mode derives the exact same rows PURELY from
  // analytics_output_snapshots (never from regime_snapshots) — see
  // cutover/ledger-current.ts. The compatibility table keeps being
  // dual-written either way; only the READ resolves differently.
  const full =
    (await getAnalyticsReadMode()) === "ledger"
      ? (await ledgerCurrentRegimeSnapshots())
          .filter((r) => r.date <= today)
          .slice(-range)
          .map(ledgerRowToSnapshot)
      : (
          await on(sql, recentSnapshots)`
    SELECT * FROM regime_snapshots
    WHERE date <= ${today}
    ORDER BY date DESC
    LIMIT ${range}
  `
        ).map(rowToSnapshot).reverse(); // chronological
  const latestFull = full.length ? full[full.length - 1] : null;
  const staleness = computeRegimeSnapshotStaleness(latestFull?.indicators ?? null, today);
  // `latest` keeps every field except backtest, opt-in via includeBacktest
  // (issue #866b); history rows are projected via forHistory (issue #866a),
  // which also ends the double-serialization the old `history[-1] === latest`
  // aliasing caused — they're now separate objects, one full (minus backtest
  // unless asked for) and one projected, rather than the same object twice.
  const latest = latestFull && !includeBacktest ? { ...latestFull, backtest: null } : latestFull;
  return { latest, history: full.map(forHistory), staleness };
}

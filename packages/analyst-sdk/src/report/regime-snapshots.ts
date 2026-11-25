// The regime-snapshots response shaping (issue 1751): stored row → served
// snapshot, the history projection, staleness, and the { latest, history,
// staleness } response. Pure: the backend reads the rows and calls these.
// The served shapes are declared here because the SDK installs alone; a backend
// test asserts they and the contract package's shapes are assignable both ways.
import type { CorrelationsPayload } from "../analyze/correlations.ts";

export type AnalyticsProvenance = "live" | "hermetic" | "fixture" | "seed";

// One enriched per-indicator object inside a RegimeSnapshot (asof row).
export interface RegimeIndicator {
  id: string;
  name: string;
  panel: "macro" | "onchain" | "factor";
  source?: string;
  source_url?: string | null;
  description?: string | null;
  sign?: number;
  transform?: string;
  unit?: string | null;
  raw_value: number | null;
  raw_date: string | null;
  transformed_value: number | null;
  percentile: number | null;
  signed_percentile: number | null;
  panel_weight: number | null;
  forward_fill_age_days: number | null;
  forward_fill_expired: boolean;
  sparkline: (number | null)[];
}

// One dated equity point, and one strategy's metrics, as served.
export interface ServedEquityPoint {
  date: string;
  value: number;
}
export interface ServedBacktestMetrics {
  final_value: number | null;
  cagr: number | null;
  cagr_in_sample: number | null;
  cagr_out_sample: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  transitions: number;
  n_days: number;
  start_date: string;
  end_date: string;
  equity_curve: ServedEquityPoint[];
}

export interface RegimeSnapshot {
  date: string;
  composite: number | null;
  compositePercentile: number | null;
  regime: string | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  macroIndex?: number | null;
  onchainIndex?: number | null;
  factorIndex?: number | null;
  macroPercentile?: number | null;
  onchainPercentile?: number | null;
  factorPercentile?: number | null;
  panelWeights?: Record<string, Record<string, number> | string | null> | null;
  version?: string | null;
  source?: AnalyticsProvenance | null;
  percentiles: Record<string, number>;
  // Rich per-indicator objects on the asof row; [] on historical rows.
  indicators: RegimeIndicator[] | Record<string, unknown>;
  // Asof-only blobs: null on historical rows.
  backtest?: Record<string, Record<string, ServedBacktestMetrics>> | null;
  correlations?: CorrelationsPayload | null;
  panels?: string[] | null;
  bucketThresholds?: { risk_off: number; risk_on: number } | null;
  extras?: Record<string, ServedEquityPoint[]> | null;
}

// A RegimeSnapshot as it appears in the response's `history` array (issue #866a).
export type RegimeHistoryPoint = Omit<RegimeSnapshot, "backtest" | "correlations" | "indicators" | "percentiles">;

// Postgres hands numerics back as text; coerce to number|null. `null`/undefined
// stay null so the DTO's nullable panel fields are honest.
export const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function rowToSnapshot(r: any): RegimeSnapshot {
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
    source: r.source ?? null,
    percentiles: r.percentiles ?? {},
    indicators: r.indicators ?? [],
    // Dashboard-level blobs — present only on the asof/latest row (NULL on history).
    panels: r.panels ?? null,
    bucketThresholds: r.bucket_thresholds ?? null,
    backtest: r.backtest ?? null,
    correlations: r.correlations ?? null,
    extras: r.extras ?? null,
  };
}

// A history row does not need the fields that only ever carry data on the
// asof/latest row (`backtest`, `correlations`, `indicators` — the DB columns
// behind all three are NULL on every non-asof row, so this is a type-safety
// and wire-cleanliness fix more than a byte one) plus one that IS genuinely
// per-row but that no consumer reads off a history entry (`percentiles`, the
// real weight: ~510 bytes/row). Verified against every history-row field
// access in frontend/, scripts/, mcp/, evals/ and backend/.
// `computeRegimeSnapshotStaleness` reads `latest.indicators`, never a
// history row's, so dropping `indicators` here cannot affect staleness
// either way (issue #866a).
//
// Shared by BOTH producers of this DTO (fetchRegimeSnapshots over Postgres
// rows, and regime-eq-map.ts's mapEqSnapshotToDto over eq-snapshot rows) so
// the live endpoint and the Playwright stub project history identically —
// the parity this file's header promises, enforced by construction rather
// than by two call sites staying in sync by hand.
export function forHistory(s: RegimeSnapshot): RegimeHistoryPoint {
  const { backtest: _backtest, correlations: _correlations, indicators: _indicators, percentiles: _percentiles, ...rest } = s;
  return rest;
}

// ─── Freshness / staleness ───────────────────────────────────────────────────
// The regime pipeline forward-fills its date axis to `asof=today` on EVERY run
// (analytics/index.ts) REGARDLESS of whether the underlying indicator sources
// actually produced a new observation — a symbol whose upstream feed silently
// stopped updating still gets carried forward under today's date. So the
// snapshot's own `date` column can NEVER be used to detect staleness (issue
// #398): it reads "fresh" indefinitely as long as the pipeline job keeps
// running on schedule, even when the real data it's forward-filling from is
// frozen. The symptom is otherwise silent because the frontend faithfully
// renders whatever history[] it receives.
//
// The fix: derive freshness from the REAL observation dates already carried on
// each rich per-indicator object (`indicators[].raw_date`, `indicators[].panel`
// — report/indicator-rows.ts buildRichIndicators, sourced from the persisted
// `raw_indicator_history` floor), never from the row's own `date`/write time.
// This mirrors the `stale:true` honesty convention already used by
// token-metrics / wallet-balances, so the API and UI can flag it loudly
// instead of serving frozen data as current.
//
// Threshold: 3 days. Daily EOD data can legitimately be 1 day old (today's close
// not yet settled) and up to ~2 over a weekend; >3 days means no real
// observation has landed.
export const REGIME_STALE_THRESHOLD_DAYS = 3;

export interface RegimeStaleness {
  asof: string | null; // the gating REAL observation date (see overallObservationDate) — NEVER the pipeline's forward-filled snapshot `date`, YYYY-MM-DD
  serverDate: string; // the "today" (UTC) the age was measured against
  ageDays: number | null; // whole days from asof → serverDate; null when no data
  stale: boolean; // ageDays == null (no data) OR ageDays > thresholdDays
  thresholdDays: number;
  // Per-panel newest REAL raw observation date, so a `stale` verdict is
  // explainable (issue #398 AC2) without the caller re-deriving it from the
  // full `indicators` array. Empty `{}` for callers that don't provide
  // per-indicator data (e.g. a bare asof string via computeRegimeStaleness).
  panelObservationDates: Record<string, string | null>;
}

// Pure: given a gating observation date and the server's "today" (both
// YYYY-MM-DD, UTC), classify freshness. No data at all is treated as stale (a
// deployment serving zero real observations is not fresh). Unparseable dates
// → stale. `panelObservationDates` is passed through as-is (defaults to `{}`)
// so panel-aware callers (computeRegimeSnapshotStaleness) can attach the
// explanatory per-panel breakdown while non-panel callers (e.g. the research
// pipeline run-freshness check in api/routes/admin.ts, which has a single
// `asof` and no panel concept) are unaffected.
export function computeRegimeStaleness(
  asof: string | null,
  serverDate: string,
  thresholdDays: number = REGIME_STALE_THRESHOLD_DAYS,
  panelObservationDates: Record<string, string | null> = {},
): RegimeStaleness {
  if (!asof) return { asof: null, serverDate, ageDays: null, stale: true, thresholdDays, panelObservationDates };
  const a = Date.parse(`${asof}T00:00:00Z`);
  const t = Date.parse(`${serverDate}T00:00:00Z`);
  const ageDays =
    Number.isFinite(a) && Number.isFinite(t) ? Math.round((t - a) / 86_400_000) : null;
  const stale = ageDays == null || ageDays > thresholdDays;
  return { asof, serverDate, ageDays, stale, thresholdDays, panelObservationDates };
}

function isIsoDateString(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Per-panel newest REAL raw observation date, derived from the asof
// snapshot's rich `indicators` array (each `{panel, raw_date, ...}`). An
// indicator with a missing/invalid `raw_date` never counts toward its panel's
// freshness — fail-closed, it can't make a panel look fresher than the real
// data backing it. `indicators` is `unknown` because it comes straight off a
// Postgres jsonb column / a bare HTTP response body, not a trusted type.
export function panelObservationDates(indicators: unknown): Record<string, string | null> {
  const byPanel: Record<string, string | null> = {};
  if (!Array.isArray(indicators)) return byPanel;
  for (const raw of indicators) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const ind = raw as Record<string, unknown>;
    const panel = typeof ind.panel === "string" ? ind.panel : null;
    if (!panel) continue;
    if (!(panel in byPanel)) byPanel[panel] = null;
    if (isIsoDateString(ind.raw_date)) {
      const d = ind.raw_date;
      const cur = byPanel[panel];
      if (cur == null || d > cur) byPanel[panel] = d;
    }
  }
  return byPanel;
}

// The single date that gates OVERALL regime freshness: the OLDEST of each
// panel's newest real observation. Deliberately NOT the newest date found
// anywhere — picking the freshest date across all panels would let one
// panel's silently-frozen data source hide behind another panel that's still
// updating, which is exactly the failure mode issue #398 exists to catch. A
// panel with zero valid observation dates (empty indicators / all
// missing-or-invalid raw_date) fails the whole snapshot closed by forcing the
// gating date to null (→ stale, see computeRegimeStaleness).
export function overallObservationDate(byPanel: Record<string, string | null>): string | null {
  const dates = Object.values(byPanel);
  if (dates.length === 0) return null;
  let min: string | null = null;
  for (const d of dates) {
    if (d == null) return null; // any panel missing a real observation date fails closed
    if (min == null || d < min) min = d;
  }
  return min;
}

// Regime-snapshot-specific staleness: derives the gating `asof` from the asof
// row's rich `indicators` (max real raw_date per panel, oldest-panel-wins
// overall) instead of accepting a pre-computed date. This is what
// fetchRegimeSnapshots / the admin overview call, replacing the old
// `computeRegimeStaleness(snapshotRow.date, today)` call that measured the
// pipeline's forward-filled write date instead of real observations.
export function computeRegimeSnapshotStaleness(
  indicators: unknown,
  serverDate: string,
  thresholdDays: number = REGIME_STALE_THRESHOLD_DAYS,
): RegimeStaleness {
  const byPanel = panelObservationDates(indicators);
  const asof = overallObservationDate(byPanel);
  return computeRegimeStaleness(asof, serverDate, thresholdDays, byPanel);
}

// The pure part of GET /api/dashboards/regime-snapshots: `full` is the served
// window, oldest first. `latest` keeps every field except backtest, which the
// caller opts into (issue #866b); history rows are projected via forHistory
// (issue #866a), so `latest` and `history[-1]` are separate objects.
export function shapeRegimeSnapshots(
  full: readonly RegimeSnapshot[],
  serverDate: string,
  includeBacktest = false,
): { latest: RegimeSnapshot | null; history: RegimeHistoryPoint[]; staleness: RegimeStaleness } {
  const latestFull = full.length ? full[full.length - 1]! : null;
  const staleness = computeRegimeSnapshotStaleness(latestFull?.indicators ?? null, serverDate);
  const latest = latestFull && !includeBacktest ? { ...latestFull, backtest: null } : latestFull;
  return { latest, history: full.map(forHistory), staleness };
}

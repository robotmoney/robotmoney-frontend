// The parity sweep as it ran before issue 1375: load both sides of a domain
// into this process and compare them in JavaScript. Kept as the TEST ORACLE
// for the set-based SQL in src/analytics/cutover/parity.ts, which must reach
// the same verdict, row counts and mismatching keys on the same database
// (tests/analytics-parity-sql-equivalence.test.ts). Never imported by src/:
// on a production-sized database this is what took the api to 5.9 GiB.
//
// The comparison rules are unchanged from the code it replaces; read
// src/analytics/cutover/parity.ts for why each one exists (settled as-of days,
// the per-source tolerance, the 0059 brief boundary).
import { sql, type DbHandle } from "../../src/db/client.ts";
import { canonicalStringify } from "../../src/analytics/run-ledger.ts";
import { rawIndicatorSourceKey, withinTolerance } from "../../src/analytics/source-tolerance.ts";
import { ledgerCurrentRawIndicatorHistory } from "../../src/analytics/cutover/ledger-current.ts";
import type { ParityDomain } from "../../src/analytics/cutover/parity-domains.ts";

export interface OracleResult {
  domain: ParityDomain;
  legacyRowCount: number;
  ledgerRowCount: number;
  matched: boolean;
  /** Every mismatching natural key (not capped), sorted. A regime row that differs names its differing columns. */
  mismatches: { naturalKey: string; reason: string; columns?: string[] }[];
}

// The compatibility tables' own semantics, replayed from the ledger: every
// artifact in run order, the last write winning on the natural key. This is
// what the parity sweep compares the tables with. It is NOT what readers are
// served since issue 1182 (D83): ledger-current.ts selects each day's
// publication instead.
async function artifactsInRunOrder(db: DbHandle, kind: string): Promise<unknown[][]> {
  const rows = (await db`
    SELECT payload_bytes FROM analytics_output_snapshots WHERE artifact_kind = ${kind} ORDER BY run_id, id`) as unknown as { payload_bytes: Buffer }[];
  return rows.map((r) => {
    const parsed = JSON.parse(Buffer.from(r.payload_bytes).toString("utf8"));
    return Array.isArray(parsed) ? parsed : [];
  });
}

export async function replayLatestRegimeSnapshots(db: DbHandle = sql): Promise<{ date: string; composite: number | null; regime: string | null }[]> {
  const byDate = new Map<string, { date: string; composite: number | null; regime: string | null }>();
  for (const artifact of await artifactsInRunOrder(db, "regime_snapshots")) {
    for (const r of artifact as { date: string; composite: number | null; regime: string | null }[]) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function replayLatestResearchSignals(db: DbHandle = sql): Promise<{ signalKey: string; date: string; payload: unknown }[]> {
  const byKey = new Map<string, { signalKey: string; date: string; payload: unknown }>();
  for (const artifact of await artifactsInRunOrder(db, "research_signals")) {
    for (const s of artifact as { key: string; date: string; payload: unknown }[]) {
      byKey.set(`${s.key}\u0000${s.date}`, { signalKey: s.key, date: s.date, payload: s.payload });
    }
  }
  return [...byKey.values()];
}

function canonicalNumber(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function compare(
  domain: ParityDomain,
  legacy: Map<string, Record<string, unknown>>,
  ledger: Map<string, Record<string, unknown>>,
  namesColumns = false,
): OracleResult {
  const mismatches: OracleResult["mismatches"] = [];
  for (const [key, legacyRow] of legacy) {
    const ledgerRow = ledger.get(key);
    if (ledgerRow === undefined) {
      mismatches.push({ naturalKey: key, reason: "present in compatibility table, missing from ledger" });
    } else if (canonicalStringify(legacyRow) !== canonicalStringify(ledgerRow)) {
      const reason = "canonical value differs between compatibility and ledger";
      const columns = Object.keys(legacyRow).filter((c) => canonicalStringify(legacyRow[c]) !== canonicalStringify(ledgerRow[c])).sort();
      mismatches.push(namesColumns ? { naturalKey: key, reason, columns } : { naturalKey: key, reason });
    }
  }
  for (const key of ledger.keys()) {
    if (!legacy.has(key)) mismatches.push({ naturalKey: key, reason: "present in ledger, missing from compatibility table" });
  }
  mismatches.sort((a, b) => (a.naturalKey < b.naturalKey ? -1 : a.naturalKey > b.naturalKey ? 1 : 0));
  return { domain, legacyRowCount: legacy.size, ledgerRowCount: ledger.size, matched: mismatches.length === 0, mismatches };
}

async function settledAsofDates(db: DbHandle): Promise<Set<string>> {
  const rows = (await db`SELECT DISTINCT asof::text AS asof FROM analytics_report_snapshots`) as unknown as { asof: string }[];
  return new Set(rows.map((r) => r.asof));
}

async function rawIndicatorHistory(db: DbHandle): Promise<OracleResult> {
  const legacyRows = (await db`
    SELECT indicator, date::text AS date, value FROM raw_indicator_history ORDER BY indicator, date`) as unknown as {
    indicator: string; date: string; value: number;
  }[];
  const ledgerPoints = await ledgerCurrentRawIndicatorHistory(db);
  const legacyValue = new Map<string, number>();
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) {
    const k = `${r.indicator}\u0000${r.date}`;
    legacyValue.set(k, Number(r.value));
    legacy.set(k, { indicator: r.indicator, date: r.date, value: canonicalNumber(Number(r.value)) });
  }
  const ledger = new Map<string, Record<string, unknown>>();
  for (const p of ledgerPoints) {
    const k = `${p.indicator}\u0000${p.date}`;
    const compat = legacyValue.get(k);
    const same = compat !== undefined && withinTolerance(rawIndicatorSourceKey(p.indicator), compat, p.value);
    ledger.set(k, { indicator: p.indicator, date: p.date, value: canonicalNumber(same ? compat : p.value) });
  }
  return compare("raw_indicator_history", legacy, ledger);
}

// Every persisted regime_snapshots column, keyed by column name, from either
// side (issue 1182, folded-in 995): numbers rounded at 1e-9, a NULL
// percentiles or indicators as {} or [].
const REGIME_NUMBERS = {
  composite: "composite", composite_percentile: "compositePercentile",
  macro_index: "macroIndex", onchain_index: "onchainIndex", factor_index: "factorIndex",
  macro_percentile: "macroPercentile", onchain_percentile: "onchainPercentile", factor_percentile: "factorPercentile",
} as const;
const REGIME_VALUES = {
  regime: "regime", macro_regime: "macroRegime", onchain_regime: "onchainRegime", factor_regime: "factorRegime",
  version: "version", source: "source",
  panel_weights: "panelWeights", panels: "panels", bucket_thresholds: "bucketThresholds",
  backtest: "backtest", correlations: "correlations", extras: "extras",
} as const;

function canonicalRegimeRow(get: (column: string, key: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(REGIME_NUMBERS)) {
    const v = get(column, key);
    out[column] = v == null ? null : canonicalNumber(Number(v));
  }
  for (const [column, key] of Object.entries(REGIME_VALUES)) out[column] = get(column, key) ?? null;
  out.percentiles = get("percentiles", "percentiles") ?? {};
  out.indicators = get("indicators", "indicators") ?? [];
  return out;
}

async function regimeSnapshots(db: DbHandle): Promise<OracleResult> {
  const settled = await settledAsofDates(db);
  const legacyRows = (await db`SELECT *, date::text AS day FROM regime_snapshots ORDER BY 1`) as unknown as Record<string, unknown>[];
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) {
    const date = r.day as string;
    if (!settled.has(date)) continue;
    legacy.set(date, canonicalRegimeRow((column) => r[column]));
  }
  const ledger = new Map<string, Record<string, unknown>>();
  for (const r of await replayLatestRegimeSnapshots(db)) {
    if (!settled.has(r.date)) continue;
    ledger.set(r.date, canonicalRegimeRow((_column, key) => (r as unknown as Record<string, unknown>)[key]));
  }
  return compare("regime_snapshots", legacy, ledger, true);
}

async function researchSignals(db: DbHandle): Promise<OracleResult> {
  const settled = await settledAsofDates(db);
  const legacyRows = (await db`SELECT signal_key, date::text AS date, payload FROM research_signals ORDER BY signal_key, date`) as unknown as {
    signal_key: string; date: string; payload: unknown;
  }[];
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) {
    if (!settled.has(r.date)) continue;
    legacy.set(`${r.signal_key} ${r.date}`, { signalKey: r.signal_key, date: r.date, payload: r.payload });
  }
  const ledger = new Map<string, Record<string, unknown>>();
  for (const r of await replayLatestResearchSignals(db)) {
    if (!settled.has(r.date)) continue;
    ledger.set(`${r.signalKey} ${r.date}`, { signalKey: r.signalKey, date: r.date, payload: r.payload });
  }
  return compare("research_signals", legacy, ledger);
}

async function swarmBriefs(db: DbHandle): Promise<OracleResult> {
  const boundary = (await db`
    SELECT EXTRACT(EPOCH FROM applied_at) AS applied_epoch FROM schema_migrations
     WHERE name = '0059_analytics_output_and_report_snapshots.sql'`) as unknown as { applied_epoch: string }[];
  if (boundary.length === 0) return compare("swarm_briefs", new Map(), new Map());
  const fromMs = Math.round(Number(boundary[0]!.applied_epoch) * 1000);
  const legacyRows = (await db`
    SELECT session_id, body, EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms
      FROM swarm_briefs WHERE session_id IS NOT NULL`) as unknown as { session_id: string; body: unknown; created_ms: string }[];
  const legacy = new Map<string, Record<string, unknown>>();
  const preLedger = new Set<string>();
  for (const r of legacyRows) {
    if (Number(r.created_ms) < fromMs) {
      preLedger.add(r.session_id);
      continue;
    }
    legacy.set(r.session_id, { sessionId: r.session_id, body: r.body });
  }
  const ledgerRows = (await db`
    SELECT DISTINCT ON (session_id) session_id, body_bytes FROM swarm_brief_revisions
     ORDER BY session_id, revision DESC`) as unknown as { session_id: string; body_bytes: Buffer }[];
  const ledger = new Map<string, Record<string, unknown>>();
  for (const row of ledgerRows) {
    if (preLedger.has(row.session_id)) continue;
    ledger.set(row.session_id, { sessionId: row.session_id, body: JSON.parse(row.body_bytes.toString("utf8")) });
  }
  return compare("swarm_briefs", legacy, ledger);
}

/** Today's in-process verdict for one domain, every mismatching key included. */
export async function oracleDomainParity(domain: ParityDomain, db: DbHandle = sql): Promise<OracleResult> {
  switch (domain) {
    case "raw_indicator_history":
      return rawIndicatorHistory(db);
    case "regime_snapshots":
      return regimeSnapshots(db);
    case "research_signals":
      return researchSignals(db);
    case "swarm_briefs":
      return swarmBriefs(db);
  }
}

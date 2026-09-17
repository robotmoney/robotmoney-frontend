// Issue #979 AC1: dual-write parity checking. Compares each compatibility
// current-view table against its ledger-derived reconstruction
// (ledger-current.ts) on natural keys, canonical values, row counts, and a
// content checksum — then records the result as an immutable
// analytics_parity_observations row, which is what the cutover gate
// (gate.ts) later reads.
import { sql, type DbHandle } from "../../db/client.ts";
import { canonicalStringify, sha256Hex } from "../run-ledger.ts";
import {
  ledgerCurrentRawIndicatorHistory,
  ledgerCurrentRegimeSnapshots,
  ledgerCurrentResearchSignals,
} from "./ledger-current.ts";

export type ParityDomain = "raw_indicator_history" | "regime_snapshots" | "research_signals" | "swarm_briefs";

export interface ParityResult {
  domain: ParityDomain;
  legacyRowCount: number;
  ledgerRowCount: number;
  legacyChecksum: string;
  ledgerChecksum: string;
  matched: boolean;
  // Bounded (never the whole dataset): the first mismatching natural keys,
  // for a human or a test assertion to read directly rather than re-deriving
  // from two opaque checksums.
  mismatches: { naturalKey: string; reason: string }[];
}

const MAX_MISMATCH_DETAIL = 20;

// Canonical rounding for a floating-point value before it enters a checksum:
// Postgres `double precision` and JS `number` can differ in their last bit for
// values that were never meant to diverge (e.g. a value round-tripped through
// text at any point), and this check exists to catch REAL divergence, not
// float representation noise. 1e-9 is far tighter than anything this repo's
// analytics ever treats as materially different.
function canonicalNumber(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function checksumOf(rows: readonly Record<string, unknown>[]): string {
  return sha256Hex(canonicalStringify(rows));
}

// Issue #979 fix: close the mid-run false-mismatch race. In the issue #978
// architecture, a regime_snapshots/research_signals current-view row and its
// ledger freeze are written by ONE transaction (submitTerminalRunPackage →
// applyCurrentProjections, output-snapshot-store.ts's insertOutputSnapshots),
// so the live producer has no split window — but compat-only rows whose date
// was never frozen still exist out-of-band (the v0-seed archive,
// db/import-regime-eq.ts, a legacy/smoke subject). The two reads
// checkRegimeSnapshotsParity/checkResearchSignalsParity take are not one
// consistent snapshot — no transaction isolation level fixes that, since
// out-of-band content and its reconciliation genuinely arrive at different
// times — so a sweep landing in that window would legitimately see the fresh
// compat row and no ledger counterpart yet, and record a spurious
// matched:false. Because analytics_parity_observations is append-only
// (migration 0060) and evaluateCutoverGate treats ANY matched:false in its
// whole history as a permanent blocker, that one transient collision would
// permanently prevent cutover.
//
// The fix: a given calendar date is only safe to compare once a terminal run
// package has ACTUALLY been frozen for it (analytics_report_snapshots holds
// one row per run, keyed by that run's own `asof`) — the same "skip an
// in-flight day" idea producer/index.ts's own catch-up window already applies
// ("today is never included — the normal cron owns today"), expressed here as
// an exact settledness check rather than a blind calendar-day skip. An
// in-flight date is invisible to the comparison on EITHER side until it
// settles; once settled, a genuine, persistent divergence is compared and
// still blocks cutover exactly as AC2 requires — this only ever REMOVES a
// transient false positive, never a real one.
async function settledAsofDates(db: DbHandle): Promise<Set<string>> {
  const rows = (await db`SELECT DISTINCT asof::text AS asof FROM analytics_report_snapshots`) as unknown as { asof: string }[];
  return new Set(rows.map((r) => r.asof));
}

function compareSets(
  legacy: Map<string, Record<string, unknown>>,
  ledger: Map<string, Record<string, unknown>>,
): { naturalKey: string; reason: string }[] {
  const mismatches: { naturalKey: string; reason: string }[] = [];
  for (const [key, legacyRow] of legacy) {
    if (mismatches.length >= MAX_MISMATCH_DETAIL) break;
    const ledgerRow = ledger.get(key);
    if (ledgerRow === undefined) {
      mismatches.push({ naturalKey: key, reason: "present in compatibility table, missing from ledger" });
    } else if (canonicalStringify(legacyRow) !== canonicalStringify(ledgerRow)) {
      mismatches.push({ naturalKey: key, reason: "canonical value differs between compatibility and ledger" });
    }
  }
  for (const key of ledger.keys()) {
    if (mismatches.length >= MAX_MISMATCH_DETAIL) break;
    if (!legacy.has(key)) mismatches.push({ naturalKey: key, reason: "present in ledger, missing from compatibility table" });
  }
  return mismatches;
}

function buildResult(
  domain: ParityDomain,
  legacy: Map<string, Record<string, unknown>>,
  ledger: Map<string, Record<string, unknown>>,
): ParityResult {
  const legacyRows = [...legacy.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  const ledgerRows = [...ledger.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  const mismatches = compareSets(legacy, ledger);
  return {
    domain,
    legacyRowCount: legacy.size,
    ledgerRowCount: ledger.size,
    legacyChecksum: checksumOf(legacyRows),
    ledgerChecksum: checksumOf(ledgerRows),
    matched: mismatches.length === 0,
    mismatches,
  };
}

// The natural key raw_indicator_history is keyed on, joined by a NUL so no
// indicator id or date can ever forge another pair's key.
function rawKey(indicator: string, date: string): string {
  return `${indicator}\u0000${date}`;
}

// Issue #979 AC3 fix: `source` is a field of the raw-history DTO, so it is a
// field of raw-history parity.
//
// raw_indicator_history.source (#397) and source_value_versions.provenance
// (migration 0061) are the same field in the two models, and
// GET /api/admin/research/raw-series/:indicator returns whichever model is
// armed. While `source` was left out of the canonical row below, a fully green
// observation window could green-light a cutover that silently changed that
// field for every point — exactly the failure 0061 exists to prevent, and
// invisible to the gate that is supposed to prevent it.
//
// THE SCOPE. `provenance` did not exist before 0061, so every ledger version
// recorded before that migration ran is NULL and — source_value_versions being
// append-only — permanently so. That NULL-against-a-real-'live'/'seed' label
// difference on historical rows is an ACCEPTED product cost (old rows lose the
// label, new ones keep it), not a regression, and comparing those rows would
// park the gate permanently red on history alone. So `source` joins the
// canonical row for exactly those natural keys whose CURRENT ledger version
// was recorded at or after 0061's `applied_at`, and is absent from BOTH sides
// otherwise.
//
// WHY THAT CANNOT HIDE A REAL REGRESSION. The exemption is decided by WHEN the
// current version was written, never by what it says:
//   * a writer that stops stamping provenance still lands a post-0061 version
//     — NULL against a legacy 'live'/'seed' — which is in scope and mismatches;
//   * a writer that stamps the WRONG label (the producer catch-up's
//     'live'-vs-'seed' bug) is in scope and mismatches;
//   * any later write to an exempt key appends a NEW current version, which is
//     post-0061 and therefore in scope — an exempt row cannot stay exempt once
//     anything writes to it again.
// The only uncompared keys are ones no code has written since before the
// column existed, and for those the legacy label is information the ledger
// provably never recorded. knowledge_time cannot be backdated into the exempt
// window either: 0057 declares it `NOT NULL DEFAULT clock_timestamp()` and no
// writer names the column.
const PROVENANCE_MIGRATION = "0061_source_value_provenance.sql";

async function provenanceComparableFromMs(db: DbHandle): Promise<number | null> {
  const rows = (await db`
    SELECT EXTRACT(EPOCH FROM applied_at) AS applied_epoch
    FROM schema_migrations WHERE name = ${PROVENANCE_MIGRATION}
  `) as unknown as { applied_epoch: string | number }[];
  if (rows.length === 0) return null; // 0061 unapplied here: the column cannot exist
  return Math.round(Number(rows[0]!.applied_epoch) * 1000);
}

export async function checkRawIndicatorHistoryParity(db: DbHandle = sql): Promise<ParityResult> {
  // ONE statement for the compatibility side. loadRawIndicatorHistory() plus a
  // second read for `source` could straddle the orchestrator's whole-floor
  // rewrite (analytics/index.ts's saveRawHistory) and record a spurious — and,
  // because analytics_parity_observations is append-only, PERMANENT —
  // matched:false.
  const legacyRows = (await db`
    SELECT indicator, date::text AS date, value, source
    FROM raw_indicator_history
    ORDER BY indicator, date`) as unknown as {
    indicator: string;
    date: string;
    value: number;
    source: string | null;
  }[];
  const ledgerPoints = await ledgerCurrentRawIndicatorHistory(db);
  const comparableFromMs = await provenanceComparableFromMs(db);
  const comparableSource = new Set<string>();
  if (comparableFromMs !== null) {
    for (const p of ledgerPoints) {
      if (p.knowledgeTimeEpochMs >= comparableFromMs) comparableSource.add(rawKey(p.indicator, p.date));
    }
  }
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) {
    const k = rawKey(r.indicator, r.date);
    legacy.set(k, {
      indicator: r.indicator,
      date: r.date,
      value: canonicalNumber(Number(r.value)),
      ...(comparableSource.has(k) ? { source: r.source ?? null } : {}),
    });
  }
  const ledger = new Map<string, Record<string, unknown>>();
  for (const p of ledgerPoints) {
    const k = rawKey(p.indicator, p.date);
    ledger.set(k, {
      indicator: p.indicator,
      date: p.date,
      value: canonicalNumber(p.value),
      ...(comparableSource.has(k) ? { source: p.source } : {}),
    });
  }
  return buildResult("raw_indicator_history", legacy, ledger);
}

export async function checkRegimeSnapshotsParity(db: DbHandle = sql): Promise<ParityResult> {
  const settled = await settledAsofDates(db);
  const legacyRows = (await db`SELECT date::text AS date, composite, regime FROM regime_snapshots ORDER BY date`) as unknown as {
    date: string;
    composite: string | number | null;
    regime: string | null;
  }[];
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) {
    if (!settled.has(r.date)) continue; // in-flight day — see settledAsofDates
    legacy.set(r.date, { date: r.date, composite: r.composite == null ? null : canonicalNumber(Number(r.composite)), regime: r.regime });
  }
  const ledgerRows = await ledgerCurrentRegimeSnapshots(db);
  const ledger = new Map<string, Record<string, unknown>>();
  for (const r of ledgerRows) {
    if (!settled.has(r.date)) continue; // symmetric with the legacy filter above
    ledger.set(r.date, { date: r.date, composite: r.composite == null ? null : canonicalNumber(r.composite), regime: r.regime });
  }
  return buildResult("regime_snapshots", legacy, ledger);
}

export async function checkResearchSignalsParity(db: DbHandle = sql): Promise<ParityResult> {
  const settled = await settledAsofDates(db);
  const legacyRows = (await db`SELECT signal_key, date::text AS date, payload FROM research_signals ORDER BY signal_key, date`) as unknown as {
    signal_key: string;
    date: string;
    payload: unknown;
  }[];
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) {
    if (!settled.has(r.date)) continue; // in-flight day - see settledAsofDates
    legacy.set(`${r.signal_key} ${r.date}`, { signalKey: r.signal_key, date: r.date, payload: r.payload });
  }
  const ledgerRows = await ledgerCurrentResearchSignals(db);
  const ledger = new Map<string, Record<string, unknown>>();
  for (const r of ledgerRows) {
    if (!settled.has(r.date)) continue; // symmetric with the legacy filter above
    ledger.set(`${r.signalKey} ${r.date}`, { signalKey: r.signalKey, date: r.date, payload: r.payload });
  }
  return buildResult("research_signals", legacy, ledger);
}

export async function checkSwarmBriefsParity(db: DbHandle = sql): Promise<ParityResult> {
  const legacyRows = (await db`SELECT session_id, body FROM swarm_briefs WHERE session_id IS NOT NULL`) as unknown as {
    session_id: string;
    body: unknown;
  }[];
  const legacy = new Map<string, Record<string, unknown>>();
  for (const r of legacyRows) legacy.set(r.session_id, { sessionId: r.session_id, body: r.body });
  const ledgerRows = (await db`
    SELECT DISTINCT session_id FROM swarm_brief_revisions
  `) as unknown as { session_id: string }[];
  const ledger = new Map<string, Record<string, unknown>>();
  for (const row of ledgerRows) {
    const [rev] = (await db`
      SELECT body_bytes FROM swarm_brief_revisions WHERE session_id = ${row.session_id} ORDER BY revision DESC LIMIT 1
    `) as unknown as { body_bytes: Buffer }[];
    if (!rev) continue;
    ledger.set(row.session_id, { sessionId: row.session_id, body: JSON.parse(rev.body_bytes.toString("utf8")) });
  }
  return buildResult("swarm_briefs", legacy, ledger);
}

export const ALL_PARITY_DOMAINS: readonly ParityDomain[] = [
  "raw_indicator_history",
  "regime_snapshots",
  "research_signals",
  "swarm_briefs",
];

export async function checkDomainParity(domain: ParityDomain, db: DbHandle = sql): Promise<ParityResult> {
  switch (domain) {
    case "raw_indicator_history":
      return checkRawIndicatorHistoryParity(db);
    case "regime_snapshots":
      return checkRegimeSnapshotsParity(db);
    case "research_signals":
      return checkResearchSignalsParity(db);
    case "swarm_briefs":
      return checkSwarmBriefsParity(db);
  }
}

// Record a parity check as immutable evidence. Every observation is a NEW
// row — analytics_parity_observations refuses UPDATE/DELETE/TRUNCATE
// (migration 0060) — so a re-check after fixing a mismatch is a fresh,
// separately-timestamped data point, never an edit of the failed one.
export async function recordParityObservation(result: ParityResult, db: DbHandle = sql): Promise<string> {
  const [row] = (await db`
    INSERT INTO analytics_parity_observations
      (domain, legacy_row_count, ledger_row_count, legacy_checksum, ledger_checksum, matched, detail)
    VALUES (${result.domain}, ${result.legacyRowCount}, ${result.ledgerRowCount},
            ${result.legacyChecksum}, ${result.ledgerChecksum}, ${result.matched},
            ${db.json(({ mismatches: result.mismatches } as unknown) as never)})
    RETURNING id
  `) as unknown as { id: string }[];
  return String(row!.id);
}

// Run every domain's check and record each as an observation — the single
// call site a cron/worker tick or a test uses to add one "tick" to the
// cutover gate's observation window.
export async function runParitySweep(db: DbHandle = sql): Promise<ParityResult[]> {
  const results: ParityResult[] = [];
  for (const domain of ALL_PARITY_DOMAINS) {
    const result = await checkDomainParity(domain, db);
    await recordParityObservation(result, db);
    results.push(result);
  }
  return results;
}

// Issue #979: reconstruct each compatibility current-view table's content
// PURELY from the immutable Phase A ledger tables built by #976/#977/#978 —
// never by reading the compatibility table itself. This is the "ledger mode"
// half of every dual-write parity check and, once cutover is armed
// (analytics_read_mode = 'ledger'), the actual data source for production
// reads (see report/projections.ts, api/routes/admin.ts, swarm/domain.ts).
//
// THE RECONSTRUCTION RULE, uniform across all three analytics domains: replay
// every ledger write IN THE SAME ORDER the compatibility writer applied it,
// upserting into an in-memory map on the same natural key the real table is
// keyed on. This exactly reproduces "last write wins" — the semantics
// raw-history/regime/research's `ON CONFLICT ... DO UPDATE` upserts encode —
// without assuming any single ledger row already holds the full table (a
// regime run resubmits the whole recomputed history; a research run may
// submit only the signals it recomputed that day; both replay correctly here).
import { sql, type DbHandle } from "../../db/client.ts";
import type { RegimeSnapshotRow } from "../report/regime-projection.ts";
import type { ResearchPayload } from "../analyze/research.ts";
import { on, registerQuery } from "../../db/registry.ts";

// Registered queries (smoke-production-spec.md §7.1), all reads of the
// immutable ledgers. Reached from the analytics parity sweep, the admin
// analytics reads, the dashboards' ledger-mode projections and a brief's
// ledger-mode body on the public swarm route.
const SAMPLE_SESSION = "00000000-0000-0000-0000-000000000000";

const rawHistoryHeads = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:ledgerCurrentRawIndicatorHistory",
  purpose: "Read the head version of every raw-indicator point from the source-value ledger, for the parity sweep.",
  callers: ["src/api/routes/analytics"],
  probe: {
    statement: `SELECT svv.source_key, svv.market_date::text AS market_date, svv.value, svv.provenance,
             EXTRACT(EPOCH FROM svv.knowledge_time) AS knowledge_epoch
      FROM source_value_versions svv
      WHERE svv.source_key LIKE $1 AND svv.market_date IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM source_value_versions nxt WHERE nxt.prior_version_id = svv.id)`,
    params: ["raw_indicator_history:%"],
  },
});

const rawSeriesHeads = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:ledgerCurrentRawIndicatorSeries",
  purpose: "Read one indicator's head versions, newest first, for the admin series read in ledger mode.",
  callers: ["src/api/routes/admin"],
  probe: {
    statement: `SELECT svv.market_date::text AS market_date, svv.value, svv.provenance FROM source_value_versions svv
      WHERE svv.source_key = $1 AND svv.market_date IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM source_value_versions nxt WHERE nxt.prior_version_id = svv.id)
      ORDER BY svv.market_date DESC`,
    params: ["raw_indicator_history:probe"],
  },
});

const regimeArtifacts = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:ledgerCurrentRegimeSnapshots",
  purpose: "Read every regime-snapshot artifact in run order, to replay the regime table from the ledger.",
  callers: ["src/api/routes/analytics", "src/api/routes/dashboards"],
  probe: {
    statement: `SELECT aos.payload_bytes FROM analytics_output_snapshots aos
      WHERE aos.artifact_kind = 'regime_snapshots' ORDER BY aos.run_id ASC`,
  },
});

const researchArtifacts = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:ledgerCurrentResearchSignals",
  purpose: "Read every research-signal artifact in run order, to replay the research table from the ledger.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics", "src/api/routes/dashboards"],
  probe: {
    statement: `SELECT aos.payload_bytes FROM analytics_output_snapshots aos
      WHERE aos.artifact_kind = 'research_signals' ORDER BY aos.run_id ASC`,
  },
});

const briefRevision = registerQuery({
  role: "rm_app",
  object: "swarm_brief_revisions",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:ledgerCurrentBriefBySession.revision",
  purpose: "Read a session brief's newest ledger revision, for a brief served in ledger mode.",
  callers: ["src/api/routes/swarm"],
  probe: {
    statement: `SELECT body_bytes, report_snapshot_id::text AS report_snapshot_id, created_at FROM swarm_brief_revisions
      WHERE session_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
    params: [SAMPLE_SESSION],
  },
});

const briefSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:ledgerCurrentBriefBySession.session",
  purpose: "Read the brief's session date and subject, which the ledger revision does not carry.",
  callers: ["src/api/routes/swarm"],
  probe: {
    statement: "SELECT date::text AS date, subject_id FROM swarm_sessions WHERE id = $1::uuid",
    params: [SAMPLE_SESSION],
  },
});

export interface LedgerRawIndicatorPoint {
  indicator: string;
  date: string;
  value: number;
  // The ledger's own copy of raw_indicator_history.source — migration 0061's
  // `provenance` column, written at acquisition time. NULL is the honest "no
  // label was observed", which is permanent for 0057's legacy baselines and
  // for every version recorded before 0061 existed (append-only).
  source: string | null;
  // When THIS version was physically recorded. source_value_versions never
  // accepts a client-supplied knowledge_time — 0057 declares it
  // `NOT NULL DEFAULT clock_timestamp()` and no writer names the column — so
  // it cannot be backdated. cutover/parity.ts uses it to tell a version that
  // could never have carried a label from one that could and did not.
  knowledgeTimeEpochMs: number;
}

// source_value_versions is ITSELF the append-only chain each revision points
// backward from (prior_version_id); the "current" row per (source_key,
// market_date) is the one no later row supersedes — i.e. it is not any
// row's `prior_version_id`. This is a structural read, not a replay, because
// the ledger already stores the chain rather than a flat log of writes.
//
// `source_key` for a raw-history point is always `raw_indicator_history:<indicator>`
// (see migration 0057's backfill and analytics/source-ledger.ts's writer) —
// stripped back off here so the natural key matches raw_indicator_history's
// own (indicator, date).
const RAW_HISTORY_PREFIX = "raw_indicator_history:";

export async function ledgerCurrentRawIndicatorHistory(
  db: DbHandle = sql,
): Promise<LedgerRawIndicatorPoint[]> {
  const rows = await on(db, rawHistoryHeads)<{
    source_key: string;
    market_date: string;
    value: number;
    provenance: string | null;
    knowledge_epoch: string | number;
  }>`
    SELECT svv.source_key, svv.market_date::text AS market_date, svv.value, svv.provenance,
           EXTRACT(EPOCH FROM svv.knowledge_time) AS knowledge_epoch
    FROM source_value_versions svv
    WHERE svv.source_key LIKE ${RAW_HISTORY_PREFIX + "%"}
      AND svv.market_date IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM source_value_versions nxt WHERE nxt.prior_version_id = svv.id
      )
  `;
  return rows.map((r) => ({
    indicator: r.source_key.slice(RAW_HISTORY_PREFIX.length),
    date: r.market_date,
    value: Number(r.value),
    source: r.provenance ?? null,
    // Seconds (postgres returns numeric, i.e. a string through postgres.js)
    // to integer milliseconds — a plain number comparison, never a timestamp
    // string whose rendering depends on the session TimeZone.
    knowledgeTimeEpochMs: Math.round(Number(r.knowledge_epoch) * 1000),
  }));
}

// One point for a single (indicator, date) — the shape admin's raw-series
// read and the dashboards' summary reads actually need, without loading the
// entire floor to answer one lookup.
//
// `source` is the ledger's own `provenance` column (migration 0061), NOT a
// read of raw_indicator_history — so admin's raw-series DTO carries the same
// field in both read modes. It is null for the two populations the append-only
// ledger can never label after the fact: 0057's legacy baselines, and any row
// written before 0061 existed.
export async function ledgerCurrentRawIndicatorSeries(
  indicator: string,
  db: DbHandle = sql,
): Promise<{ date: string; value: number; source: string | null }[]> {
  const rows = await on(db, rawSeriesHeads)<{ market_date: string; value: number; provenance: string | null }>`
    SELECT svv.market_date::text AS market_date, svv.value, svv.provenance
    FROM source_value_versions svv
    WHERE svv.source_key = ${RAW_HISTORY_PREFIX + indicator}
      AND svv.market_date IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM source_value_versions nxt WHERE nxt.prior_version_id = svv.id
      )
    ORDER BY svv.market_date DESC
  `;
  return rows.map((r) => ({ date: r.market_date, value: Number(r.value), source: r.provenance ?? null }));
}

// Decode one analytics_output_snapshots payload back into the array it was
// built from (output-snapshots.ts's canonicalArtifactBytes is a plain
// canonical JSON.stringify, so JSON.parse is the exact inverse).
function decodeArtifact<T>(bytes: Buffer | Uint8Array): T[] {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : Buffer.from(bytes).toString("utf8");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

// Replay every regime_snapshots artifact ever frozen, in run order, upserting
// on `date` — reproducing saveRegimeSnapshots' own ON CONFLICT (date) DO
// UPDATE semantics from the immutable ledger alone.
export async function ledgerCurrentRegimeSnapshots(db: DbHandle = sql): Promise<RegimeSnapshotRow[]> {
  const rows = await on(db, regimeArtifacts)<{ payload_bytes: Buffer }>`
    SELECT aos.payload_bytes
    FROM analytics_output_snapshots aos
    WHERE aos.artifact_kind = 'regime_snapshots'
    ORDER BY aos.run_id ASC
  `;
  const byDate = new Map<string, RegimeSnapshotRow>();
  for (const row of rows) {
    for (const snapshot of decodeArtifact<RegimeSnapshotRow>(row.payload_bytes)) {
      byDate.set(snapshot.date, snapshot);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface LedgerResearchSignalRow {
  signalKey: string;
  date: string;
  payload: ResearchPayload;
}

// Replay every research_signals artifact ever frozen, in run order, upserting
// on (signal_key, date) — reproducing persistResearchSignal's own
// ON CONFLICT (signal_key, date) DO UPDATE semantics from the ledger alone.
export async function ledgerCurrentResearchSignals(db: DbHandle = sql): Promise<LedgerResearchSignalRow[]> {
  const rows = await on(db, researchArtifacts)<{ payload_bytes: Buffer }>`
    SELECT aos.payload_bytes
    FROM analytics_output_snapshots aos
    WHERE aos.artifact_kind = 'research_signals'
    ORDER BY aos.run_id ASC
  `;
  const byKeyDate = new Map<string, LedgerResearchSignalRow>();
  for (const row of rows) {
    for (const signal of decodeArtifact<{ key: string; date: string; payload: ResearchPayload }>(row.payload_bytes)) {
      byKeyDate.set(`${signal.key}\u0000${signal.date}`, { signalKey: signal.key, date: signal.date, payload: signal.payload });
    }
  }
  return [...byKeyDate.values()].sort((a, b) =>
    a.signalKey === b.signalKey ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.signalKey < b.signalKey ? -1 : 1,
  );
}

// The latest (by date) ledger-derived signal for one key — the ledger-mode
// equivalent of report/projections.ts's fetchLatestResearchSignal.
export async function ledgerCurrentLatestResearchSignal(
  key: string,
  db: DbHandle = sql,
): Promise<LedgerResearchSignalRow | null> {
  const all = await ledgerCurrentResearchSignals(db);
  const forKey = all.filter((r) => r.signalKey === key);
  if (forKey.length === 0) return null;
  return forKey.reduce((latest, r) => (r.date > latest.date ? r : latest));
}

export interface LedgerBrief {
  sessionId: string;
  date: string;
  subjectId: string;
  body: Record<string, unknown> | null;
  reportSnapshotId: string | null;
  createdAt: string;
}

// The newest swarm_brief_revisions row for a session, decoded — the
// ledger-derived equivalent of swarm/domain.ts's getBriefBySession. `date` and
// `subjectId` are read from swarm_sessions (itself append-only, migration
// 0032/0056's protected set), never from swarm_briefs — the only field this
// function takes from the mutable current-view table at all is the one it has
// no ledger source for: the brief's own auto-increment id, which is an
// opaque handle, not history.
export async function ledgerCurrentBriefBySession(sessionId: string, db: DbHandle = sql): Promise<LedgerBrief | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const [revision] = await on(db, briefRevision)<{ body_bytes: Buffer; report_snapshot_id: string | null; created_at: Date }>`
    SELECT body_bytes, report_snapshot_id::text AS report_snapshot_id, created_at
    FROM swarm_brief_revisions
    WHERE session_id = ${sessionId}
    ORDER BY revision DESC LIMIT 1
  `;
  if (!revision) return null;
  const [session] = await on(db, briefSession)<{ date: string; subject_id: string }>`
    SELECT date::text AS date, subject_id FROM swarm_sessions WHERE id = ${sessionId}
  `;
  if (!session) return null;
  const bodyText = revision.body_bytes.toString("utf8");
  return {
    sessionId,
    date: session.date,
    subjectId: session.subject_id,
    body: JSON.parse(bodyText) as Record<string, unknown>,
    reportSnapshotId: revision.report_snapshot_id,
    createdAt: revision.created_at instanceof Date ? revision.created_at.toISOString() : String(revision.created_at),
  };
}

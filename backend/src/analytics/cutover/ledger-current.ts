// Issue #979: reconstruct each compatibility current-view table's content
// PURELY from the immutable Phase A ledger tables built by #976/#977/#978 —
// never by reading the compatibility table itself. This is the "ledger mode"
// half of every dual-write parity check and, once cutover is armed
// (analytics_read_mode = 'ledger'), the actual data source for production
// reads (see report/projections.ts, api/routes/admin.ts, swarm/domain.ts).
//
// THE RECONSTRUCTION RULE. Raw history and briefs: the head of each ledger
// chain, the value the compatibility table holds. Regime and research: the
// PUBLISHED figure of each day (issue 1182, decision D83), never a later run's
// recomputation, selected here at read time from the frozen artifacts. No
// migration is involved: analytics_output_snapshots already holds every run's
// output, and nothing is rewritten.
//
//   - Day D's publication is the D row of the last artifact WRITTEN during D
//     (UTC) that carries it. While D is today, each new run replaces it; once D
//     is over, nothing written later does.
//   - A day nothing published during the day is published by the FIRST
//     artifact written after it that carries it (a late run, or a replay of
//     issue 1162), and frozen from then on. The run's source_label plays no
//     part.
//   - Regime only: from the ledger start (the as-of day of the first regime
//     artifact that carries rows) a day is published only by a run's own as-of
//     row, so a day no run with that as-of day published is a gap. Days before
//     the ledger start are served from that first artifact, as they were served
//     when the ledger began.
//
// The compatibility tables are NOT held to this rule: their writers still
// upsert the newest run's rows (last write wins), and the parity sweep
// (parity.ts) still compares them with that replay. Readers are served the
// selection below in both read modes (report/projections.ts).
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

// The published-figure reads (issue 1182, D83). Each selects from artifact
// METADATA first (run, as-of day, the UTC day it was written, the checksum
// and, migration 0123, the natural keys), so a request parses only the
// payloads that publish something it has not already cached.
const READ_CALLERS = ["src/api/routes/admin", "src/api/routes/analytics", "src/api/routes/dashboards", "src/api/routes/swarm"];

const REGIME_INDEX_PROBE = {
  statement: `SELECT aos.id::text AS id, aos.run_id::text AS run_id, aos.checksum, r.asof::text AS asof,
           ((aos.created_at AT TIME ZONE 'UTC')::date)::text AS written_on
      FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
     WHERE aos.artifact_kind = 'regime_snapshots'
     ORDER BY aos.run_id, aos.id`,
};

const regimeIndex = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:regimeArtifactIndex",
  purpose: "List every regime artifact with its run, as-of day and the UTC day it was written, without reading a payload, to select each day's publication.",
  callers: READ_CALLERS,
  probe: REGIME_INDEX_PROBE,
});

const regimeIndexRuns = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:regimeArtifactIndex.runs",
  purpose: "Read each regime artifact's run as-of day, which decides the day it publishes.",
  callers: READ_CALLERS,
  probe: REGIME_INDEX_PROBE,
});

const REGIME_CARRIES_PROBE = {
  statement: `SELECT aos.id::text AS id, aos.natural_keys @> ARRAY[r.asof::text] AS carries
      FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
     WHERE aos.id = ANY(string_to_array($1, ',')::bigint[])`,
  params: ["1,2"],
};

const regimeCarries = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:regimeArtifactCarries",
  purpose: "Read from a regime artifact's natural keys (migration 0123) whether it carries its own as-of row, once per artifact, without parsing its payload.",
  callers: READ_CALLERS,
  probe: REGIME_CARRIES_PROBE,
});

const regimeCarriesRuns = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:regimeArtifactCarries.runs",
  purpose: "Read the regime artifact's run as-of day, the row it must carry to publish that day.",
  callers: READ_CALLERS,
  probe: REGIME_CARRIES_PROBE,
});

const regimeBefore = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:regimeDaysBeforeLedgerStart",
  purpose: "List from the first regime artifact's natural keys the days before the ledger start it carries, once, without parsing its payload.",
  callers: READ_CALLERS,
  probe: {
    statement: `SELECT coalesce(array_agg(k.day ORDER BY k.day) FILTER (WHERE k.day IS NOT NULL), '{}') AS before, bool_or(aos.natural_keys IS NULL) AS unindexed
      FROM analytics_output_snapshots aos LEFT JOIN LATERAL unnest(aos.natural_keys) AS k(day) ON k.day < $2
     WHERE aos.id = $1::bigint`,
    params: [1, "2026-01-01"],
  },
});

const artifactPayload = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:artifactPayload",
  purpose: "Read one frozen artifact's payload, only when it publishes a row not already cached.",
  callers: READ_CALLERS,
  probe: { statement: "SELECT aos.payload_bytes FROM analytics_output_snapshots aos WHERE aos.id = $1::bigint", params: [1] },
});

const researchIndex = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/ledger-current:researchArtifactIndex",
  purpose: "List every research artifact's natural keys (signal, day) and the UTC day it was written, without reading a payload, to select each signal-day's publication.",
  callers: READ_CALLERS,
  probe: {
    statement: `SELECT aos.id::text AS id, aos.run_id::text AS run_id, aos.checksum,
           ((aos.created_at AT TIME ZONE 'UTC')::date)::text AS written_on, aos.natural_keys
      FROM analytics_output_snapshots aos
     WHERE aos.artifact_kind = 'research_signals'
     ORDER BY aos.run_id, aos.id`,
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

async function loadArtifact<T>(db: DbHandle, id: string): Promise<T[]> {
  const [row] = await on(db, artifactPayload)<{ payload_bytes: Buffer }>`SELECT aos.payload_bytes FROM analytics_output_snapshots aos WHERE aos.id = ${id}::bigint`;
  return row ? decodeArtifact<T>(row.payload_bytes) : [];
}

// ── Which artifact publishes a natural key (issue 1182, D83) ────────────────

/** One frozen artifact's claim to publish one natural key (a regime day, or a signal's day). */
export interface PublicationCandidate {
  /** The natural key: a regime day, or `<signal>\u0000<day>`. */
  key: string;
  /** The day it is a figure for (YYYY-MM-DD). */
  date: string;
  runId: number;
  artifactId: number;
  /** The UTC day the artifact was written (analytics_output_snapshots.created_at). */
  writtenOn: string;
}

/**
 * THE RULE (D83), pure: for each key, the last candidate written during its
 * day (by run, then artifact); when none was, the first written after it.
 */
export function selectPublications<T extends PublicationCandidate>(candidates: Iterable<T>): Map<string, T> {
  const chosen = new Map<string, T>();
  for (const c of candidates) {
    const held = chosen.get(c.key);
    if (!held || publishesOver(c, held)) chosen.set(c.key, c);
  }
  return chosen;
}

function publishesOver(a: PublicationCandidate, b: PublicationCandidate): boolean {
  const aDuring = a.writtenOn <= a.date;
  const bDuring = b.writtenOn <= b.date;
  if (aDuring !== bDuring) return aDuring;
  const order = a.runId - b.runId || a.artifactId - b.artifactId;
  return aDuring ? order > 0 : order < 0;
}

// ── The cache ───────────────────────────────────────────────────────────────
// Every fact cached here is about an immutable artifact (keyed by its sha256
// checksum, so a test database that reuses ids cannot alias it), never about
// the selection: each request re-reads the artifact metadata and selects
// again, so a run written since the last request, or a day a late run has
// just published, is seen at once. What is saved is the payload parsing.
// Rows are kept only while the selection still serves them, so the cache
// holds about one row per published day and does not grow with every run.
interface PublicationCache {
  /** `${checksum}|${asof}` → whether the artifact carries its as-of row. */
  regimeCarries: Map<string, boolean>;
  /** `${checksum}|${asof}` → the days before `asof` the artifact carries (asked of the first artifact only). */
  regimeBefore: Map<string, string[]>;
  /** `${checksum}|${date}|${lean}` → the row. */
  regimeRows: Map<string, RegimeSnapshotRow>;
  /** `${checksum}` → (key, date) pairs, for a research artifact whose natural_keys is NULL. */
  researchKeys: Map<string, { key: string; date: string }[]>;
  /** signal key → its latest publication's `${checksum}|${date}` and payload. */
  researchLatest: Map<string, { at: string; payload: ResearchPayload }>;
}

const caches = new WeakMap<object, PublicationCache>();

function cacheFor(db: DbHandle): PublicationCache {
  let cache = caches.get(db);
  if (!cache) {
    cache = { regimeCarries: new Map(), regimeBefore: new Map(), regimeRows: new Map(), researchKeys: new Map(), researchLatest: new Map() };
    caches.set(db, cache);
  }
  return cache;
}

// ── Regime ──────────────────────────────────────────────────────────────────

interface RegimeArtifact extends PublicationCandidate {
  checksum: string;
}

interface RegimePublications {
  /** The artifact the days before the ledger start are served from, and those days. */
  first: RegimeArtifact;
  before: string[];
  /** From the ledger start: each published day's artifact. */
  byDate: Map<string, RegimeArtifact>;
}

async function regimePublications(db: DbHandle): Promise<RegimePublications | null> {
  const cache = cacheFor(db);
  const index = await on(db, regimeIndex, regimeIndexRuns)<{ id: string; run_id: string; checksum: string; asof: string; written_on: string }>`SELECT aos.id::text AS id, aos.run_id::text AS run_id, aos.checksum, r.asof::text AS asof,
           ((aos.created_at AT TIME ZONE 'UTC')::date)::text AS written_on
      FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
     WHERE aos.artifact_kind = 'regime_snapshots'
     ORDER BY aos.run_id, aos.id`;
  const shapeKey = (r: { checksum: string; asof: string }) => `${r.checksum}|${r.asof}`;
  const unknown = index.filter((r) => !cache.regimeCarries.has(shapeKey(r)));
  for (let i = 0; i < unknown.length; i += 500) {
    const chunk = unknown.slice(i, i + 500);
    const shapes = await on(db, regimeCarries, regimeCarriesRuns)<{ id: string; carries: boolean | null }>`SELECT aos.id::text AS id, aos.natural_keys @> ARRAY[r.asof::text] AS carries
      FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
     WHERE aos.id = ANY(string_to_array(${chunk.map((r) => r.id).join(",")}, ',')::bigint[])`;
    const carries = new Map(shapes.map((s) => [s.id, s.carries]));
    for (const r of chunk) {
      const known = carries.get(r.id);
      // natural_keys is NULL (a payload Postgres could not index): an absent
      // index never means "publishes nothing", so the payload itself decides.
      const value = known ?? (await artifactDates(db, r.id)).includes(r.asof);
      cache.regimeCarries.set(shapeKey(r), value);
    }
  }
  const carrying: RegimeArtifact[] = index
    .filter((r) => cache.regimeCarries.get(shapeKey(r)))
    .map((r) => ({ key: r.asof, date: r.asof, runId: Number(r.run_id), artifactId: Number(r.id), writtenOn: r.written_on, checksum: r.checksum }));
  const first = carrying[0];
  if (!first) return null;
  const firstKey = shapeKey({ checksum: first.checksum, asof: first.date });
  let before = cache.regimeBefore.get(firstKey);
  if (!before) {
    const [row] = await on(db, regimeBefore)<{ before: string[] | null; unindexed: boolean | null }>`SELECT coalesce(array_agg(k.day ORDER BY k.day) FILTER (WHERE k.day IS NOT NULL), '{}') AS before, bool_or(aos.natural_keys IS NULL) AS unindexed
      FROM analytics_output_snapshots aos LEFT JOIN LATERAL unnest(aos.natural_keys) AS k(day) ON k.day < ${first.date}
     WHERE aos.id = ${first.artifactId}::bigint`;
    before = row?.unindexed
      ? (await artifactDates(db, String(first.artifactId))).filter((d) => d < first.date).sort()
      : (row?.before ?? []);
    cache.regimeBefore.set(firstKey, before);
  }
  return { first, before, byDate: selectPublications(carrying.filter((a) => a.date >= first.date)) };
}

async function artifactDates(db: DbHandle, id: string): Promise<string[]> {
  return [...new Set((await loadArtifact<{ date?: unknown }>(db, id)).map((e) => String(e.date)))];
}

// The asof-only blobs a history point never carries (regime-projection.ts
// forHistory); a lean row drops them before it is cached.
const HEAVY_FIELDS = ["backtest", "correlations", "indicators", "percentiles"] as const;

function lean(row: RegimeSnapshotRow): RegimeSnapshotRow {
  const out = { ...row } as Record<string, unknown>;
  for (const f of HEAVY_FIELDS) delete out[f];
  out.percentiles = {};
  out.indicators = [];
  return out as unknown as RegimeSnapshotRow;
}

/** The rows `wanted` (date → full?) from the publications, parsing each artifact at most once. */
async function regimeRows(
  db: DbHandle,
  pubs: RegimePublications,
  wanted: { date: string; full: boolean }[],
  keep: Map<string, RegimeSnapshotRow> | null,
): Promise<RegimeSnapshotRow[]> {
  const cache = cacheFor(db);
  const sourceOf = (date: string) => (date < pubs.first.date ? pubs.first : pubs.byDate.get(date)!);
  const rowKey = (w: { date: string; full: boolean }) => `${sourceOf(w.date).checksum}|${w.date}|${w.full ? "full" : "lean"}`;
  const missing = new Map<string, { artifact: RegimeArtifact; dates: Set<string> }>();
  for (const w of wanted) {
    if (cache.regimeRows.has(rowKey(w))) continue;
    const artifact = sourceOf(w.date);
    const entry = missing.get(artifact.checksum) ?? { artifact, dates: new Set<string>() };
    entry.dates.add(w.date);
    missing.set(artifact.checksum, entry);
  }
  const parsed = new Map<string, RegimeSnapshotRow>();
  for (const { artifact, dates } of missing.values()) {
    for (const row of await loadArtifact<RegimeSnapshotRow>(db, String(artifact.artifactId))) {
      if (dates.has(row.date)) parsed.set(`${artifact.checksum}|${row.date}`, row); // the last element for a date wins, as in the writer
    }
  }
  const out: RegimeSnapshotRow[] = [];
  for (const w of wanted) {
    const key = rowKey(w);
    let row = cache.regimeRows.get(key);
    if (!row) {
      const full = parsed.get(`${sourceOf(w.date).checksum}|${w.date}`);
      if (!full) continue;
      row = w.full ? full : lean(full);
    }
    keep?.set(key, row);
    out.push(row);
  }
  return out;
}

function publishedDays(pubs: RegimePublications): string[] {
  return [...pubs.before, ...pubs.byDate.keys()].sort();
}

/**
 * Every published regime day (D83), as a sorted list of dates: the days
 * before the ledger start and, from it, each day a run's own as-of row
 * published. A gap is absent. Reads no payload once the artifacts are known.
 */
export async function ledgerPublishedRegimeDays(db: DbHandle = sql): Promise<string[]> {
  const pubs = await regimePublications(db);
  return pubs ? publishedDays(pubs) : [];
}

/**
 * Every day's PUBLISHED regime row (D83), full, from the ledger alone. For
 * audits and tests; the endpoint reads ledgerPublishedRegimeHistory, which
 * caches and leaves the heavy blobs off past days.
 */
export async function ledgerCurrentRegimeSnapshots(db: DbHandle = sql): Promise<RegimeSnapshotRow[]> {
  const pubs = await regimePublications(db);
  if (!pubs) return [];
  return regimeRows(db, pubs, publishedDays(pubs).map((date) => ({ date, full: true })), null);
}

const inFlight = new WeakMap<object, { today: string; work: Promise<RegimeSnapshotRow[] | null> }>();

/**
 * The served regime history (D83): every published day up to `today`, oldest
 * first. The newest is the full row; the others are lean (no backtest,
 * correlations, indicators or percentiles: a history point never carries
 * them). null when the ledger holds no regime publication at all, so the
 * caller can fall back to the compatibility table on a database no run has
 * written. Cached across requests (see PublicationCache).
 */
export function ledgerPublishedRegimeHistory(today: string, db: DbHandle = sql): Promise<RegimeSnapshotRow[] | null> {
  // Single flight: a request that arrives while the same read is running
  // shares its answer, so concurrent first requests after a deploy parse the
  // payloads once, not once each.
  const running = inFlight.get(db);
  if (running && running.today === today) return running.work;
  const work = (async () => {
    const pubs = await regimePublications(db);
    if (!pubs) return null;
    const days = publishedDays(pubs).filter((d) => d <= today);
    const keep = new Map<string, RegimeSnapshotRow>();
    const rows = await regimeRows(db, pubs, days.map((date, i) => ({ date, full: i === days.length - 1 })), keep);
    cacheFor(db).regimeRows = keep;
    return rows;
  })().finally(() => {
    if (inFlight.get(db)?.work === work) inFlight.delete(db);
  });
  inFlight.set(db, { today, work });
  return work;
}

// ── Research ────────────────────────────────────────────────────────────────

export interface LedgerResearchSignalRow {
  signalKey: string;
  date: string;
  payload: ResearchPayload;
}

interface ResearchCandidate extends PublicationCandidate {
  checksum: string;
  signalKey: string;
}

/** Each (signal, day)'s publishing artifact (D83), from the natural keys; `onlyKey` narrows to one signal. */
async function researchPublications(db: DbHandle, onlyKey?: string): Promise<Map<string, ResearchCandidate>> {
  const cache = cacheFor(db);
  const index = await on(db, researchIndex)<{ id: string; run_id: string; checksum: string; written_on: string; natural_keys: string[] | null }>`SELECT aos.id::text AS id, aos.run_id::text AS run_id, aos.checksum,
           ((aos.created_at AT TIME ZONE 'UTC')::date)::text AS written_on, aos.natural_keys
      FROM analytics_output_snapshots aos
     WHERE aos.artifact_kind = 'research_signals'
     ORDER BY aos.run_id, aos.id`;
  const candidates: ResearchCandidate[] = [];
  for (const r of index) {
    let pairs: { key: string; date: string }[];
    if (r.natural_keys) {
      // Migration 0123's token: date, signal key, payload hash (chr 31 between).
      pairs = r.natural_keys.map((t) => {
        const [date, key] = t.split("\u001f");
        return { key: key!, date: date! };
      });
    } else {
      // A NULL index never means "publishes nothing": read the payload.
      pairs = cache.researchKeys.get(r.checksum) ?? (await loadArtifact<{ key: string; date: string }>(db, r.id)).map((s) => ({ key: s.key, date: s.date }));
      cache.researchKeys.set(r.checksum, pairs);
    }
    for (const p of pairs) {
      if (onlyKey !== undefined && p.key !== onlyKey) continue;
      candidates.push({
        key: `${p.key}\u0000${p.date}`, date: p.date, signalKey: p.key,
        runId: Number(r.run_id), artifactId: Number(r.id), writtenOn: r.written_on, checksum: r.checksum,
      });
    }
  }
  return selectPublications(candidates);
}

async function researchRows(db: DbHandle, chosen: ResearchCandidate[]): Promise<LedgerResearchSignalRow[]> {
  const byArtifact = new Map<number, ResearchCandidate[]>();
  for (const c of chosen) byArtifact.set(c.artifactId, [...(byArtifact.get(c.artifactId) ?? []), c]);
  const found = new Map<ResearchCandidate, ResearchPayload>();
  for (const [artifactId, wanted] of byArtifact) {
    const signals = await loadArtifact<{ key: string; date: string; payload: ResearchPayload }>(db, String(artifactId));
    for (const s of signals) {
      // The last element for a (signal, day) wins, as in the writer.
      for (const c of wanted) if (s.key === c.signalKey && s.date === c.date) found.set(c, s.payload);
    }
  }
  return chosen.filter((c) => found.has(c)).map((c) => ({ signalKey: c.signalKey, date: c.date, payload: found.get(c)! }));
}

// Every (signal, day)'s PUBLISHED payload (D83), from the ledger alone: the
// last artifact written during the day that carries it, else the first
// written after it. Never a later run's recomputation of a past day.
export async function ledgerCurrentResearchSignals(db: DbHandle = sql): Promise<LedgerResearchSignalRow[]> {
  const chosen = [...(await researchPublications(db)).values()];
  const rows = await researchRows(db, chosen);
  return rows.sort((a, b) =>
    a.signalKey === b.signalKey ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.signalKey < b.signalKey ? -1 : 1,
  );
}

// The latest (by date) published signal for one key — the read
// report/projections.ts's fetchLatestResearchSignal serves in both read
// modes. Parses at most the one artifact that publishes it.
export async function ledgerCurrentLatestResearchSignal(
  key: string,
  db: DbHandle = sql,
): Promise<LedgerResearchSignalRow | null> {
  const chosen = [...(await researchPublications(db, key)).values()];
  if (chosen.length === 0) return null;
  const latest = chosen.reduce((a, b) => (b.date > a.date ? b : a));
  // Cached per signal: the payload only changes when another artifact
  // publishes the latest day, which the selection above sees every time.
  const cache = cacheFor(db);
  const at = `${latest.checksum}|${latest.date}`;
  const held = cache.researchLatest.get(key);
  if (held?.at === at) return { signalKey: key, date: latest.date, payload: held.payload };
  const [row] = await researchRows(db, [latest]);
  if (!row) return null;
  cache.researchLatest.set(key, { at, payload: row.payload });
  return row;
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

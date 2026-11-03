// Format 1 archives served by the public API (issue 1422; decision D72).
//
// WHAT A BACKUP IS HERE. Backups are cut by format 1's cut rule
// (packages/analyst-sdk/src/archive/format1.ts, planCuts; issue 1477, D80),
// which csvb (packages/csvb) follows too. The API cannot store anything (issue
// 1422 adds no table, column or grant), so its backups are DERIVED,
// deterministically, from the append-only tables themselves:
//
//   - One backup per UTC day boundary t, named `YYYY-MM-DDT000000Z`. A backup
//     is listed and served only once it is SEALED: t is at least the settle
//     hour in the past.
//   - Per table, its watermark is the largest existing id, after the previous
//     backup's watermark, below the first row whose time column is at or after
//     t (or below nothing, when no such row exists yet). It always names a row
//     that exists, so a gap in the id sequence cannot move it when later rows
//     arrive. Vintage members are cut by vintage instead: every member of every
//     vintage at or below the vintages watermark. Every time column here
//     defaults to clock_timestamp() and no code writes one explicitly, so a row
//     inserted after t is stamped after t and gets a higher id: a sealed
//     backup's watermarks, rows, file names and bytes never change. The settle
//     hour covers a transaction that took its id before t and committed after.
//   - The legacy junction (format1-legacy.ts): the newest snapshot-time backup
//     csvb wrote before the day cut. Once the chain reaches past its id and rows
//     follow it, it is served as one extra backup between the day cuts around
//     it, with its baked watermarks as watermark_after. The next day-cut backup
//     chains from it, so a repo clone plus an API increment join there. A
//     database whose rows all predate it is cut by day alone.
//   - The files are what csvb writes for the same id ranges, through the same
//     format 1 functions: per table, the rows with ids above the previous
//     watermark up to this one, in id order, as Postgres COPY CSV text (each
//     column through its type's output function, timestamps in UTC), split into
//     parts of at most ARCHIVE_PART_BYTES uncompressed (a row is never cut),
//     each named `<table>.<start>_<end>.csv.gz` by the earliest and latest row
//     time in it, gzipped at level 9 with node:zlib. A file's identity is the
//     SHA-256 of its uncompressed bytes: the gzip is only a transport encoding,
//     and any runtime may produce any valid gzip of the same bytes.
//
// WHAT IT SERVES. The append-only tables a run's inputs and its published
// output are read from: the source data versions, the run ledger, the
// vintages and their members, the published outputs and reports, and the
// recorded revisions. Revised tables (`raw_indicator_history`, `asset_prices`,
// `regime_snapshots`) need the table's state at every earlier backup, which the
// API cannot reconstruct without storing it, so `revisions` is empty; their
// current values are on the raw-history and asset-prices routes. Neither the
// run events nor the parity observations are served: no public route exposes
// them today. Both are recorded on issue 1422 as owner decisions.
//
// HOW IT STAYS BOUNDED. A backup record needs each file's SHA-256, so it is
// built once, in the background, one backup at a time, page by page, every
// page a public read (the gate and the 5 s timeout of public-analytics-limits),
// and kept in memory. Every chain step is one statement whose reads stay inside
// the rows the backup adds, not the rows written after it: the members step
// reads only the members of the vintages above the previous backup's vintages
// watermark and at most this one's (issue 1514). That relies on the settle
// hour: a vintage's members are written in its freeze transaction, so a
// vintage at or below a sealed watermark never gains a member later. The
// first-day probe (vintages watermark 0) reads an empty range. An archive body
// is regenerated from its id range when requested, streamed through gzip as the
// pages arrive, and its SHA-256 is compared with the record at the end; a
// mismatch aborts the response rather than finish a body that differs from what
// its record names. Nothing here reads a provider or recomputes an analytics
// value: every byte comes from the committed rows.
import { createHash } from "node:crypto";
import type { Transform } from "node:stream";
import { createGzip } from "node:zlib";
import { ARCHIVE_FORMAT, ARCHIVE_PART_BYTES } from "@robotmoney/contract";
import type { TransactionSql } from "postgres";
import { on, registerQuery } from "../../db/registry.ts";
import { publicRead } from "../../api/public-analytics-limits.ts";
import {
  APPEND_ONLY_TABLES,
  BACKUP_ID_RE,
  backupInstantMs,
  DataFileNamer,
  dataPath,
  dbTimeText,
  encodeCsvRow,
  firstBoundaryMs,
  junctionApplies,
  parseDbTime,
  planCuts,
  startsNewPart,
  type Cut,
  type Junction,
  type TimeSpec,
} from "../../../../packages/analyst-sdk/src/archive/format1.ts";
import { LEGACY_JUNCTION } from "../../../../packages/analyst-sdk/src/archive/format1-legacy.ts";

const ROUTE = "src/api/routes/public-analytics";

export type { TimeSpec };
/** A served table's time, from format 1's table catalog. */
const timeOf = (name: string): TimeSpec => {
  const t = APPEND_ONLY_TABLES.find((c) => c.name === name && c.served);
  if (!t) throw new Error(`${name} is not a served table of the format 1 catalog`);
  return t.time;
};

export interface ArchiveFileRecord {
  path: string;
  rows: number;
  bytes_raw: number;
  sha256_raw: string;
  id_min: string;
  id_max: string;
  sum_id: string;
  time_min: string;
  time_max: string;
}

export interface ArchiveAppendOnlyRecord {
  time: TimeSpec;
  watermark_before: string | null;
  watermark_after: string | null;
  rows_added: number;
  files: ArchiveFileRecord[];
  db_rows_through_watermark: string;
  db_sum_id_through_watermark: string;
}

export interface ArchiveBackupRecord {
  format: 1;
  backup: string;
  source: "api";
  consistency: "paged";
  snapshot: { exported_at_db: string; replica_replay_ts: null; db_user: "api"; was_replica: false };
  tool: { name: "robotmoney-api"; commit: null };
  append_only: Record<string, ArchiveAppendOnlyRecord>;
  revisions: Record<string, never>;
}

/** A built record: its exact bytes (`backup.json`) and their SHA-256 (the ETag). */
export interface BuiltRecord {
  record: ArchiveBackupRecord;
  bytes: Uint8Array;
  sha256: string;
}

type Tx = TransactionSql<{}>;
type Row = Record<string, string | null>;

interface ChainStep {
  wm: string | null;
  first_time: string | null;
  n: string;
  s: string;
}

interface ArchiveTable {
  name: string;
  time: TimeSpec;
  /** The archive's columns, in order: the CSV header. */
  columns: readonly string[];
  /** Rows per page: a few MB per statement, well inside the 5 s timeout. */
  pageRows: number;
  /**
   * `vintages`: the vintages watermark at this boundary; `prevVintages`: the
   * previous backup's (only the members table reads them).
   */
  step(tx: Tx, after: string, boundary: string, vintages: string, prevVintages: string): Promise<ChainStep[]>;
  page(tx: Tx, after: string, through: string, limit: number): Promise<Row[]>;
}

// ── Registered queries: one chain step and one page read per table ───────────
// A chain step answers, in one statement: the watermark at a boundary (the id
// just below the first row after `after` stamped at or after `boundary`, else
// the newest id), the time of the table's first row (where the backup list
// starts), and the count and id sum of the rows the step adds. A page reads
// rows of an id range in id order, every column as text (its output function,
// which is what COPY writes for these types) plus the row's time for naming.


// source_value_versions
const SVV_STEP = `WITH b AS (
    SELECT (SELECT id FROM source_value_versions WHERE id > $1::bigint AND knowledge_time >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM source_value_versions) AS max_id,
      (SELECT knowledge_time FROM source_value_versions ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM source_value_versions x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM source_value_versions WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM source_value_versions WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const svvStep = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:source_value_versions.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: SVV_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const SVV_PAGE = `SELECT id::text AS id, knowledge_time::text AS t, id::text AS c_id, acquisition_id::text AS acquisition_id,
    source_key, market_date::text AS market_date, market_instant::text AS market_instant, value::text AS value,
    prior_version_id::text AS prior_version_id, revision_kind, knowledge_time::text AS knowledge_time, provenance
  FROM source_value_versions WHERE id > $1::bigint AND id <= $2::bigint ORDER BY source_value_versions.id LIMIT $3`;
const svvPage = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:source_value_versions.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: SVV_PAGE, params: [0, 1, 2] },
});

// analytics_ledger_runs
const RUNS_STEP = `WITH b AS (
    SELECT (SELECT id FROM analytics_ledger_runs WHERE id > $1::bigint AND created_at >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_ledger_runs) AS max_id,
      (SELECT created_at FROM analytics_ledger_runs ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_ledger_runs x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_ledger_runs WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_ledger_runs WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const runsStep = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_ledger_runs.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: RUNS_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const RUNS_PAGE = `SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_key, asof::text AS asof, tool_id, source_label,
    methodology_version_id::text AS methodology_version_id, build_identity, job_id::text AS job_id, created_at::text AS created_at
  FROM analytics_ledger_runs WHERE id > $1::bigint AND id <= $2::bigint ORDER BY analytics_ledger_runs.id LIMIT $3`;
const runsPage = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_ledger_runs.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: RUNS_PAGE, params: [0, 1, 2] },
});

// analytics_ledger_methodology_versions
const METH_STEP = `WITH b AS (
    SELECT (SELECT id FROM analytics_ledger_methodology_versions WHERE id > $1::bigint AND created_at >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_ledger_methodology_versions) AS max_id,
      (SELECT created_at FROM analytics_ledger_methodology_versions ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_ledger_methodology_versions x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_ledger_methodology_versions WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_ledger_methodology_versions WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const methStep = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_methodology_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_ledger_methodology_versions.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: METH_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const METH_PAGE = `SELECT id::text AS id, created_at::text AS t, id::text AS c_id, tool_id, version_label, config::text AS config,
    config_digest, created_at::text AS created_at
  FROM analytics_ledger_methodology_versions WHERE id > $1::bigint AND id <= $2::bigint ORDER BY analytics_ledger_methodology_versions.id LIMIT $3`;
const methPage = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_methodology_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_ledger_methodology_versions.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: METH_PAGE, params: [0, 1, 2] },
});

// analytics_data_vintages
const VIN_STEP = `WITH b AS (
    SELECT (SELECT id FROM analytics_data_vintages WHERE id > $1::bigint AND created_at >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_data_vintages) AS max_id,
      (SELECT created_at FROM analytics_data_vintages ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_data_vintages x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_data_vintages WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_data_vintages WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const vinStep = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_data_vintages.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: VIN_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const VIN_PAGE = `SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_id::text AS run_id, tool_id,
    knowledge_time_cutoff::text AS knowledge_time_cutoff, market_time_cutoff::text AS market_time_cutoff,
    methodology_version_id::text AS methodology_version_id, build_identity, manifest::text AS manifest, manifest_digest,
    member_count::text AS member_count, created_at::text AS created_at
  FROM analytics_data_vintages WHERE id > $1::bigint AND id <= $2::bigint ORDER BY analytics_data_vintages.id LIMIT $3`;
const vinPage = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_data_vintages.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: VIN_PAGE, params: [0, 1, 2] },
});

// analytics_vintage_members: no time of its own; a member's time is its vintage's created_at.
// Members are cut by vintage, not by time: a backup holds every member of every
// vintage it holds (the largest member id whose vintage is at or below the
// vintages watermark), so two freezes interleaving across midnight never split
// one vintage's members between backups.
//
// The watermark reads only the members of the vintages this backup adds:
// vintage_id above the previous backup's vintages watermark and at most this
// one, through analytics_vintage_members_vintage_idx (issue 1514). Bounded by
// `vintage_id <= watermark` alone, Postgres walked the primary key backward
// from the newest member until it met an old vintage: for an early backup that
// is almost every member, past the 5 s timeout on production. The OFFSET 0
// keeps the planner from turning max() into that walk again, and MATERIALIZED
// reads the watermark once rather than once per column that names it.
// It is the same watermark: the members of a vintage are written in the
// vintage's own freeze transaction, so once the vintages watermark of a sealed
// backup names a vintage, every member of it is committed and at or below that
// backup's members watermark; the members after it belong to later vintages.
// The two forms differ only if a freeze commits more than the settle hour after
// its vintage's created_at, which already moves every table's watermark.
const MEM_STEP = `WITH w AS MATERIALIZED (
    SELECT (SELECT max(b.id) FROM (SELECT m.id FROM analytics_vintage_members m
        WHERE m.id > $1::bigint AND m.vintage_id > $2::bigint AND m.vintage_id <= $3::bigint OFFSET 0) b) AS wm,
      (SELECT v.created_at FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id ORDER BY m.id LIMIT 1) AS first_time
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_vintage_members WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_vintage_members WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const memStep = registerQuery({
  role: "rm_app",
  object: "analytics_vintage_members",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_vintage_members.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: MEM_STEP, params: [0, 0, 0, 0, 0] },
});
const memStepVintages = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_vintage_members.step.vintages",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: MEM_STEP, params: [0, 0, 0, 0, 0] },
});
const MEM_PAGE = `SELECT m.id::text AS id, v.created_at::text AS t, m.id::text AS c_id, m.vintage_id::text AS vintage_id,
    m.source_value_version_id::text AS source_value_version_id, m.source_key,
    m.last_source_value_version_id::text AS last_source_value_version_id
  FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id
  WHERE m.id > $1::bigint AND m.id <= $2::bigint ORDER BY m.id LIMIT $3`;
const memPage = registerQuery({
  role: "rm_app",
  object: "analytics_vintage_members",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_vintage_members.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: MEM_PAGE, params: [0, 1, 2] },
});
const memPageVintages = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_vintage_members.page.vintages",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: MEM_PAGE, params: [0, 1, 2] },
});

// analytics_overwrite_events
const OVW_STEP = `WITH b AS (
    SELECT (SELECT id FROM analytics_overwrite_events WHERE id > $1::bigint AND recorded_at >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_overwrite_events) AS max_id,
      (SELECT recorded_at FROM analytics_overwrite_events ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_overwrite_events x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_overwrite_events WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_overwrite_events WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const ovwStep = registerQuery({
  role: "rm_app",
  object: "analytics_overwrite_events",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_overwrite_events.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: OVW_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const OVW_PAGE = `SELECT id::text AS id, recorded_at::text AS t, id::text AS c_id, table_name, operation, natural_key::text AS natural_key,
    previous_row::text AS previous_row, replacement_row::text AS replacement_row, recorded_at::text AS recorded_at
  FROM analytics_overwrite_events WHERE id > $1::bigint AND id <= $2::bigint ORDER BY analytics_overwrite_events.id LIMIT $3`;
const ovwPage = registerQuery({
  role: "rm_app",
  object: "analytics_overwrite_events",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_overwrite_events.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: OVW_PAGE, params: [0, 1, 2] },
});

// analytics_output_snapshots: the stored bytes decoded to text beside their SHA-256, as csvb selects them.
const OUT_STEP = `WITH b AS (
    SELECT (SELECT id FROM analytics_output_snapshots WHERE id > $1::bigint AND created_at >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_output_snapshots) AS max_id,
      (SELECT created_at FROM analytics_output_snapshots ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_output_snapshots x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_output_snapshots WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_output_snapshots WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const outStep = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_output_snapshots.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: OUT_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const OUT_PAGE = `SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_id::text AS run_id, artifact_kind, checksum,
    byte_length::text AS byte_length, created_at::text AS created_at, convert_from(payload_bytes, 'UTF8') AS payload_json,
    encode(sha256(payload_bytes), 'hex') AS payload_sha256
  FROM analytics_output_snapshots WHERE id > $1::bigint AND id <= $2::bigint ORDER BY analytics_output_snapshots.id LIMIT $3`;
const outPage = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_output_snapshots.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: OUT_PAGE, params: [0, 1, 2] },
});

// analytics_report_snapshots: the same, for the report bytes.
const REP_STEP = `WITH b AS (
    SELECT (SELECT id FROM analytics_report_snapshots WHERE id > $1::bigint AND created_at >= $2::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_report_snapshots) AS max_id,
      (SELECT created_at FROM analytics_report_snapshots ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_report_snapshots x WHERE x.id > $3::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_report_snapshots WHERE id > $4::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_report_snapshots WHERE id > $5::bigint AND id <= w.wm)::text AS s
  FROM w`;
const repStep = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_report_snapshots.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REP_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0, 0] },
});
const REP_PAGE = `SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_id::text AS run_id, asof::text AS asof, checksum,
    byte_length::text AS byte_length, created_at::text AS created_at, convert_from(report_bytes, 'UTF8') AS report_json,
    encode(sha256(report_bytes), 'hex') AS report_sha256
  FROM analytics_report_snapshots WHERE id > $1::bigint AND id <= $2::bigint ORDER BY analytics_report_snapshots.id LIMIT $3`;
const repPage = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_report_snapshots.page",
  purpose: "Read one page of a format 1 archive's rows, every column as its COPY text (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REP_PAGE, params: [0, 1, 2] },
});

// The table order of a csvb record (config.ts APPEND_ONLY), less the two not served.
export const ARCHIVE_TABLES: readonly ArchiveTable[] = [
  {
    name: "analytics_output_snapshots",
    time: timeOf("analytics_output_snapshots"),
    columns: ["id", "run_id", "artifact_kind", "checksum", "byte_length", "created_at", "payload_json", "payload_sha256"],
    pageRows: 2,
    step: (tx, a, b) => on(tx, outStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_output_snapshots WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_output_snapshots) AS max_id,
      (SELECT created_at FROM analytics_output_snapshots ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_output_snapshots x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_output_snapshots WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_output_snapshots WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, outPage)<Row>`SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_id::text AS run_id, artifact_kind, checksum,
    byte_length::text AS byte_length, created_at::text AS created_at, convert_from(payload_bytes, 'UTF8') AS payload_json,
    encode(sha256(payload_bytes), 'hex') AS payload_sha256
  FROM analytics_output_snapshots WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY analytics_output_snapshots.id LIMIT ${n}`,
  },
  {
    name: "analytics_report_snapshots",
    time: timeOf("analytics_report_snapshots"),
    columns: ["id", "run_id", "asof", "checksum", "byte_length", "created_at", "report_json", "report_sha256"],
    pageRows: 10,
    step: (tx, a, b) => on(tx, repStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_report_snapshots WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_report_snapshots) AS max_id,
      (SELECT created_at FROM analytics_report_snapshots ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_report_snapshots x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_report_snapshots WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_report_snapshots WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, repPage)<Row>`SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_id::text AS run_id, asof::text AS asof, checksum,
    byte_length::text AS byte_length, created_at::text AS created_at, convert_from(report_bytes, 'UTF8') AS report_json,
    encode(sha256(report_bytes), 'hex') AS report_sha256
  FROM analytics_report_snapshots WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY analytics_report_snapshots.id LIMIT ${n}`,
  },
  {
    name: "source_value_versions",
    time: timeOf("source_value_versions"),
    columns: ["id", "acquisition_id", "source_key", "market_date", "market_instant", "value", "prior_version_id", "revision_kind", "knowledge_time", "provenance"],
    pageRows: 20_000,
    step: (tx, a, b) => on(tx, svvStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM source_value_versions WHERE id > ${a}::bigint AND knowledge_time >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM source_value_versions) AS max_id,
      (SELECT knowledge_time FROM source_value_versions ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM source_value_versions x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM source_value_versions WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM source_value_versions WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, svvPage)<Row>`SELECT id::text AS id, knowledge_time::text AS t, id::text AS c_id, acquisition_id::text AS acquisition_id,
    source_key, market_date::text AS market_date, market_instant::text AS market_instant, value::text AS value,
    prior_version_id::text AS prior_version_id, revision_kind, knowledge_time::text AS knowledge_time, provenance
  FROM source_value_versions WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY source_value_versions.id LIMIT ${n}`,
  },
  {
    name: "analytics_ledger_runs",
    time: timeOf("analytics_ledger_runs"),
    columns: ["id", "run_key", "asof", "tool_id", "source_label", "methodology_version_id", "build_identity", "job_id", "created_at"],
    pageRows: 5000,
    step: (tx, a, b) => on(tx, runsStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_ledger_runs WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_ledger_runs) AS max_id,
      (SELECT created_at FROM analytics_ledger_runs ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_ledger_runs x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_ledger_runs WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_ledger_runs WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, runsPage)<Row>`SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_key, asof::text AS asof, tool_id, source_label,
    methodology_version_id::text AS methodology_version_id, build_identity, job_id::text AS job_id, created_at::text AS created_at
  FROM analytics_ledger_runs WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY analytics_ledger_runs.id LIMIT ${n}`,
  },
  {
    name: "analytics_ledger_methodology_versions",
    time: timeOf("analytics_ledger_methodology_versions"),
    columns: ["id", "tool_id", "version_label", "config", "config_digest", "created_at"],
    pageRows: 5000,
    step: (tx, a, b) => on(tx, methStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_ledger_methodology_versions WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_ledger_methodology_versions) AS max_id,
      (SELECT created_at FROM analytics_ledger_methodology_versions ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_ledger_methodology_versions x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_ledger_methodology_versions WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_ledger_methodology_versions WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, methPage)<Row>`SELECT id::text AS id, created_at::text AS t, id::text AS c_id, tool_id, version_label, config::text AS config,
    config_digest, created_at::text AS created_at
  FROM analytics_ledger_methodology_versions WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY analytics_ledger_methodology_versions.id LIMIT ${n}`,
  },
  {
    name: "analytics_data_vintages",
    time: timeOf("analytics_data_vintages"),
    columns: ["id", "run_id", "tool_id", "knowledge_time_cutoff", "market_time_cutoff", "methodology_version_id", "build_identity", "manifest", "manifest_digest", "member_count", "created_at"],
    pageRows: 500,
    step: (tx, a, b) => on(tx, vinStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_data_vintages WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_data_vintages) AS max_id,
      (SELECT created_at FROM analytics_data_vintages ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_data_vintages x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_data_vintages WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_data_vintages WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, vinPage)<Row>`SELECT id::text AS id, created_at::text AS t, id::text AS c_id, run_id::text AS run_id, tool_id,
    knowledge_time_cutoff::text AS knowledge_time_cutoff, market_time_cutoff::text AS market_time_cutoff,
    methodology_version_id::text AS methodology_version_id, build_identity, manifest::text AS manifest, manifest_digest,
    member_count::text AS member_count, created_at::text AS created_at
  FROM analytics_data_vintages WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY analytics_data_vintages.id LIMIT ${n}`,
  },
  {
    name: "analytics_vintage_members",
    time: timeOf("analytics_vintage_members"),
    columns: ["id", "vintage_id", "source_value_version_id", "source_key", "last_source_value_version_id"],
    pageRows: 50_000,
    step: (tx, a, _b, vin, prevVin) => on(tx, memStep, memStepVintages)<ChainStep>`WITH w AS MATERIALIZED (
    SELECT (SELECT max(b.id) FROM (SELECT m.id FROM analytics_vintage_members m
        WHERE m.id > ${a}::bigint AND m.vintage_id > ${prevVin}::bigint AND m.vintage_id <= ${vin}::bigint OFFSET 0) b) AS wm,
      (SELECT v.created_at FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id ORDER BY m.id LIMIT 1) AS first_time
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_vintage_members WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_vintage_members WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, memPage, memPageVintages)<Row>`SELECT m.id::text AS id, v.created_at::text AS t, m.id::text AS c_id, m.vintage_id::text AS vintage_id,
    m.source_value_version_id::text AS source_value_version_id, m.source_key,
    m.last_source_value_version_id::text AS last_source_value_version_id
  FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id
  WHERE m.id > ${a}::bigint AND m.id <= ${t}::bigint ORDER BY m.id LIMIT ${n}`,
  },
  {
    name: "analytics_overwrite_events",
    time: timeOf("analytics_overwrite_events"),
    columns: ["id", "table_name", "operation", "natural_key", "previous_row", "replacement_row", "recorded_at"],
    pageRows: 20,
    step: (tx, a, b) => on(tx, ovwStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_overwrite_events WHERE id > ${a}::bigint AND recorded_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_overwrite_events) AS max_id,
      (SELECT recorded_at FROM analytics_overwrite_events ORDER BY id LIMIT 1) AS first_time
  ), w AS (
    SELECT (SELECT max(x.id) FROM analytics_overwrite_events x WHERE x.id > ${a}::bigint AND x.id < COALESCE(b.next_id, b.max_id + 1)) AS wm, b.first_time FROM b
  )
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_overwrite_events WHERE id > ${a}::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_overwrite_events WHERE id > ${a}::bigint AND id <= w.wm)::text AS s
  FROM w`,
    page: (tx, a, t, n) => on(tx, ovwPage)<Row>`SELECT id::text AS id, recorded_at::text AS t, id::text AS c_id, table_name, operation, natural_key::text AS natural_key,
    previous_row::text AS previous_row, replacement_row::text AS replacement_row, recorded_at::text AS recorded_at
  FROM analytics_overwrite_events WHERE id > ${a}::bigint AND id <= ${t}::bigint ORDER BY analytics_overwrite_events.id LIMIT ${n}`,
  },
];

const tableByName = new Map(ARCHIVE_TABLES.map((t) => [t.name, t]));

// Names, CSV text, part splitting and the cut rule are format 1's own, defined
// once in packages/analyst-sdk/src/archive/format1.ts and shared with csvb
// (issue 1477). The route reads the id shape from here.
export { BACKUP_ID_RE };

// ── The clock, the junction, and the chain of watermarks ─────────────────────

let clock: () => number = () => Date.now();
let partBytes = ARCHIVE_PART_BYTES;
let junction: Junction = LEGACY_JUNCTION;
/** Replace the part size (tests split a small backup into several parts). */
export function _setArchivePartBytesForTests(bytes: number | null): void {
  partBytes = bytes ?? ARCHIVE_PART_BYTES;
}
/** Replace the clock (tests seal backups without waiting a day). */
export function _setArchiveClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}
/**
 * Plant a synthetic legacy junction (tests only: never production watermarks).
 * Null restores the baked one. Forgets every built record and watermark.
 */
export function _setArchiveJunctionForTests(j: Junction | null): void {
  junction = j ?? LEGACY_JUNCTION;
  _resetArchiveForTests();
}

interface TableMark {
  wm: string | null;
  rows: bigint;
  sum: bigint;
}

/** Watermarks per sealed backup, with the backup before it. Sealed cuts never change, so this only grows. */
const chain = new Map<string, { prev: string | null; marks: Map<string, TableMark> }>();
let firstDayMs: number | null = null;
let rowsFollowJunction: boolean | null = null;
let chainBusy: Promise<void> | null = null;

/** The first backup boundary: the UTC midnight after the earliest first row of any served table. */
async function loadFirstDay(): Promise<number | null> {
  if (firstDayMs !== null) return firstDayMs;
  let earliest: bigint | null = null;
  await publicRead(async (tx) => {
    for (const t of ARCHIVE_TABLES) {
      const [r] = await t.step(tx, "0", "0001-01-01T00:00:00Z", "0", "0");
      if (r?.first_time) {
        const us = parseDbTime(r.first_time);
        if (earliest === null || us < earliest) earliest = us;
      }
    }
  }, 4000);
  if (earliest === null) return null;
  firstDayMs = firstBoundaryMs(earliest);
  return firstDayMs;
}

/** Does any served table hold an id above its junction watermark? Asked once, when the chain reaches past the junction. */
async function loadRowsFollowJunction(): Promise<boolean> {
  if (rowsFollowJunction !== null) return rowsFollowJunction;
  let follow = false;
  await publicRead(async (tx) => {
    for (const t of ARCHIVE_TABLES) {
      const wm = junction.watermarks[t.name];
      if (wm === undefined) throw new Error(`the archive junction ${junction.id} names no watermark for ${t.name}`);
      // A boundary no row reaches: the step's watermark is the newest id above wm, or none.
      // Members above the junction belong to vintages above the junction's vintages watermark.
      const [r] = await t.step(tx, wm, "9999-12-31T00:00:00Z", "9223372036854775807", junction.watermarks.analytics_data_vintages ?? "0");
      if (r?.wm) follow = true;
    }
  }, 4000);
  rowsFollowJunction = follow;
  return follow;
}

/** The sealed cut points, oldest first (format 1's cut rule, with the junction when it applies). */
async function sealedCuts(): Promise<Cut[]> {
  const first = await loadFirstDay();
  const now = clock();
  const follow = first !== null && junctionApplies(junction, now, true) ? await loadRowsFollowJunction() : false;
  return planCuts({ firstDayMs: first, nowMs: now, junction, rowsFollowJunction: follow });
}

/** Every sealed backup id, oldest first. */
export async function listBackupIds(): Promise<string[]> {
  return (await sealedCuts()).map((c) => c.id);
}

/** One day cut: each table's step, one bounded public read. */
async function dayMarks(before: Map<string, TableMark> | null, boundaryMs: number): Promise<Map<string, TableMark>> {
  const marks = new Map<string, TableMark>();
  await publicRead(async (tx) => {
    for (const t of ARCHIVE_TABLES) {
      const p = before?.get(t.name) ?? { wm: null, rows: 0n, sum: 0n };
      const [r] = await t.step(
        tx,
        p.wm ?? "0",
        new Date(boundaryMs).toISOString(),
        marks.get("analytics_data_vintages")?.wm ?? "0",
        before?.get("analytics_data_vintages")?.wm ?? "0",
      );
      const wm = r?.wm ?? p.wm;
      marks.set(t.name, { wm, rows: p.rows + BigInt(r?.n ?? "0"), sum: p.sum + BigInt(r?.s ?? "0") });
    }
  }, 4000);
  return marks;
}

/** The junction cut: its baked watermarks, with the rows it adds counted page by page. */
async function junctionMarks(before: Map<string, TableMark> | null, watermarks: Readonly<Record<string, string>>): Promise<Map<string, TableMark>> {
  const marks = new Map<string, TableMark>();
  for (const t of ARCHIVE_TABLES) {
    const p = before?.get(t.name) ?? { wm: null, rows: 0n, sum: 0n };
    const wm = watermarks[t.name];
    if (wm === undefined) throw new Error(`the archive junction names no watermark for ${t.name}`);
    if (p.wm !== null && BigInt(wm) < BigInt(p.wm)) throw new Error(`${t.name}: the junction watermark ${wm} is below the preceding backup's ${p.wm}`);
    let rows = p.rows;
    let sum = p.sum;
    if (wm !== p.wm) {
      for await (const r of rowsOf(t, p.wm ?? "0", wm)) {
        rows += 1n;
        sum += BigInt(r.id);
      }
    }
    marks.set(t.name, { wm, rows, sum });
  }
  return marks;
}

/** Fill the chain through `id`, one cut at a time, each step a bounded public read. */
async function ensureChain(id: string): Promise<void> {
  while (!chain.has(id)) {
    if (chainBusy) {
      await chainBusy;
      continue;
    }
    chainBusy = (async () => {
      const cuts = await sealedCuts();
      const target = cuts.findIndex((c) => c.id === id);
      if (target < 0) throw new Error(`${id} is not a sealed backup`);
      let prev: Map<string, TableMark> | null = null;
      for (let i = 0; i <= target; i++) {
        const c = cuts[i]!;
        const have = chain.get(c.id);
        if (have) {
          prev = have.marks;
          continue;
        }
        const marks: Map<string, TableMark> = c.kind === "day" ? await dayMarks(prev, c.boundaryMs) : await junctionMarks(prev, c.watermarks);
        chain.set(c.id, { prev: i > 0 ? cuts[i - 1]!.id : null, marks });
        prev = marks;
      }
    })().finally(() => {
      chainBusy = null;
    });
    await chainBusy;
  }
}

// ── Building one backup's record ────────────────────────────────────────────

/** Stream one id range of one table as CSV lines, page by page, each page its own public read. */
async function* rowsOf(t: ArchiveTable, after: string, through: string): AsyncGenerator<{ id: string; time: string; line: string }> {
  let cursor = after;
  for (;;) {
    const rows = await publicRead((tx) => t.page(tx, cursor, through, t.pageRows), 4000);
    for (const r of rows) {
      if (r.t === null) throw new Error(`${t.name}: row ${r.id} has no time, so its archive cannot be named`);
      yield { id: r.id!, time: r.t!, line: encodeCsvRow(t.columns.map((c) => r[c === "id" ? "c_id" : c] ?? null)) };
    }
    if (rows.length < t.pageRows) return;
    cursor = rows[rows.length - 1]!.id!;
  }
}

let gzipFactory: () => Transform = () => createGzip({ level: 9 });
/** Use another gzip encoder for archive bodies (tests only: the identity must not change). Null restores the default. */
export function _setArchiveGzipForTests(make: (() => Transform) | null): void {
  gzipFactory = make ?? (() => createGzip({ level: 9 }));
}

/**
 * Gzip the body as it is written. An archive's identity is the SHA-256 of its
 * uncompressed bytes (`sha256_raw`); the gzip is a transport encoding that any
 * valid encoder may produce, so only the raw side is hashed.
 */
class GzSink {
  private gz = gzipFactory();
  private rawHash = createHash("sha256");
  bytesRaw = 0;
  private done: Promise<void>;
  constructor(onChunk?: (c: Uint8Array) => void) {
    this.gz.on("data", (c: Buffer) => onChunk?.(c));
    this.done = new Promise((resolve, reject) => {
      this.gz.on("end", () => resolve());
      this.gz.on("error", reject);
    });
  }
  async write(text: string): Promise<void> {
    if (this.gz.destroyed) throw new Error("the archive stream was cancelled");
    const b = Buffer.from(text, "utf8");
    this.rawHash.update(b);
    this.bytesRaw += b.length;
    if (!this.gz.write(b)) await new Promise<void>((r) => this.gz.once("drain", () => r()));
  }
  async close(): Promise<{ bytes_raw: number; sha256_raw: string }> {
    this.gz.end();
    await this.done;
    return { bytes_raw: this.bytesRaw, sha256_raw: this.rawHash.digest("hex") };
  }
  destroy(): void {
    this.gz.destroy();
  }
}

/** Write rows into ≤ ARCHIVE_PART_BYTES parts by format 1's part rule, recording each part. */
async function buildTableFiles(backup: string, t: ArchiveTable, after: string, through: string): Promise<ArchiveFileRecord[]> {
  const files: ArchiveFileRecord[] = [];
  const header = encodeCsvRow(t.columns);
  const headerBytes = Buffer.byteLength(header);
  const namer = new DataFileNamer(t.name);
  let sink: GzSink | null = null;
  let bytes = 0;
  let rows = 0;
  let idMin = "";
  let idMax = "";
  let sum = 0n;
  let tMin: { us: bigint; text: string } | null = null;
  let tMax: { us: bigint; text: string } | null = null;
  const flush = async (): Promise<void> => {
    if (!sink) return;
    const w = await sink.close();
    files.push({
      path: dataPath(backup, namer.next(tMin!.text, tMax!.text)),
      rows,
      ...w,
      id_min: idMin,
      id_max: idMax,
      sum_id: String(sum),
      time_min: tMin!.text,
      time_max: tMax!.text,
    });
    sink = null;
    bytes = 0;
    rows = 0;
    sum = 0n;
    tMin = tMax = null;
  };
  for await (const r of rowsOf(t, after, through)) {
    const n = Buffer.byteLength(r.line);
    if (startsNewPart(rows, bytes, n, partBytes)) await flush();
    if (!sink) {
      sink = new GzSink();
      await sink.write(header);
      bytes = headerBytes;
      idMin = r.id;
    }
    await sink.write(r.line);
    bytes += n;
    rows += 1;
    idMax = r.id;
    sum += BigInt(r.id);
    const us = parseDbTime(r.time);
    if (tMin === null || us < tMin.us) tMin = { us, text: r.time };
    if (tMax === null || us > tMax.us) tMax = { us, text: r.time };
  }
  await flush();
  return files;
}

const records = new Map<string, BuiltRecord>();
const building = new Map<string, Promise<BuiltRecord>>();
let buildQueue: Promise<unknown> = Promise.resolve();

async function buildRecord(id: string): Promise<BuiltRecord> {
  await ensureChain(id);
  const { prev: prevId, marks } = chain.get(id)!;
  const prev = prevId === null ? null : chain.get(prevId)!.marks;
  const append_only: Record<string, ArchiveAppendOnlyRecord> = {};
  for (const t of ARCHIVE_TABLES) {
    const before = prev?.get(t.name)?.wm ?? null;
    const m = marks.get(t.name)!;
    const files = m.wm !== null && m.wm !== before ? await buildTableFiles(id, t, before ?? "0", m.wm) : [];
    append_only[t.name] = {
      time: t.time,
      watermark_before: before,
      watermark_after: m.wm,
      rows_added: files.reduce((n, f) => n + f.rows, 0),
      files,
      db_rows_through_watermark: String(m.rows),
      db_sum_id_through_watermark: String(m.sum),
    };
  }
  const record: ArchiveBackupRecord = {
    format: ARCHIVE_FORMAT,
    backup: id,
    source: "api",
    consistency: "paged",
    snapshot: { exported_at_db: dbTimeText(backupInstantMs(id)), replica_replay_ts: null, db_user: "api", was_replica: false },
    tool: { name: "robotmoney-api", commit: null },
    append_only,
    revisions: {},
  };
  const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2) + "\n");
  return { record, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Is `id` a sealed backup this API serves? */
export async function isServedBackup(id: string): Promise<boolean> {
  if (!BACKUP_ID_RE.test(id)) return false;
  return (await listBackupIds()).includes(id);
}

/** The record already built, or null. Reads nothing: what a conditional request needs. */
export function cachedRecord(id: string): BuiltRecord | null {
  return records.get(id) ?? null;
}

/**
 * The backup's record, building it (in the background, one backup at a time)
 * when it is not built yet. Resolves once built; the route waits a bounded
 * time and otherwise answers 503 with Retry-After.
 */
export function recordFor(id: string): Promise<BuiltRecord> {
  const have = records.get(id);
  if (have) return Promise.resolve(have);
  let p = building.get(id);
  if (!p) {
    p = buildQueue.then(() => buildRecord(id));
    buildQueue = p.catch(() => undefined);
    building.set(id, p);
    p.then(
      (r) => {
        records.set(id, r);
        building.delete(id);
      },
      (err) => {
        building.delete(id);
        console.error(`[public-archive] backup ${id}: the record build failed: ${(err as Error).message}`);
      },
    );
  }
  return p;
}

/** The file a built record lists at `path`, or null. */
export function fileIn(built: BuiltRecord, path: string): { table: ArchiveTable; file: ArchiveFileRecord } | null {
  for (const [name, a] of Object.entries(built.record.append_only)) {
    const file = a.files.find((f) => f.path === path);
    if (file) return { table: tableByName.get(name)!, file };
  }
  return null;
}

/**
 * The archive body as a stream: its rows regenerated from their id range,
 * gzipped as they arrive (by any valid encoder). The stream errors, rather than ends, when the bytes
 * do not hash to the record's sha256_raw, so a client never receives a complete
 * body that differs from what the record names.
 */
export function archiveBodyStream(table: ArchiveTable, file: ArchiveFileRecord): ReadableStream<Uint8Array> {
  let sink: GzSink | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        sink = new GzSink((c) => {
          if (!cancelled) controller.enqueue(new Uint8Array(c));
        });
        await sink.write(encodeCsvRow(table.columns));
        const after = String(BigInt(file.id_min) - 1n);
        for await (const r of rowsOf(table, after, file.id_max)) {
          if (cancelled) return;
          await sink.write(r.line);
        }
        const w = await sink.close();
        if (w.sha256_raw !== file.sha256_raw) {
          throw new Error(`${file.path}: regenerated content hashes to ${w.sha256_raw}, the record says ${file.sha256_raw}`);
        }
        controller.close();
      } catch (err) {
        sink?.destroy();
        if (cancelled) return;
        console.error(`[public-archive] ${file.path}: ${(err as Error).message}`);
        controller.error(err);
      }
    },
    cancel() {
      cancelled = true;
      sink?.destroy();
    },
  });
}

/** Forget every built record and watermark. For tests. */
export function _resetArchiveForTests(): void {
  chain.clear();
  records.clear();
  building.clear();
  firstDayMs = null;
  rowsFollowJunction = null;
  chainBusy = null;
  buildQueue = Promise.resolve();
}

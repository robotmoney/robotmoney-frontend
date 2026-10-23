// Format 1 archives served by the public API (issue 1422; the
// robotmoney/csv-backups layout, which docs PR 1412 names "format 1").
//
// WHAT A BACKUP IS HERE. The csvb tool takes a backup at the moment it runs
// and records it in a git repo. The API cannot store anything (the issue adds
// no table, column or grant), so its backups are DERIVED, deterministically,
// from the append-only tables themselves:
//
//   - One backup per UTC day boundary t, named `YYYY-MM-DDT000000Z`. A backup
//     is listed and served only once it is SEALED: t is at least
//     ARCHIVE_SETTLE_MS (1 hour) in the past.
//   - Per table, its watermark is the id just below the first row, after the
//     previous backup's watermark, whose time column is at or after t (the
//     table's newest id when no such row exists yet). Every time column here
//     defaults to clock_timestamp() and no code writes one explicitly, so a row
//     inserted after t is stamped after t and gets a higher id: a sealed
//     backup's watermarks, rows, file names and bytes never change. The settle
//     hour covers a transaction that took its id before t and committed after.
//   - The files are what csvb writes for the same id ranges: per table, the
//     rows with ids above the previous watermark up to this one, in id order,
//     as Postgres COPY CSV text (each column through its type's output
//     function, timestamps in UTC), split into parts of at most
//     ARCHIVE_PART_BYTES uncompressed (a row is never cut), each named
//     `<table>.<start>_<end>.csv.gz` by the earliest and latest row time in it,
//     gzipped at level 9 with node:zlib (csvb's GzFile).
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
// and kept in memory. An archive body is regenerated from its id range when
// requested, streamed through gzip as the pages arrive, and its SHA-256 is
// compared with the record at the end; a mismatch aborts the response rather
// than finish a body that differs from what its record names. Nothing here
// reads a provider or recomputes an analytics value: every byte comes from the
// committed rows.
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { ARCHIVE_FORMAT, ARCHIVE_PART_BYTES, ARCHIVE_SETTLE_MS } from "@robotmoney/contract";
import type { TransactionSql } from "postgres";
import { on, registerQuery } from "../../db/registry.ts";
import { publicRead } from "../../api/public-analytics-limits.ts";

const ROUTE = "src/api/routes/public-analytics";
const DAY_MS = 86_400_000;

export type TimeSpec = { column: string } | { lookup: { column: string; table: string; key: string; timeColumn: string } };

export interface ArchiveFileRecord {
  path: string;
  rows: number;
  bytes_raw: number;
  bytes_gz: number;
  sha256_raw: string;
  sha256_gz: string;
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
  step(tx: Tx, after: string, boundary: string): Promise<ChainStep[]>;
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM source_value_versions WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM source_value_versions WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const svvStep = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:source_value_versions.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: SVV_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_ledger_runs WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_ledger_runs WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const runsStep = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_ledger_runs.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: RUNS_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_ledger_methodology_versions WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_ledger_methodology_versions WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const methStep = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_methodology_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_ledger_methodology_versions.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: METH_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_data_vintages WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_data_vintages WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const vinStep = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_data_vintages.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: VIN_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
const MEM_STEP = `WITH b AS (
    SELECT (SELECT m.id FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id
        WHERE m.id > $1::bigint AND v.created_at >= $2::timestamptz ORDER BY m.id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_vintage_members) AS max_id,
      (SELECT v.created_at FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id ORDER BY m.id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_vintage_members WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_vintage_members WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const memStep = registerQuery({
  role: "rm_app",
  object: "analytics_vintage_members",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_vintage_members.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: MEM_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
});
const memStepVintages = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_vintage_members.step.vintages",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: MEM_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_overwrite_events WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_overwrite_events WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const ovwStep = registerQuery({
  role: "rm_app",
  object: "analytics_overwrite_events",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_overwrite_events.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: OVW_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_output_snapshots WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_output_snapshots WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const outStep = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_output_snapshots.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: OUT_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
  SELECT w.wm::text AS wm, w.first_time::text AS first_time,
    (SELECT count(*) FROM analytics_report_snapshots WHERE id > $3::bigint AND id <= w.wm)::text AS n,
    (SELECT coalesce(sum(id), 0) FROM analytics_report_snapshots WHERE id > $4::bigint AND id <= w.wm)::text AS s
  FROM w`;
const repStep = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/public-archive-store:analytics_report_snapshots.step",
  purpose: "Find a format 1 archive backup's watermark in this table, with the count and id sum the backup adds (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REP_STEP, params: [0, "2000-01-01T00:00:00Z", 0, 0] },
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
    time: { column: "created_at" },
    columns: ["id", "run_id", "artifact_kind", "checksum", "byte_length", "created_at", "payload_json", "payload_sha256"],
    pageRows: 2,
    step: (tx, a, b) => on(tx, outStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_output_snapshots WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_output_snapshots) AS max_id,
      (SELECT created_at FROM analytics_output_snapshots ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { column: "created_at" },
    columns: ["id", "run_id", "asof", "checksum", "byte_length", "created_at", "report_json", "report_sha256"],
    pageRows: 10,
    step: (tx, a, b) => on(tx, repStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_report_snapshots WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_report_snapshots) AS max_id,
      (SELECT created_at FROM analytics_report_snapshots ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { column: "knowledge_time" },
    columns: ["id", "acquisition_id", "source_key", "market_date", "market_instant", "value", "prior_version_id", "revision_kind", "knowledge_time", "provenance"],
    pageRows: 20_000,
    step: (tx, a, b) => on(tx, svvStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM source_value_versions WHERE id > ${a}::bigint AND knowledge_time >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM source_value_versions) AS max_id,
      (SELECT knowledge_time FROM source_value_versions ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { column: "created_at" },
    columns: ["id", "run_key", "asof", "tool_id", "source_label", "methodology_version_id", "build_identity", "job_id", "created_at"],
    pageRows: 5000,
    step: (tx, a, b) => on(tx, runsStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_ledger_runs WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_ledger_runs) AS max_id,
      (SELECT created_at FROM analytics_ledger_runs ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { column: "created_at" },
    columns: ["id", "tool_id", "version_label", "config", "config_digest", "created_at"],
    pageRows: 5000,
    step: (tx, a, b) => on(tx, methStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_ledger_methodology_versions WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_ledger_methodology_versions) AS max_id,
      (SELECT created_at FROM analytics_ledger_methodology_versions ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { column: "created_at" },
    columns: ["id", "run_id", "tool_id", "knowledge_time_cutoff", "market_time_cutoff", "methodology_version_id", "build_identity", "manifest", "manifest_digest", "member_count", "created_at"],
    pageRows: 500,
    step: (tx, a, b) => on(tx, vinStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_data_vintages WHERE id > ${a}::bigint AND created_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_data_vintages) AS max_id,
      (SELECT created_at FROM analytics_data_vintages ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { lookup: { column: "vintage_id", table: "analytics_data_vintages", key: "id", timeColumn: "created_at" } },
    columns: ["id", "vintage_id", "source_value_version_id", "source_key", "last_source_value_version_id"],
    pageRows: 50_000,
    step: (tx, a, b) => on(tx, memStep, memStepVintages)<ChainStep>`WITH b AS (
    SELECT (SELECT m.id FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id
        WHERE m.id > ${a}::bigint AND v.created_at >= ${b}::timestamptz ORDER BY m.id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_vintage_members) AS max_id,
      (SELECT v.created_at FROM analytics_vintage_members m JOIN analytics_data_vintages v ON v.id = m.vintage_id ORDER BY m.id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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
    time: { column: "recorded_at" },
    columns: ["id", "table_name", "operation", "natural_key", "previous_row", "replacement_row", "recorded_at"],
    pageRows: 20,
    step: (tx, a, b) => on(tx, ovwStep)<ChainStep>`WITH b AS (
    SELECT (SELECT id FROM analytics_overwrite_events WHERE id > ${a}::bigint AND recorded_at >= ${b}::timestamptz ORDER BY id LIMIT 1) AS next_id,
      (SELECT max(id) FROM analytics_overwrite_events) AS max_id,
      (SELECT recorded_at FROM analytics_overwrite_events ORDER BY id LIMIT 1) AS first_time
  ), w AS (SELECT COALESCE(next_id - 1, max_id) AS wm, first_time FROM b)
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

// ── Names and text, exactly as csvb writes them ─────────────────────────────

export const BACKUP_ID_RE = /^(\d{4}-\d{2}-\d{2})T000000Z$/;

/** One row in Postgres COPY's CSV dialect (csvb src/format/row.ts encodeCsvRow). */
export function encodeCsvRow(values: readonly (string | null)[]): string {
  return (
    values
      .map((v) => {
        if (v === null) return "";
        if (v === "" || /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
        return v;
      })
      .join(",") + "\n"
  );
}

/** `2026-09-21 01:59:32.748478+00` (the database's UTC text) as microseconds since the epoch. */
export function parseDbTime(text: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:\+00(?::00)?|Z)$/.exec(text.trim());
  if (!m) throw new Error(`${JSON.stringify(text)} is not a UTC timestamp`);
  const secs = BigInt(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) / 1000n;
  return secs * 1_000_000n + BigInt((m[7] ?? "").padEnd(6, "0") || "0");
}

/** The UTC time as `YYYY-MM-DDTHHMMSSZ`, to the second (rounded down). */
export function stamp(micros: bigint): string {
  const d = new Date(Number(micros / 1000n));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function dataFileName(table: string, tMin: string, tMax: string, dup: number): string {
  return `${table}.${stamp(parseDbTime(tMin))}_${stamp(parseDbTime(tMax))}${dup > 1 ? `-${dup}` : ""}.csv.gz`;
}

const backupIdOf = (dayMs: number): string => `${new Date(dayMs).toISOString().slice(0, 10)}T000000Z`;
const dayMsOf = (id: string): number => Date.parse(`${BACKUP_ID_RE.exec(id)![1]}T00:00:00Z`);
const boundaryText = (dayMs: number): string => `${new Date(dayMs).toISOString().slice(0, 10)} 00:00:00+00`;

// ── The clock, and the chain of watermarks ──────────────────────────────────

let clock: () => number = () => Date.now();
let partBytes = ARCHIVE_PART_BYTES;
/** Replace the part size (tests split a small backup into several parts). */
export function _setArchivePartBytesForTests(bytes: number | null): void {
  partBytes = bytes ?? ARCHIVE_PART_BYTES;
}
/** Replace the clock (tests seal backups without waiting a day). */
export function _setArchiveClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** The newest sealed boundary: the latest UTC midnight at least ARCHIVE_SETTLE_MS ago. */
function lastSealedDayMs(): number {
  return Math.floor((clock() - ARCHIVE_SETTLE_MS) / DAY_MS) * DAY_MS;
}

interface TableMark {
  wm: string | null;
  rows: bigint;
  sum: bigint;
}

/** Watermarks per sealed backup, oldest first. Sealed boundaries never change, so this only grows. */
const chain = new Map<string, Map<string, TableMark>>();
let firstDayMs: number | null = null;
let chainBusy: Promise<void> | null = null;

/** The first backup boundary: the UTC midnight after the earliest first row of any served table. */
async function loadFirstDay(): Promise<number | null> {
  if (firstDayMs !== null) return firstDayMs;
  let earliest: bigint | null = null;
  await publicRead(async (tx) => {
    for (const t of ARCHIVE_TABLES) {
      const [r] = await t.step(tx, "0", "0001-01-01T00:00:00Z");
      if (r?.first_time) {
        const us = parseDbTime(r.first_time);
        if (earliest === null || us < earliest) earliest = us;
      }
    }
  }, 4000);
  if (earliest === null) return null;
  firstDayMs = Math.floor(Number((earliest as bigint) / 1000n) / DAY_MS) * DAY_MS + DAY_MS;
  return firstDayMs;
}

/** Every sealed backup id, oldest first. */
export async function listBackupIds(): Promise<string[]> {
  const first = await loadFirstDay();
  if (first === null) return [];
  const out: string[] = [];
  for (let d = first; d <= lastSealedDayMs(); d += DAY_MS) out.push(backupIdOf(d));
  return out;
}

/** Fill the chain through `id`, one boundary at a time, each step a bounded public read. */
async function ensureChain(id: string): Promise<void> {
  while (!chain.has(id)) {
    if (chainBusy) {
      await chainBusy;
      continue;
    }
    chainBusy = (async () => {
      const first = (await loadFirstDay())!;
      const target = dayMsOf(id);
      let prev: Map<string, TableMark> | null = null;
      for (let d = first; d <= target; d += DAY_MS) {
        const bid = backupIdOf(d);
        const have = chain.get(bid);
        if (have) {
          prev = have;
          continue;
        }
        const marks = new Map<string, TableMark>();
        const before = prev;
        await publicRead(async (tx) => {
          for (const t of ARCHIVE_TABLES) {
            const p = before?.get(t.name) ?? { wm: null, rows: 0n, sum: 0n };
            const [r] = await t.step(tx, p.wm ?? "0", new Date(d).toISOString());
            const wm = r?.wm ?? p.wm;
            marks.set(t.name, { wm, rows: p.rows + BigInt(r?.n ?? "0"), sum: p.sum + BigInt(r?.s ?? "0") });
          }
        }, 4000);
        chain.set(bid, marks);
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

/** Gzip as csvb's GzFile does (node:zlib, level 9, on the threadpool), hashing both sides. */
class GzSink {
  private gz = createGzip({ level: 9 });
  private rawHash = createHash("sha256");
  private gzHash = createHash("sha256");
  bytesRaw = 0;
  bytesGz = 0;
  private done: Promise<void>;
  constructor(onChunk?: (c: Uint8Array) => void) {
    this.gz.on("data", (c: Buffer) => {
      this.gzHash.update(c);
      this.bytesGz += c.length;
      onChunk?.(c);
    });
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
  async close(): Promise<{ bytes_raw: number; bytes_gz: number; sha256_raw: string; sha256_gz: string }> {
    this.gz.end();
    await this.done;
    return { bytes_raw: this.bytesRaw, bytes_gz: this.bytesGz, sha256_raw: this.rawHash.digest("hex"), sha256_gz: this.gzHash.digest("hex") };
  }
  destroy(): void {
    this.gz.destroy();
  }
}

/** Write rows into ≤ ARCHIVE_PART_BYTES parts as csvb's RangeWriter does, recording each part. */
async function buildTableFiles(backup: string, t: ArchiveTable, after: string, through: string): Promise<ArchiveFileRecord[]> {
  const files: ArchiveFileRecord[] = [];
  const header = encodeCsvRow(t.columns);
  const headerBytes = Buffer.byteLength(header);
  const used = new Set<string>();
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
    let dup = 1;
    let name = dataFileName(t.name, tMin!.text, tMax!.text, dup);
    while (used.has(name)) name = dataFileName(t.name, tMin!.text, tMax!.text, ++dup);
    used.add(name);
    files.push({
      path: `csv/${backup}/data/${name}`,
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
    if (rows > 0 && bytes + n > partBytes) await flush();
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
  const marks = chain.get(id)!;
  const prevId = backupIdOf(dayMsOf(id) - DAY_MS);
  const prev = chain.get(prevId) ?? null;
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
    snapshot: { exported_at_db: boundaryText(dayMsOf(id)), replica_replay_ts: null, db_user: "api", was_replica: false },
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
  const d = dayMsOf(id);
  if (Number.isNaN(d) || backupIdOf(d) !== id) return false;
  const first = await loadFirstDay();
  return first !== null && d >= first && d <= lastSealedDayMs();
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
      () => building.delete(id),
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
 * gzipped as they arrive. The stream errors, rather than ends, when the bytes
 * do not hash to the record's sha256_gz, so a client never receives a complete
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
        if (w.sha256_gz !== file.sha256_gz) {
          throw new Error(`${file.path}: regenerated bytes hash to ${w.sha256_gz}, the record says ${file.sha256_gz}`);
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
  chainBusy = null;
  buildQueue = Promise.resolve();
}

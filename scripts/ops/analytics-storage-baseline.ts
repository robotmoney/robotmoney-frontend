#!/usr/bin/env bun
// scripts/ops/analytics-storage-baseline.ts — storage S0 of issue 1765: measure
// the analytics tables before any storage change (S2 to S5) is decided.
//
//   HOME=<dir with the replica's .env> bun scripts/ops/analytics-storage-baseline.ts \
//     [--days N] [--sample-percent P] [--exact-counts]
//
// WHO RUNS IT, AND WHERE. An operator runs it by hand from stage-2, outside the
// 3-hourly producer tick. It is never a CI step, and no test runs it against
// production: backend/tests/analytics-storage-baseline.test.ts runs it on the
// test database.
//
// TARGET: THE PRODUCTION READ REPLICA. The session is scripts/release/db-read.ts
// (openReadOnly), which connects as rm_readonly to the `host` line of
// $HOME/.env. Production's ~/.env names the primary in `host` (its replica
// host is `replica_host`, D82), so the operator points HOME at a directory whose
// .env names the replica as `host`, with the `port`, `database`, `sslmode` and
// `rm_readonly` lines beside it. The report's `in_recovery` says which kind of
// server answered: true on a standby. The script prints a warning to stderr
// when it is false.
//
// READ ONLY. openReadOnly sets the session READ ONLY and proves it with SHOW
// transaction_read_only before the first query, or refuses. That is a session
// default. The real wall is the role: rm_readonly holds SELECT-only grants.
// Every statement is SQL text with constant table names, because db-read takes
// no bound parameters; the numeric options are validated before they are
// inlined.
//
// WHAT IT REPORTS. For each table in STORAGE_TABLES:
//   * sizes: pg_total_relation_size, pg_relation_size (heap), pg_indexes_size
//     and the toast relation's total size (toast heap and toast index);
//   * rows: pg_class.reltuples (null before the first VACUUM or ANALYZE), and
//     count(*) only with --exact-counts;
//   * counters from pg_stat_user_tables: n_live_tup, n_dead_tup, n_tup_ins,
//     n_tup_upd, n_tup_hot_upd, n_tup_del and last_autovacuum;
//   * column sizes: sum, avg and max of pg_column_size for every jsonb or bytea
//     column information_schema.columns lists. A table with a write timestamp
//     scans only the window (--days); a table without one scans a
//     TABLESAMPLE SYSTEM (--sample-percent) sample, and the sample percent is
//     reported beside the figures;
//   * growth: per UTC day over the window for the tables with a write timestamp
//     (analytics_vintage_members through its vintage's created_at). The current
//     views (regime_snapshots, research_signals, raw_indicator_history) have no
//     write timestamp, so their growth is the n_tup_* counters since
//     pg_stat_database.stats_reset.
// And, for the regime artifact kinds created in the window, the split of
// artifact bytes between the as-of row (the last array element) and the whole
// artifact, as a ratio.
//
// A STANDBY KEEPS NO TABLE COUNTERS. The cumulative statistics are per server
// and are not replicated, so on a server in recovery n_live_tup, n_dead_tup,
// n_tup_* and last_autovacuum would read as misleading zeros. They read null
// there, with `counters_unavailable: "standby"`. Sizes, reltuples, counts,
// column sizes and the daily growth are read from the data and stay exact.
//
// COST. The windowed scans read only the window's rows, but analytics_output_
// snapshots and analytics_overwrite_events have no index on their write
// timestamp, so the filter is a scan of the table's main heap (the large values
// are toasted and are not read unless a row is in the window). The as-of split
// parses every regime artifact in the window; lower --days if that is slow.
//
// Exit codes: 0 the report printed; 2 bad arguments or no session.
import { openReadOnly, type ReadOnlySession } from "../release/db-read.ts";

/** The tables S0 measures, in report order. */
export const STORAGE_TABLES = Object.freeze([
  "analytics_output_snapshots",
  "analytics_data_vintages",
  "analytics_vintage_members",
  "analytics_overwrite_events",
  "regime_snapshots",
  "research_signals",
  "raw_indicator_history",
] as const);

export type StorageTable = (typeof STORAGE_TABLES)[number];

/** The column that records when each row was written; null for a table without one. */
const WRITTEN_AT: Readonly<Record<StorageTable, string | null>> = Object.freeze({
  analytics_output_snapshots: "created_at",
  analytics_data_vintages: "created_at",
  // A member row is written with its vintage: its growth reads the vintage's created_at.
  analytics_vintage_members: null,
  analytics_overwrite_events: "recorded_at",
  regime_snapshots: null,
  research_signals: null,
  raw_indicator_history: null,
});

/** The artifact kinds that hold regime rows, one array element per date, the as-of row last. */
export const REGIME_ARTIFACT_KINDS = Object.freeze(["regime_snapshots", "regime_beside_snapshots"] as const);

export const DEFAULT_DAYS = 7;
export const DEFAULT_SAMPLE_PERCENT = 1;

export interface BaselineOptions {
  /** count(*) every table. Off by default: a full scan of each table. */
  exactCounts?: boolean;
  /** Whole UTC days before today in the window; today so far is included too. */
  days?: number;
  /** TABLESAMPLE SYSTEM percent for the column sizes of a table with no write timestamp. */
  samplePercent?: number;
}

export interface ColumnSize {
  column: string;
  type: "jsonb" | "bytea";
  /** Rows in the scan whose value is not null. */
  values: number;
  sum_bytes: number;
  avg_bytes: number | null;
  max_bytes: number | null;
}

export interface ColumnSizes {
  scan:
    | { mode: "window"; column: string; window_start: string }
    | { mode: "sample"; sample_percent: number };
  rows_scanned: number;
  columns: ColumnSize[];
}

export type Growth =
  | { mode: "daily"; by: string; window_start: string; days: Record<string, string | number | null>[] }
  | {
      mode: "counters_since_stats_reset";
      stats_reset: string | null;
      n_tup_ins: number | null;
      n_tup_upd: number | null;
      n_tup_hot_upd: number | null;
      n_tup_del: number | null;
      counters_unavailable: "standby" | null;
    };

export interface TableBaseline {
  table: StorageTable;
  exists: boolean;
  total_bytes: number | null;
  heap_bytes: number | null;
  index_bytes: number | null;
  toast_bytes: number | null;
  /** pg_class.reltuples; null before the table's first VACUUM or ANALYZE. */
  reltuples: number | null;
  /** count(*), only with exactCounts. */
  exact_count: number | null;
  n_live_tup: number | null;
  n_dead_tup: number | null;
  n_tup_ins: number | null;
  n_tup_upd: number | null;
  n_tup_hot_upd: number | null;
  n_tup_del: number | null;
  last_autovacuum: string | null;
  /** Why the pg_stat_user_tables figures above read null. */
  counters_unavailable: "standby" | null;
  column_sizes: ColumnSizes | null;
  growth: Growth | null;
}

export interface ArtifactSplit {
  artifact_kind: string;
  /** Artifacts of this kind created in the window. */
  artifacts: number;
  /** Of those, the empty lists (a v5 run's main-line regime artifact is one). */
  empty_artifacts: number;
  /** Bytes of the last array element of each non-empty artifact, as jsonb text. */
  asof_bytes: number;
  /** Bytes of each whole non-empty artifact, as jsonb text. */
  total_bytes: number;
  /** asof_bytes / total_bytes; null when there is no non-empty artifact. */
  ratio: number | null;
  min_ratio: number | null;
  avg_ratio: number | null;
  max_ratio: number | null;
}

export interface StorageBaseline {
  target: string;
  generated_at: string;
  database: string;
  server_version: string;
  in_recovery: boolean;
  stats_reset: string | null;
  options: { exact_counts: boolean; days: number; sample_percent: number; window_start: string };
  tables: TableBaseline[];
  artifact_split: ArtifactSplit[];
}

/** A bigint, numeric or float column as a number; null stays null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(value)}`);
  return n;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A double-quoted SQL identifier. Column names come from the catalog, never from input. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Validate the options, so every value inlined into SQL text is a plain number. */
export function resolveOptions(opts: BaselineOptions = {}): { exactCounts: boolean; days: number; samplePercent: number } {
  const days = opts.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error(`days must be an integer from 0 to 3650, got ${days}`);
  const samplePercent = opts.samplePercent ?? DEFAULT_SAMPLE_PERCENT;
  if (!Number.isFinite(samplePercent) || samplePercent <= 0 || samplePercent > 100) {
    throw new Error(`samplePercent must be above 0 and at most 100, got ${samplePercent}`);
  }
  return { exactCounts: opts.exactCounts === true, days, samplePercent };
}

/** The window's start: UTC midnight `days` days before today, as a timestamptz expression. */
function windowStartSql(days: number): string {
  return `((date_trunc('day', now() AT TIME ZONE 'UTC') - interval '${days} days') AT TIME ZONE 'UTC')`;
}

/** A timestamptz column's UTC day, as text. */
function utcDay(column: string): string {
  return `((${column} AT TIME ZONE 'UTC')::date)::text`;
}

/** Sizes, reltuples and pg_stat_user_tables counters of one table; null when it does not exist. */
async function readTableStats(db: ReadOnlySession, table: StorageTable): Promise<Record<string, unknown> | null> {
  const [row] = await db.query(`
    SELECT pg_total_relation_size(c.oid)::bigint AS total_bytes,
           pg_relation_size(c.oid)::bigint AS heap_bytes,
           pg_indexes_size(c.oid)::bigint AS index_bytes,
           (CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END)::bigint AS toast_bytes,
           c.reltuples::float8 AS reltuples,
           s.n_live_tup::bigint AS n_live_tup,
           s.n_dead_tup::bigint AS n_dead_tup,
           s.n_tup_ins::bigint AS n_tup_ins,
           s.n_tup_upd::bigint AS n_tup_upd,
           s.n_tup_hot_upd::bigint AS n_tup_hot_upd,
           s.n_tup_del::bigint AS n_tup_del,
           s.last_autovacuum::text AS last_autovacuum
      FROM pg_catalog.pg_class c
      LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid
     WHERE c.oid = to_regclass('public.${table}')`);
  return row ?? null;
}

/** pg_column_size of every jsonb and bytea column, over the window or a sample. */
async function readColumnSizes(
  db: ReadOnlySession,
  table: StorageTable,
  days: number,
  samplePercent: number,
): Promise<ColumnSizes> {
  const writtenAt = WRITTEN_AT[table];
  const scan: ColumnSizes["scan"] = writtenAt
    ? { mode: "window", column: writtenAt, window_start: "" }
    : { mode: "sample", sample_percent: samplePercent };
  const from = writtenAt
    ? `FROM public.${table} WHERE ${ident(writtenAt)} >= ${windowStartSql(days)}`
    : `FROM public.${table} TABLESAMPLE SYSTEM (${samplePercent})`;
  const columns = await db.query<{ column_name: string; data_type: "jsonb" | "bytea" }>(`
    SELECT column_name::text AS column_name, data_type::text AS data_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}' AND data_type IN ('jsonb', 'bytea')
     ORDER BY ordinal_position`);
  const select = [`count(*)::bigint AS rows_scanned`, `${windowStartSql(days)}::text AS window_start`];
  columns.forEach((c, i) => {
    const size = `pg_column_size(${ident(c.column_name)})`;
    select.push(
      `count(${ident(c.column_name)})::bigint AS v${i}`,
      `COALESCE(sum(${size}), 0)::bigint AS s${i}`,
      `avg(${size})::float8 AS a${i}`,
      `max(${size})::bigint AS m${i}`,
    );
  });
  const [row] = await db.query(`SELECT ${select.join(", ")} ${from}`);
  if (scan.mode === "window") scan.window_start = str(row?.window_start) ?? "";
  return {
    scan,
    rows_scanned: num(row?.rows_scanned) ?? 0,
    columns: columns.map((c, i) => ({
      column: c.column_name,
      type: c.data_type,
      values: num(row?.[`v${i}`]) ?? 0,
      sum_bytes: num(row?.[`s${i}`]) ?? 0,
      avg_bytes: num(row?.[`a${i}`]),
      max_bytes: num(row?.[`m${i}`]),
    })),
  };
}

/** Every value of a growth row as a number, except the named text columns. */
function growthRow(row: Record<string, unknown>, text: readonly string[]): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) out[key] = text.includes(key) ? str(value) : num(value);
  return out;
}

/** The daily growth query of a table with a write timestamp; null for the current views. */
function dailyGrowthSql(table: StorageTable, start: string): { by: string; text: readonly string[]; sql: string } | null {
  switch (table) {
    case "analytics_output_snapshots":
      return {
        by: "created_at",
        text: ["day", "artifact_kind"],
        sql: `SELECT ${utcDay("created_at")} AS day, artifact_kind,
                     count(*)::bigint AS rows,
                     COALESCE(sum(byte_length), 0)::bigint AS byte_length,
                     COALESCE(sum(pg_column_size(payload_bytes)), 0)::bigint AS payload_stored_bytes
                FROM public.analytics_output_snapshots
               WHERE created_at >= ${start}
               GROUP BY 1, 2 ORDER BY 1, 2`,
      };
    case "analytics_data_vintages":
      return {
        by: "created_at",
        text: ["day"],
        sql: `SELECT ${utcDay("created_at")} AS day,
                     count(*)::bigint AS rows,
                     COALESCE(sum(member_count), 0)::bigint AS member_count,
                     COALESCE(sum(pg_column_size(manifest)), 0)::bigint AS manifest_bytes
                FROM public.analytics_data_vintages
               WHERE created_at >= ${start}
               GROUP BY 1 ORDER BY 1`,
      };
    case "analytics_vintage_members":
      return {
        by: "analytics_data_vintages.created_at",
        text: ["day"],
        sql: `SELECT ${utcDay("v.created_at")} AS day,
                     count(*)::bigint AS rows,
                     COALESCE(sum(pg_column_size(m.*)), 0)::bigint AS row_bytes
                FROM public.analytics_vintage_members m
                JOIN public.analytics_data_vintages v ON v.id = m.vintage_id
               WHERE v.created_at >= ${start}
               GROUP BY 1 ORDER BY 1`,
      };
    case "analytics_overwrite_events":
      return {
        by: "recorded_at",
        text: ["day", "table_name"],
        sql: `SELECT ${utcDay("recorded_at")} AS day, table_name,
                     count(*)::bigint AS rows,
                     COALESCE(sum(pg_column_size(previous_row)), 0)::bigint AS previous_row_bytes,
                     COALESCE(sum(pg_column_size(replacement_row)), 0)::bigint AS replacement_row_bytes
                FROM public.analytics_overwrite_events
               WHERE recorded_at >= ${start}
               GROUP BY 1, 2 ORDER BY 1, 2`,
      };
    default:
      return null;
  }
}

/** The as-of row's share of each regime artifact kind created in the window. */
async function readArtifactSplit(db: ReadOnlySession, start: string): Promise<ArtifactSplit[]> {
  const kinds = REGIME_ARTIFACT_KINDS.map((k) => `'${k}'`).join(", ");
  // OFFSET 0 keeps the parse in the inner query, so each artifact is parsed once.
  const rows = await db.query(`
    SELECT artifact_kind,
           count(*)::bigint AS artifacts,
           count(*) FILTER (WHERE n = 0)::bigint AS empty_artifacts,
           COALESCE(sum(asof_bytes) FILTER (WHERE n > 0), 0)::bigint AS asof_bytes,
           COALESCE(sum(total_bytes) FILTER (WHERE n > 0), 0)::bigint AS total_bytes,
           (sum(asof_bytes) FILTER (WHERE n > 0))::float8
             / NULLIF(sum(total_bytes) FILTER (WHERE n > 0), 0)::float8 AS ratio,
           min(asof_bytes::float8 / total_bytes) FILTER (WHERE n > 0) AS min_ratio,
           avg(asof_bytes::float8 / total_bytes) FILTER (WHERE n > 0) AS avg_ratio,
           max(asof_bytes::float8 / total_bytes) FILTER (WHERE n > 0) AS max_ratio
      FROM (
        SELECT artifact_kind,
               jsonb_array_length(doc) AS n,
               octet_length((doc -> -1)::text) AS asof_bytes,
               octet_length(doc::text) AS total_bytes
          FROM (
            SELECT artifact_kind, convert_from(payload_bytes, 'UTF8')::jsonb AS doc
              FROM public.analytics_output_snapshots
             WHERE artifact_kind IN (${kinds}) AND created_at >= ${start}
            OFFSET 0
          ) parsed
         WHERE jsonb_typeof(doc) = 'array'
      ) sized
     GROUP BY artifact_kind
     ORDER BY artifact_kind`);
  return rows.map((r) => ({
    artifact_kind: String(r.artifact_kind),
    artifacts: num(r.artifacts) ?? 0,
    empty_artifacts: num(r.empty_artifacts) ?? 0,
    asof_bytes: num(r.asof_bytes) ?? 0,
    total_bytes: num(r.total_bytes) ?? 0,
    ratio: num(r.ratio),
    min_ratio: num(r.min_ratio),
    avg_ratio: num(r.avg_ratio),
    max_ratio: num(r.max_ratio),
  }));
}

/**
 * Measure every table in {@link STORAGE_TABLES} on a proven read-only session.
 * Reads only. The caller opens and closes the session.
 */
export async function collectBaseline(db: ReadOnlySession, opts: BaselineOptions = {}): Promise<StorageBaseline> {
  const { exactCounts, days, samplePercent } = resolveOptions(opts);
  const start = windowStartSql(days);
  const [server] = await db.query(`
    SELECT now()::text AS generated_at,
           current_database()::text AS database,
           current_setting('server_version') AS server_version,
           pg_is_in_recovery() AS in_recovery,
           ${start}::text AS window_start,
           (SELECT stats_reset::text FROM pg_catalog.pg_stat_database WHERE datname = current_database()) AS stats_reset`);
  const inRecovery = server?.in_recovery === true;
  const statsReset = str(server?.stats_reset);
  // A standby keeps no table counters of its own: null with a reason, not zeros.
  const counter = (value: unknown): number | null => (inRecovery ? null : num(value));
  const unavailable = inRecovery ? ("standby" as const) : null;

  const tables: TableBaseline[] = [];
  for (const table of STORAGE_TABLES) {
    const stats = await readTableStats(db, table);
    if (!stats) {
      tables.push({
        table, exists: false,
        total_bytes: null, heap_bytes: null, index_bytes: null, toast_bytes: null,
        reltuples: null, exact_count: null,
        n_live_tup: null, n_dead_tup: null, n_tup_ins: null, n_tup_upd: null, n_tup_hot_upd: null, n_tup_del: null,
        last_autovacuum: null, counters_unavailable: unavailable,
        column_sizes: null, growth: null,
      });
      continue;
    }
    let exactCount: number | null = null;
    if (exactCounts) {
      const [row] = await db.query(`SELECT count(*)::bigint AS n FROM public.${table}`);
      exactCount = num(row?.n) ?? 0;
    }
    const reltuples = num(stats.reltuples);
    const daily = dailyGrowthSql(table, start);
    let growth: Growth;
    if (daily) {
      const rows = await db.query(daily.sql);
      growth = {
        mode: "daily",
        by: daily.by,
        window_start: str(server?.window_start) ?? "",
        days: rows.map((r) => growthRow(r, daily.text)),
      };
    } else {
      growth = {
        mode: "counters_since_stats_reset",
        stats_reset: statsReset,
        n_tup_ins: counter(stats.n_tup_ins),
        n_tup_upd: counter(stats.n_tup_upd),
        n_tup_hot_upd: counter(stats.n_tup_hot_upd),
        n_tup_del: counter(stats.n_tup_del),
        counters_unavailable: unavailable,
      };
    }
    tables.push({
      table,
      exists: true,
      total_bytes: num(stats.total_bytes),
      heap_bytes: num(stats.heap_bytes),
      index_bytes: num(stats.index_bytes),
      toast_bytes: num(stats.toast_bytes),
      reltuples: reltuples !== null && reltuples >= 0 ? reltuples : null,
      exact_count: exactCount,
      n_live_tup: counter(stats.n_live_tup),
      n_dead_tup: counter(stats.n_dead_tup),
      n_tup_ins: counter(stats.n_tup_ins),
      n_tup_upd: counter(stats.n_tup_upd),
      n_tup_hot_upd: counter(stats.n_tup_hot_upd),
      n_tup_del: counter(stats.n_tup_del),
      last_autovacuum: inRecovery ? null : str(stats.last_autovacuum),
      counters_unavailable: unavailable,
      column_sizes: await readColumnSizes(db, table, days, samplePercent),
      growth,
    });
  }

  const outputs = tables.find((t) => t.table === "analytics_output_snapshots");
  const artifactSplit = outputs?.exists ? await readArtifactSplit(db, start) : [];

  return {
    target: db.target,
    generated_at: str(server?.generated_at) ?? "",
    database: str(server?.database) ?? "",
    server_version: str(server?.server_version) ?? "",
    in_recovery: inRecovery,
    stats_reset: statsReset,
    options: { exact_counts: exactCounts, days, sample_percent: samplePercent, window_start: str(server?.window_start) ?? "" },
    tables,
    artifact_split: artifactSplit,
  };
}

const USAGE =
  "usage: HOME=<dir with the replica's .env> bun scripts/ops/analytics-storage-baseline.ts [--days N] [--sample-percent P] [--exact-counts]";

/** Parse the command line into options; throws on anything it does not know. */
export function parseArgs(argv: readonly string[]): BaselineOptions {
  const opts: BaselineOptions = {};
  const rest = [...argv];
  const numberAfter = (flag: string): number => {
    const raw = rest.shift();
    if (raw === undefined || raw.trim() === "") throw new Error(`${flag} needs a value`);
    return Number(raw);
  };
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === "--exact-counts") opts.exactCounts = true;
    else if (arg === "--days") opts.days = numberAfter(arg);
    else if (arg === "--sample-percent") opts.samplePercent = numberAfter(arg);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  resolveOptions(opts);
  return opts;
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: BaselineOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`[analytics-storage-baseline] ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  let db: ReadOnlySession;
  try {
    db = await openReadOnly();
  } catch (error) {
    console.error(`[analytics-storage-baseline] no read-only session: ${(error as Error).message}`);
    return 2;
  }
  try {
    const report = await collectBaseline(db, opts);
    if (!report.in_recovery) {
      console.error(
        `[analytics-storage-baseline] warning: ${db.target} is not a standby (pg_is_in_recovery() is false). ` +
          "The target is the production read replica: point HOME at a directory whose .env names it as host.",
      );
    }
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    await db.close();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

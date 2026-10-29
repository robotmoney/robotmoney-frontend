// The tokenless, read-only analytics data API (issue #1095, decision D58).
//
// WHAT IT SERVES. The four stores an analyst needs to audit or rebuild the
// regime inputs: the raw indicator floor (`raw_indicator_history`), the asset
// price series (`asset_prices`), the frozen data vintages
// (`analytics_data_vintages` with their run, methodology and expanded member
// ids) and the recorded revisions (`analytics_overwrite_events`). Regime
// outputs and correlations are NOT here: they stay on
// GET /api/dashboards/regime-snapshots, whose response states which read path
// produced it (`source`), so there is one place that answers for them.
//
// WHY A PREFIX OF ITS OWN. /api/analytics/ is the analytics-PROVIDER boundary.
// api/index.ts gates it with a `startsWith` match and cors.ts lists it as a
// credentialed prefix, so a public route placed under it would inherit both.
// /api/public/analytics/ matches neither, on purpose.
//
// GET ONLY. Every other method answers 405 before anything is read, and no
// route here writes. A bearer token, if one is sent, is ignored: the body is
// the same with or without it.
//
// WHAT IT SERVES FROM WHICH PROVIDER. All of it. Yahoo-sourced rows are served
// like any other (D58: the repo operator signed off on 2026-10-02), so no route
// filters by provider and no response lists excluded providers.
//
// WHAT EVERY LIST RESPONSE CARRIES. `schemaVersion`, the effective `limit`
// (default 100, cap 1000, anything above is clamped) and `nextCursor` (opaque,
// null on the last page). Paging is keyset: a cursor names the last row served,
// so a row written while a client pages is seen once or not at all, never twice.
// Responses carry `Cache-Control: public, max-age=300` and a weak `ETag` of the
// body, answer a matching `If-None-Match` with 304, and are gzip-encoded when
// the client accepts it and the body is over 256 KB.
//
// ISSUE 1422: THE RECORD, AND ITS ARCHIVES. Two more list routes serve the
// record as it was: `source-versions` (every collected version of source data,
// with the time it was observed; `asof` gives the versions in force then) and
// `reports` (each run's published report, byte for byte, with its checksum;
// `run` or `vintage` names one). The archive routes serve format 1 backups (the
// robotmoney/csv-backups layout): `archive/backups` lists the sealed backups,
// and every file a backup record lists is served at `archive/` + its path.
// See analytics/store/public-archive-store.ts for what a backup is here.
//
// LOAD PROTECTION (issue 1422, see ../public-analytics-limits.ts). Every
// request spends weighted tokens (1, or 10 for a report's bytes or an archive
// body) and bytes from its client's per-minute budgets, else 429 with
// Retry-After. Every handler's statements run as ONE public read: a slot of a
// process-wide gate of 2 (else 503 with Retry-After), one READ ONLY
// transaction, a 5 s statement timeout (a timeout is 503 with Retry-After).
// JSON bodies are gzip-encoded off the event loop (node:zlib on the
// threadpool), never with a synchronous call on it.
//
// CACHING. Lists carry `Cache-Control: public, max-age=300` and a weak ETag of
// the body. A report and an archive file are immutable: a strong ETag that is
// their SHA-256, read before any bytes (a report's checksum column, a built
// backup record), so a matching If-None-Match answers 304 without reading or
// regenerating the body, and `Cache-Control: public, max-age=31536000,
// immutable`. Errors and refusals carry `no-store`.
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import type { TransactionSql } from "postgres";
import {
  PUBLIC_ANALYTICS_CACHE_CONTROL,
  PUBLIC_ANALYTICS_DEFAULT_LIMIT,
  PUBLIC_ANALYTICS_GZIP_MIN_BYTES,
  PUBLIC_ANALYTICS_HEAVY_COST,
  PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL,
  PUBLIC_ANALYTICS_LIST_COST,
  PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES,
  PUBLIC_ANALYTICS_MAX_LIMIT,
  PUBLIC_ANALYTICS_SCHEMA_VERSION,
  ROUTES,
} from "@robotmoney/contract";
import { on, registerQuery } from "../../db/registry.ts";
import { classifyDbFailure } from "../../db/client.ts";
import {
  archiveBodyStream,
  BACKUP_ID_RE,
  cachedRecord,
  fileIn,
  isServedBackup,
  listBackupIds,
  recordFor,
} from "../../analytics/store/public-archive-store.ts";
import { createClientBudgets, PublicBusyError, publicQueryGate, publicRead } from "../public-analytics-limits.ts";

const gzipAsync = promisify(gzipCb);
type Tx = TransactionSql<{}>;

const ROUTE = "src/api/routes/public-analytics";

// overwrite-events rows carry whole previous/replacement rows, and a
// regime_snapshots row is ~0.5 MB. The bound is applied IN SQL, before any row
// reaches this process: a running sum of pg_column_size(previous_row) +
// pg_column_size(replacement_row) over the page window keeps rows only while the
// sum BEFORE them is under OVERWRITE_PAGE_STORED_BYTES (so a page always holds
// the first row, and says so with a cursor when it stops short). pg_column_size
// is the stored (possibly compressed) size and reads no TOAST data, and the
// window only buffers TOAST pointers, so only the rows kept are ever detoasted. Stored size understates JSON text size, so the in-process
// OVERWRITE_PAGE_BYTE_BUDGET stays as a backstop on the serialized text.
export const OVERWRITE_PAGE_STORED_BYTES = 1024 * 1024;
const OVERWRITE_PAGE_BYTE_BUDGET = 8 * 1024 * 1024;

const budgets = createClientBudgets();
/** Forget every client's token and byte windows. For tests. */
export function _resetPublicAnalyticsRateLimitForTests(): void {
  budgets.reset();
}
/** Charge a client bytes as a served body would. For tests. */
export function _chargePublicAnalyticsBytesForTests(clientIp: string, bytes: number): void {
  budgets.chargeBytes(clientIp, bytes);
}
/** A client's remaining tokens and bytes. For tests. */
export function _publicAnalyticsBudgetForTests(clientIp: string): { tokens: number; bytes: number } {
  return budgets.peek(clientIp);
}

// ── Registered queries ──────────────────────────────────────────────────────
// ORDER BY names the TABLE's column (`raw_indicator_history.date`), never the
// bare name: a select-list alias such as `date::text AS date` would otherwise win
// the lookup, and the page would sort by the text cast. For `id::text AS id` that
// is not even the right order ("10" before "9"), and for the dates it defeats the
// primary-key index.
// Every statement below runs as rm_app and only reads (smoke-production-spec.md §7.1).

const readRawHistory = registerQuery({
  role: "rm_app",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listRawHistory",
  purpose: "Page raw_indicator_history by (date, indicator) for GET /api/public/analytics/raw-history.",
  callers: [ROUTE],
  probe: {
    statement: `SELECT date::text AS date, indicator, value, source FROM raw_indicator_history
      WHERE (date, indicator) > ($1::date, $2::text)
        AND date >= $3::date AND date <= $4::date
        AND ($5::text IS NULL OR indicator = $6::text)
      ORDER BY raw_indicator_history.date, raw_indicator_history.indicator
      LIMIT $7`,
    params: ["0001-01-01", "", "0001-01-01", "9999-12-31", null, null, 2],
  },
});

const readAssetPrices = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listAssetPrices",
  purpose: "Page asset_prices by (price_date, symbol, time_basis) for GET /api/public/analytics/asset-prices.",
  callers: [ROUTE],
  probe: {
    statement: `SELECT price_date::text AS price_date, symbol, time_basis, price_usd::float8 AS price_usd, currency, source,
        pool_key, token_address, observed_at, fetched_at, config_identity
      FROM asset_prices
      WHERE (price_date, symbol, time_basis) > ($1::date, $2::text, $3::text)
        AND price_date >= $4::date AND price_date <= $5::date
        AND ($6::text IS NULL OR symbol = $7::text)
      ORDER BY asset_prices.price_date, asset_prices.symbol, asset_prices.time_basis
      LIMIT $8`,
    params: ["0001-01-01", "", "", "0001-01-01", "9999-12-31", null, null, 2],
  },
});

const vintageProbe = {
  statement: `SELECT v.id::text AS id, r.run_key, r.asof::text AS asof, r.source_label, v.tool_id,
        v.knowledge_time_cutoff, v.market_time_cutoff::text AS market_time_cutoff, v.manifest_digest, v.member_count,
        v.build_identity, v.created_at, m.version_label, m.config_digest,
        rs.id::text AS report_id, rs.checksum AS report_checksum, rs.byte_length::text AS report_byte_length
      FROM analytics_data_vintages v
      JOIN analytics_ledger_runs r ON r.id = v.run_id
      JOIN analytics_ledger_methodology_versions m ON m.id = v.methodology_version_id
      LEFT JOIN analytics_report_snapshots rs ON rs.run_id = v.run_id
      WHERE v.id > $1::bigint
        AND ($2::text IS NULL OR r.run_key = $3::text)
        AND ($4::text IS NULL OR v.tool_id = $5::text)
      ORDER BY v.id
      LIMIT $6`,
  params: [0, null, null, null, null, 2],
} as const;

const readVintages = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listVintages",
  purpose: "Page frozen data vintages with their run and methodology for GET /api/public/analytics/vintages.",
  callers: [ROUTE],
  probe: vintageProbe,
});
const readVintageRuns = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listVintages.runs",
  purpose: "Join each vintage to its run header (run_key, asof, source_label) for GET /api/public/analytics/vintages.",
  callers: [ROUTE],
  probe: vintageProbe,
});
const readVintageMethodology = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_methodology_versions",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listVintages.methodology",
  purpose: "Join each vintage to its methodology version (label, config digest) for GET /api/public/analytics/vintages.",
  callers: [ROUTE],
  probe: vintageProbe,
});

const readVintageReports = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listVintages.reports",
  purpose: "Join each vintage to the report its run published (id, checksum, size) for GET /api/public/analytics/vintages (issue 1422).",
  callers: [ROUTE],
  probe: vintageProbe,
});

const readVintageMembers = registerQuery({
  role: "rm_app",
  object: "analytics_vintage_members",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listVintageMembers",
  purpose: "Page one vintage's members, each id range expanded to one row per source_value_versions id.",
  callers: [ROUTE],
  probe: {
    statement: `SELECT m.source_key, g.id::text AS source_value_version_id
      FROM analytics_vintage_members m
      CROSS JOIN LATERAL generate_series(
        GREATEST(m.source_value_version_id, $1::bigint + 1),
        COALESCE(m.last_source_value_version_id, m.source_value_version_id)
      ) AS g(id)
      WHERE m.vintage_id = $2::bigint
        AND COALESCE(m.last_source_value_version_id, m.source_value_version_id) > $3::bigint
      ORDER BY m.source_value_version_id, g.id
      LIMIT $4`,
    params: [0, 0, 0, 2],
  },
});

const OVERWRITE_STATEMENT = `WITH win AS (
        SELECT id, table_name, operation, natural_key, previous_row, replacement_row, recorded_at,
            COALESCE(pg_column_size(previous_row), 0) + COALESCE(pg_column_size(replacement_row), 0) AS stored_bytes
          FROM analytics_overwrite_events
          WHERE id > $1::bigint
            AND ($2::text IS NULL OR table_name = $3::text)
          ORDER BY analytics_overwrite_events.id
          LIMIT $4
      ), sized AS (
        SELECT win.*, sum(stored_bytes) OVER (ORDER BY id) AS running_bytes, count(*) OVER () AS window_rows FROM win
      )
      SELECT id::text AS id, table_name, operation, natural_key, previous_row, replacement_row, recorded_at,
          window_rows::int AS window_rows
        FROM sized
        WHERE running_bytes - stored_bytes < $5::bigint
        ORDER BY sized.id`;

const readOverwriteEvents = registerQuery({
  role: "rm_app",
  object: "analytics_overwrite_events",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listOverwriteEvents",
  purpose: "Page recorded revisions by id for GET /api/public/analytics/overwrite-events, bounded in SQL by the stored size of the rows it returns.",
  callers: [ROUTE],
  probe: {
    statement: OVERWRITE_STATEMENT,
    params: [0, null, null, 2, 1048576],
  },
});

const SOURCE_VERSIONS_STATEMENT = `SELECT s.id::text AS id, s.source_key, s.market_date::text AS market_date,
        to_char(s.market_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS market_instant, s.value,
        s.revision_kind, s.prior_version_id::text AS prior_version_id,
        to_char(s.knowledge_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS knowledge_time
      FROM source_value_versions s
      WHERE s.id > $1::bigint
        AND ($2::text IS NULL OR s.source_key = $3::text)
        AND (s.market_date IS NULL OR (s.market_date >= $4::date AND s.market_date <= $5::date))
        AND (s.market_instant IS NULL
          OR ((s.market_instant AT TIME ZONE 'UTC')::date >= $6::date AND (s.market_instant AT TIME ZONE 'UTC')::date <= $7::date))
        AND ($8::text::timestamptz IS NULL OR (s.knowledge_time <= $9::text::timestamptz
          AND NOT EXISTS (SELECT 1 FROM source_value_versions n
            WHERE n.source_key = s.source_key AND n.market_date = s.market_date AND n.market_instant IS NULL
              AND n.knowledge_time <= $10::text::timestamptz AND (n.knowledge_time, n.id) > (s.knowledge_time, s.id))
          AND NOT EXISTS (SELECT 1 FROM source_value_versions n
            WHERE n.source_key = s.source_key AND n.market_instant = s.market_instant AND n.market_date IS NULL
              AND n.knowledge_time <= $11::text::timestamptz AND (n.knowledge_time, n.id) > (s.knowledge_time, s.id))))
      ORDER BY s.id
      LIMIT $12`;

const readSourceVersions = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listSourceVersions",
  purpose: "Page every collected source data version by id, or the versions in force at an asof, for GET /api/public/analytics/source-versions (issue 1422).",
  callers: [ROUTE],
  probe: {
    statement: SOURCE_VERSIONS_STATEMENT,
    params: [0, null, null, "0001-01-01", "9999-12-31", "0001-01-01", "9999-12-31", null, null, null, null, 2],
  },
});

const REPORT_LIST_STATEMENT = `SELECT rs.id::text AS report_id, r.run_key, rs.asof::text AS asof, rs.checksum, rs.byte_length::text AS byte_length,
        rs.created_at
      FROM analytics_report_snapshots rs
      JOIN analytics_ledger_runs r ON r.id = rs.run_id
      WHERE rs.id > $1::bigint
      ORDER BY rs.id
      LIMIT $2`;
const readReportList = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listReports",
  purpose: "Page published reports (id, run, checksum, size; never the bytes) for GET /api/public/analytics/reports (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REPORT_LIST_STATEMENT, params: [0, 2] },
});
const readReportListRuns = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listReports.runs",
  purpose: "Join each published report to its run key for GET /api/public/analytics/reports (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REPORT_LIST_STATEMENT, params: [0, 2] },
});

const REPORT_BY_RUN_STATEMENT = `SELECT rs.id::text AS report_id, rs.checksum, rs.byte_length::text AS byte_length
      FROM analytics_report_snapshots rs
      JOIN analytics_ledger_runs r ON r.id = rs.run_id
      WHERE r.run_key = $1::text`;
const readReportByRun = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:reportByRun",
  purpose: "Find a run's published report and its checksum, without its bytes, for GET /api/public/analytics/reports?run= (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REPORT_BY_RUN_STATEMENT, params: ["probe"] },
});
const readReportByRunRuns = registerQuery({
  role: "rm_app",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:reportByRun.runs",
  purpose: "Resolve a run key to its run for GET /api/public/analytics/reports?run= (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REPORT_BY_RUN_STATEMENT, params: ["probe"] },
});

const REPORT_BY_VINTAGE_STATEMENT = `SELECT rs.id::text AS report_id, rs.checksum, rs.byte_length::text AS byte_length
      FROM analytics_report_snapshots rs
      JOIN analytics_data_vintages v ON v.run_id = rs.run_id
      WHERE v.id = $1::bigint`;
const readReportByVintage = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:reportByVintage",
  purpose: "Find the report a vintage's run published and its checksum, without its bytes, for GET /api/public/analytics/reports?vintage= (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REPORT_BY_VINTAGE_STATEMENT, params: [1] },
});
const readReportByVintageVintages = registerQuery({
  role: "rm_app",
  object: "analytics_data_vintages",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:reportByVintage.vintages",
  purpose: "Resolve a vintage id to its run for GET /api/public/analytics/reports?vintage= (issue 1422).",
  callers: [ROUTE],
  probe: { statement: REPORT_BY_VINTAGE_STATEMENT, params: [1] },
});

const readReportBytes = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:reportBytes",
  purpose: "Read one published report's exact stored bytes for GET /api/public/analytics/reports (issue 1422).",
  callers: [ROUTE],
  probe: { statement: "SELECT report_bytes FROM analytics_report_snapshots WHERE id = $1::bigint", params: [1] },
});

// ── Parsing ─────────────────────────────────────────────────────────────────

class BadRequest extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DATE = "0001-01-01";
const MAX_DATE = "9999-12-31";

// A real calendar day in Postgres' date range. The ISO round-trip rejects
// 2024-13-45 and 2023-02-29; the bounds reject 0000-01-01, which JS accepts and
// Postgres' ::date does not.
function isCalendarDate(v: string): boolean {
  if (!DATE_RE.test(v) || v < MIN_DATE || v > MAX_DATE) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

// Postgres text cannot hold a NUL byte; it raises instead of storing or comparing.
const hasNul = (v: string): boolean => v.includes("\u0000");

function dateParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  if (!isCalendarDate(v)) throw new BadRequest(`${name} must be a valid YYYY-MM-DD date`);
  return v;
}

function textParam(url: URL, name: string, maxLength = 128): string | null {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  if (v === "" || v.length > maxLength || hasNul(v)) throw new BadRequest(`${name} must be 1 to ${maxLength} characters, without NUL`);
  return v;
}

function limitParam(url: URL): number {
  const v = url.searchParams.get("limit");
  if (v === null) return PUBLIC_ANALYTICS_DEFAULT_LIMIT;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new BadRequest("limit must be a positive integer");
  return Math.min(Number(v), PUBLIC_ANALYTICS_MAX_LIMIT);
}

function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function decodeCursor(url: URL, shape: readonly ("date" | "text" | "id")[]): (string)[] | null {
  const v = url.searchParams.get("cursor");
  if (v === null) return null;
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    throw new BadRequest("cursor is not valid");
  }
  const ok =
    Array.isArray(parts) &&
    parts.length === shape.length &&
    parts.every((p, i) =>
      typeof p === "string" && p.length <= 256 &&
      !hasNul(p) &&
      (shape[i] === "date" ? isCalendarDate(p) : shape[i] === "id" ? /^\d{1,18}$/.test(p) : true),
    );
  if (!ok) throw new BadRequest("cursor is not valid");
  return parts as string[];
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : new Date(d as string).toISOString());

// ── Handlers: each returns the body; the transport below wraps it ───────────

async function rawHistory(url: URL, tx: Tx) {
  const limit = limitParam(url);
  const indicator = textParam(url, "indicator");
  const from = dateParam(url, "from") ?? MIN_DATE;
  const to = dateParam(url, "to") ?? MAX_DATE;
  const cursor = decodeCursor(url, ["date", "text"]) ?? [MIN_DATE, ""];
  const rows = await on(tx, readRawHistory)<{ date: string; indicator: string; value: number; source: string }>`
    SELECT date::text AS date, indicator, value, source FROM raw_indicator_history
      WHERE (date, indicator) > (${cursor[0]}::date, ${cursor[1]}::text)
        AND date >= ${from}::date AND date <= ${to}::date
        AND (${indicator}::text IS NULL OR indicator = ${indicator}::text)
      ORDER BY raw_indicator_history.date, raw_indicator_history.indicator
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    rows: page.map((r) => ({ date: r.date, indicator: r.indicator, value: Number(r.value), source: r.source })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.date, last.indicator]) : null,
  };
}

async function assetPrices(url: URL, tx: Tx) {
  const limit = limitParam(url);
  const symbol = textParam(url, "symbol");
  const from = dateParam(url, "from") ?? MIN_DATE;
  const to = dateParam(url, "to") ?? MAX_DATE;
  const cursor = decodeCursor(url, ["date", "text", "text"]) ?? [MIN_DATE, "", ""];
  const rows = await on(tx, readAssetPrices)<{
    price_date: string; symbol: string; time_basis: string; price_usd: number; currency: string; source: string;
    pool_key: string | null; token_address: string | null; observed_at: Date; fetched_at: Date; config_identity: string;
  }>`
    SELECT price_date::text AS price_date, symbol, time_basis, price_usd::float8 AS price_usd, currency, source,
        pool_key, token_address, observed_at, fetched_at, config_identity
      FROM asset_prices
      WHERE (price_date, symbol, time_basis) > (${cursor[0]}::date, ${cursor[1]}::text, ${cursor[2]}::text)
        AND price_date >= ${from}::date AND price_date <= ${to}::date
        AND (${symbol}::text IS NULL OR symbol = ${symbol}::text)
      ORDER BY asset_prices.price_date, asset_prices.symbol, asset_prices.time_basis
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    rows: page.map((r) => ({
      price_date: r.price_date,
      symbol: r.symbol,
      time_basis: r.time_basis,
      price_usd: Number(r.price_usd),
      currency: r.currency,
      source: r.source,
      pool_key: r.pool_key,
      token_address: r.token_address,
      observed_at: iso(r.observed_at),
      fetched_at: iso(r.fetched_at),
      config_identity: r.config_identity,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.price_date, last.symbol, last.time_basis]) : null,
  };
}

interface VintageRow {
  id: string; run_key: string; asof: string; source_label: string; tool_id: string; knowledge_time_cutoff: Date;
  market_time_cutoff: string; manifest_digest: string; member_count: number; build_identity: string; created_at: Date;
  version_label: string; config_digest: string;
  report_id: string | null; report_checksum: string | null; report_byte_length: string | null;
}

async function vintages(url: URL, tx: Tx) {
  const limit = limitParam(url);
  const runKey = textParam(url, "run_key", 64);
  const toolId = textParam(url, "tool_id", 64);
  const include = url.searchParams.get("include");
  if (include !== null && include !== "members") throw new BadRequest("include must be members");
  const withMembers = include === "members";
  // Members are one row per source_value_versions id: ~170k for a production
  // vintage. They are served one vintage at a time, paged by the same limit and
  // cursor, so the cursor means "the next page of THIS vintage's members" here
  // and "the next vintage" otherwise.
  if (withMembers && (runKey === null || toolId === null)) {
    throw new BadRequest("include=members needs run_key and tool_id, so exactly one vintage is named");
  }
  const cursor = withMembers ? null : decodeCursor(url, ["id"]);
  const rows = await on(tx, readVintages, readVintageRuns, readVintageMethodology, readVintageReports)<VintageRow>`
    SELECT v.id::text AS id, r.run_key, r.asof::text AS asof, r.source_label, v.tool_id,
        v.knowledge_time_cutoff, v.market_time_cutoff::text AS market_time_cutoff, v.manifest_digest, v.member_count,
        v.build_identity, v.created_at, m.version_label, m.config_digest,
        rs.id::text AS report_id, rs.checksum AS report_checksum, rs.byte_length::text AS report_byte_length
      FROM analytics_data_vintages v
      JOIN analytics_ledger_runs r ON r.id = v.run_id
      JOIN analytics_ledger_methodology_versions m ON m.id = v.methodology_version_id
      LEFT JOIN analytics_report_snapshots rs ON rs.run_id = v.run_id
      WHERE v.id > ${cursor?.[0] ?? "0"}::bigint
        AND (${runKey}::text IS NULL OR r.run_key = ${runKey}::text)
        AND (${toolId}::text IS NULL OR v.tool_id = ${toolId}::text)
      ORDER BY v.id
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const out = [];
  for (const v of page) {
    out.push({
      id: Number(v.id),
      run_key: v.run_key,
      tool_id: v.tool_id,
      asof: v.asof,
      source_label: v.source_label,
      knowledge_time_cutoff: iso(v.knowledge_time_cutoff),
      market_time_cutoff: v.market_time_cutoff,
      manifest_digest: v.manifest_digest,
      member_count: Number(v.member_count),
      build_identity: v.build_identity,
      methodology: { tool_id: v.tool_id, version_label: v.version_label, config_digest: v.config_digest },
      created_at: iso(v.created_at),
      report: v.report_id === null
        ? null
        : { report_id: Number(v.report_id), checksum: v.report_checksum!, byte_length: Number(v.report_byte_length) },
      ...(withMembers ? { members: await vintageMembers(url, tx, v.id, limit) } : {}),
    });
  }
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    vintages: out,
    nextCursor: !withMembers && rows.length > limit && last ? encodeCursor([last.id]) : null,
  };
}

async function vintageMembers(url: URL, tx: Tx, vintageId: string, limit: number) {
  const after = decodeCursor(url, ["id"])?.[0] ?? "0";
  const rows = await on(tx, readVintageMembers)<{ source_key: string; source_value_version_id: string }>`
    SELECT m.source_key, g.id::text AS source_value_version_id
      FROM analytics_vintage_members m
      CROSS JOIN LATERAL generate_series(
        GREATEST(m.source_value_version_id, ${after}::bigint + 1),
        COALESCE(m.last_source_value_version_id, m.source_value_version_id)
      ) AS g(id)
      WHERE m.vintage_id = ${vintageId}::bigint
        AND COALESCE(m.last_source_value_version_id, m.source_value_version_id) > ${after}::bigint
      ORDER BY m.source_value_version_id, g.id
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({ source_key: r.source_key, source_value_version_id: Number(r.source_value_version_id) })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.source_value_version_id]) : null,
  };
}

// asset_prices since migration 0128 (API-6): a revised price is a recorded revision too.
const OVERWRITE_TABLES = ["raw_indicator_history", "regime_snapshots", "research_signals", "asset_prices"];

async function overwriteEvents(url: URL, tx: Tx) {
  const limit = limitParam(url);
  const tableName = textParam(url, "table_name");
  if (tableName !== null && !OVERWRITE_TABLES.includes(tableName)) {
    throw new BadRequest(`table_name must be one of ${OVERWRITE_TABLES.join(", ")}`);
  }
  const cursor = decodeCursor(url, ["id"]);
  const all = await on(tx, readOverwriteEvents)<{
    id: string; table_name: string; operation: string; natural_key: unknown; previous_row: unknown;
    replacement_row: unknown; recorded_at: Date; window_rows: number;
  }>`WITH win AS (
        SELECT id, table_name, operation, natural_key, previous_row, replacement_row, recorded_at,
            COALESCE(pg_column_size(previous_row), 0) + COALESCE(pg_column_size(replacement_row), 0) AS stored_bytes
          FROM analytics_overwrite_events
          WHERE id > ${cursor?.[0] ?? "0"}::bigint
            AND (${tableName}::text IS NULL OR table_name = ${tableName}::text)
          ORDER BY analytics_overwrite_events.id
          LIMIT ${limit + 1}
      ), sized AS (
        SELECT win.*, sum(stored_bytes) OVER (ORDER BY id) AS running_bytes, count(*) OVER () AS window_rows FROM win
      )
      SELECT id::text AS id, table_name, operation, natural_key, previous_row, replacement_row, recorded_at,
          window_rows::int AS window_rows
        FROM sized
        WHERE running_bytes - stored_bytes < ${OVERWRITE_PAGE_STORED_BYTES}::bigint
        ORDER BY sized.id`;
  const rows = all.slice(0, limit);
  const windowRows = all[0]?.window_rows ?? 0;
  const events: Record<string, unknown>[] = [];
  let bytes = 0;
  let more = windowRows > rows.length;
  let lastId = "";
  for (const r of rows) {
    const event = {
      id: Number(r.id),
      table_name: r.table_name,
      operation: r.operation,
      natural_key: r.natural_key,
      previous_row: r.previous_row,
      replacement_row: r.replacement_row,
      recorded_at: iso(r.recorded_at),
    };
    bytes += JSON.stringify(event).length;
    if (events.length > 0 && bytes > OVERWRITE_PAGE_BYTE_BUDGET) {
      more = true;
      break;
    }
    events.push(event);
    lastId = r.id;
  }
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    events,
    nextCursor: more && lastId ? encodeCursor([lastId]) : null,
  };
}

const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** `asof`: a date (its last microsecond, UTC) or an ISO date-time, kept as given. */
function asofParam(url: URL): string | null {
  const v = url.searchParams.get("asof");
  if (v === null) return null;
  if (!ISO_TIME_RE.test(v)) throw new BadRequest("asof must be a YYYY-MM-DD date or an ISO 8601 date-time");
  if (v.length === 10) {
    if (!isCalendarDate(v)) throw new BadRequest("asof must be a valid date");
    return `${v}T23:59:59.999999Z`;
  }
  if (Number.isNaN(Date.parse(v)) || !isCalendarDate(v.slice(0, 10))) throw new BadRequest("asof must be a valid date-time");
  // Kept exactly as given: Postgres reads it (::timestamptz) to the microsecond.
  return v;
}

async function sourceVersions(url: URL, tx: Tx) {
  const limit = limitParam(url);
  const series = textParam(url, "series");
  const from = dateParam(url, "from") ?? MIN_DATE;
  const to = dateParam(url, "to") ?? MAX_DATE;
  const asof = asofParam(url);
  const cursor = decodeCursor(url, ["id"]);
  const rows = await on(tx, readSourceVersions)<{
    id: string; source_key: string; market_date: string | null; market_instant: string | null; value: number;
    revision_kind: string; prior_version_id: string | null; knowledge_time: string;
  }>`SELECT s.id::text AS id, s.source_key, s.market_date::text AS market_date,
        to_char(s.market_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS market_instant, s.value,
        s.revision_kind, s.prior_version_id::text AS prior_version_id,
        to_char(s.knowledge_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS knowledge_time
      FROM source_value_versions s
      WHERE s.id > ${cursor?.[0] ?? "0"}::bigint
        AND (${series}::text IS NULL OR s.source_key = ${series}::text)
        AND (s.market_date IS NULL OR (s.market_date >= ${from}::date AND s.market_date <= ${to}::date))
        AND (s.market_instant IS NULL
          OR ((s.market_instant AT TIME ZONE 'UTC')::date >= ${from}::date AND (s.market_instant AT TIME ZONE 'UTC')::date <= ${to}::date))
        AND (${asof}::text::timestamptz IS NULL OR (s.knowledge_time <= ${asof}::text::timestamptz
          AND NOT EXISTS (SELECT 1 FROM source_value_versions n
            WHERE n.source_key = s.source_key AND n.market_date = s.market_date AND n.market_instant IS NULL
              AND n.knowledge_time <= ${asof}::text::timestamptz AND (n.knowledge_time, n.id) > (s.knowledge_time, s.id))
          AND NOT EXISTS (SELECT 1 FROM source_value_versions n
            WHERE n.source_key = s.source_key AND n.market_instant = s.market_instant AND n.market_date IS NULL
              AND n.knowledge_time <= ${asof}::text::timestamptz AND (n.knowledge_time, n.id) > (s.knowledge_time, s.id))))
      ORDER BY s.id
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    asof,
    rows: page.map((r) => ({
      id: Number(r.id),
      series: r.source_key,
      market_date: r.market_date,
      // Microseconds, as stored: a JS Date would cut them to milliseconds.
      market_instant: r.market_instant,
      value: Number(r.value),
      revision_kind: r.revision_kind,
      prior_version_id: r.prior_version_id === null ? null : Number(r.prior_version_id),
      knowledge_time: r.knowledge_time,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.id]) : null,
  };
}

async function reportList(url: URL, tx: Tx) {
  const limit = limitParam(url);
  const cursor = decodeCursor(url, ["id"]);
  const rows = await on(tx, readReportList, readReportListRuns)<{
    report_id: string; run_key: string; asof: string; checksum: string; byte_length: string; created_at: Date;
  }>`SELECT rs.id::text AS report_id, r.run_key, rs.asof::text AS asof, rs.checksum, rs.byte_length::text AS byte_length,
        rs.created_at
      FROM analytics_report_snapshots rs
      JOIN analytics_ledger_runs r ON r.id = rs.run_id
      WHERE rs.id > ${cursor?.[0] ?? "0"}::bigint
      ORDER BY rs.id
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    reports: page.map((r) => ({
      report_id: Number(r.report_id),
      run_key: r.run_key,
      asof: r.asof,
      checksum: r.checksum,
      byte_length: Number(r.byte_length),
      created_at: iso(r.created_at),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.report_id]) : null,
  };
}

const RUN_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `run` or `vintage` (one, not both), or null when neither names a report. */
function reportSelector(url: URL): { run: string } | { vintage: string } | null {
  const run = url.searchParams.get("run");
  const vintage = url.searchParams.get("vintage");
  if (run !== null && vintage !== null) throw new BadRequest("name a report by run or by vintage, not both");
  if (run !== null) {
    if (!RUN_KEY_RE.test(run)) throw new BadRequest("run must be a run key (a lowercase UUID)");
    return { run };
  }
  if (vintage !== null) {
    if (!/^[1-9]\d{0,17}$/.test(vintage)) throw new BadRequest("vintage must be a positive integer id");
    return { vintage };
  }
  return null;
}

// ── Transport ───────────────────────────────────────────────────────────────

function problem(status: number, error: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function etagOf(bytes: Uint8Array): string {
  return `W/"${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || opaque(t) === opaque(etag));
}

function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().split(";");
    if (coding!.trim().toLowerCase() !== "gzip") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** A body as sent: gzip-encoded (on the threadpool, never on the event loop) when the client accepts it and it is large. */
async function encoded(req: Request, identity: Uint8Array, headers: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
  if (identity.length > PUBLIC_ANALYTICS_GZIP_MIN_BYTES && acceptsGzip(req.headers.get("accept-encoding"))) {
    headers["Content-Encoding"] = "gzip";
    return new Uint8Array(await gzipAsync(identity));
  }
  return new Uint8Array(identity);
}

/** What a handler answers: the response, and the bytes to charge for it. */
interface Sent {
  res: Response;
  bytes: number;
}

async function okJson(req: Request, body: unknown, cacheControl = PUBLIC_ANALYTICS_CACHE_CONTROL): Promise<Sent> {
  const identity = new TextEncoder().encode(JSON.stringify(body));
  const etag = etagOf(identity);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": cacheControl,
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (matchesEtag(req.headers.get("if-none-match"), etag)) return { res: new Response(null, { status: 304, headers }), bytes: 0 };
  const sent = await encoded(req, identity, headers);
  return { res: new Response(sent, { status: 200, headers }), bytes: sent.length };
}

const strongEtag = (sha256: string): string => `"${sha256}"`;

/** A report's exact stored bytes, or 304 from its checksum alone. */
async function reportBytes(req: Request, sel: { run: string } | { vintage: string }): Promise<Sent> {
  const found = await publicRead(async (tx) => {
    const [meta] = "run" in sel
      ? await on(tx, readReportByRun, readReportByRunRuns)<{ report_id: string; checksum: string; byte_length: string }>`SELECT rs.id::text AS report_id, rs.checksum, rs.byte_length::text AS byte_length
      FROM analytics_report_snapshots rs
      JOIN analytics_ledger_runs r ON r.id = rs.run_id
      WHERE r.run_key = ${sel.run}::text`
      : await on(tx, readReportByVintage, readReportByVintageVintages)<{ report_id: string; checksum: string; byte_length: string }>`SELECT rs.id::text AS report_id, rs.checksum, rs.byte_length::text AS byte_length
      FROM analytics_report_snapshots rs
      JOIN analytics_data_vintages v ON v.run_id = rs.run_id
      WHERE v.id = ${sel.vintage}::bigint`;
    if (!meta) return null;
    // A matching If-None-Match is answered from the checksum alone: the bytes are never read.
    if (matchesEtag(req.headers.get("if-none-match"), strongEtag(meta.checksum))) return { meta, bytes: null };
    const [row] = await on(tx, readReportBytes)<{ report_bytes: Uint8Array }>`SELECT report_bytes FROM analytics_report_snapshots WHERE id = ${meta.report_id}::bigint`;
    return { meta, bytes: row ? new Uint8Array(row.report_bytes) : null };
  });
  if (!found) return { res: problem(404, "no published report for that run or vintage"), bytes: 0 };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL,
    ETag: strongEtag(found.meta.checksum),
    "X-Content-SHA256": found.meta.checksum,
    "X-Report-Id": found.meta.report_id,
    Vary: "Accept-Encoding",
  };
  if (found.bytes === null) return { res: new Response(null, { status: 304, headers }), bytes: 0 };
  const sent = await encoded(req, found.bytes, headers);
  return { res: new Response(sent, { status: 200, headers }), bytes: sent.length };
}

const R = ROUTES.publicAnalytics;
const LISTS: Record<string, (url: URL, tx: Tx) => Promise<unknown>> = {
  [R.rawHistory]: rawHistory,
  [R.assetPrices]: assetPrices,
  [R.sourceVersions]: sourceVersions,
  [R.vintages]: vintages,
  [R.overwriteEvents]: overwriteEvents,
};

// ── Archive routes ─────────────────────────────────────────────────────────

/** How long a request for an unbuilt backup record waits for it before answering 503. */
const RECORD_WAIT_MS = 4_000;
const RECORD_RETRY_AFTER = "10";

async function archiveBackups(req: Request, url: URL): Promise<Sent> {
  const limit = limitParam(url);
  const after = url.searchParams.get("cursor");
  if (after !== null && !BACKUP_ID_RE.test(after)) throw new BadRequest("cursor is not valid");
  const all = await listBackupIds();
  const rest = after === null ? all : all.filter((id) => id > after);
  const page = rest.slice(0, limit);
  return okJson(req, {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    format: 1,
    backups: page.map((backup) => ({ backup, record: `csv/${backup}/backup.json` })),
    nextCursor: rest.length > limit ? page[page.length - 1]! : null,
  });
}

/** The built record, waiting a bounded time for a build; null when it is still building. */
async function awaitRecord(id: string) {
  const have = cachedRecord(id);
  if (have) return have;
  const p = recordFor(id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RECORD_WAIT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A backup id of either shape: a day cut, or the legacy junction (issue 1477); isServedBackup decides which exist.
const ARCHIVE_PATH_RE = /^csv\/(\d{4}-\d{2}-\d{2}T\d{6}Z)\/(backup\.json|data\/[a-z_]+\.\d{4}-\d{2}-\d{2}T\d{6}Z_\d{4}-\d{2}-\d{2}T\d{6}Z(?:-\d+)?\.csv\.gz)$/;

function building(): Response {
  return problem(503, "this backup's record is being prepared; retry after the interval", { "Retry-After": RECORD_RETRY_AFTER });
}

async function archiveFile(req: Request, path: string, clientIp: string): Promise<Sent> {
  const m = ARCHIVE_PATH_RE.exec(path);
  if (!m || !(await isServedBackup(m[1]!))) return { res: problem(404, "no such backup or archive"), bytes: 0 };
  const built = await awaitRecord(m[1]!);
  if (!built) return { res: building(), bytes: 0 };
  if (m[2] === "backup.json") {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL,
      ETag: strongEtag(built.sha256),
      "X-Content-SHA256": built.sha256,
      Vary: "Accept-Encoding",
    };
    if (matchesEtag(req.headers.get("if-none-match"), headers.ETag!)) return { res: new Response(null, { status: 304, headers }), bytes: 0 };
    const sent = await encoded(req, built.bytes, headers);
    return { res: new Response(sent, { status: 200, headers }), bytes: sent.length };
  }
  const hit = fileIn(built, path);
  if (!hit) return { res: problem(404, "no such archive in this backup"), bytes: 0 };
  const headers: Record<string, string> = {
    "Content-Type": "application/gzip",
    "Cache-Control": PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL,
    ETag: strongEtag(hit.file.sha256_raw),
    "X-Content-SHA256": hit.file.sha256_raw,
  };
  // The ETag is the record's sha256_raw (the content, never the gzip): a revalidation never regenerates the body.
  if (matchesEtag(req.headers.get("if-none-match"), headers.ETag!)) return { res: new Response(null, { status: 304, headers }), bytes: 0 };
  // Admission: the body's pages wait for gate slots once streaming, so a new
  // body is refused up front when the gate is already full.
  if (publicQueryGate.inUse() >= PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES) throw new PublicBusyError(1);
  // Charged in full on admission (§4.8): the client's byte budget may go
  // negative. The gzip size depends on the encoder, so the charge is the
  // content size, an upper bound of what is sent.
  budgets.chargeBytes(clientIp, hit.file.bytes_raw);
  return { res: new Response(archiveBodyStream(hit.table, hit.file), { status: 200, headers }), bytes: 0 };
}

/** The token cost of a request: heavy for a report's bytes or an archive body. */
function costOf(url: URL): number {
  const p = url.pathname;
  if (p === R.reports && (url.searchParams.has("run") || url.searchParams.has("vintage"))) return PUBLIC_ANALYTICS_HEAVY_COST;
  if (p.startsWith(R.archiveFiles) && p.endsWith(".csv.gz")) return PUBLIC_ANALYTICS_HEAVY_COST;
  return PUBLIC_ANALYTICS_LIST_COST;
}

async function dispatch(req: Request, url: URL, clientIp: string): Promise<Sent | null> {
  const p = url.pathname;
  const list = LISTS[p];
  if (list) return okJson(req, await publicRead((tx) => list(url, tx)));
  if (p === R.reports) {
    const sel = reportSelector(url);
    if (sel) return reportBytes(req, sel);
    return okJson(req, await publicRead((tx) => reportList(url, tx)));
  }
  if (p === R.archiveBackups) return archiveBackups(req, url);
  if (p.startsWith(R.archiveFiles)) return archiveFile(req, p.slice(R.archiveFiles.length), clientIp);
  return null;
}

/**
 * Answer one request under /api/public/analytics/. Always returns a Response:
 * 429 over the client's token or byte budget, 405 for any method but GET, 404
 * for a path that is no route, 400 for a bad parameter or cursor, 503 with
 * Retry-After when the public query gate is full, a query timed out, or a
 * backup record is still being prepared, else the body.
 */
export async function handlePublicAnalytics(req: Request, url: URL, clientIp: string): Promise<Response> {
  const verdict = budgets.admit(clientIp, costOf(url));
  if (!verdict.admitted) {
    return problem(429, verdict.reason === "bytes" ? "byte budget exceeded" : "rate limit exceeded", {
      "Retry-After": String(verdict.retryAfterSeconds),
    });
  }
  if (req.method !== "GET") return problem(405, "method not allowed", { Allow: "GET" });
  // An encoded slash names no route here, and a proxy may match it differently.
  if (/%2f/i.test(new URL(req.url).pathname)) return problem(404, "not found");
  try {
    const sent = await dispatch(req, url, clientIp);
    if (!sent) return problem(404, "not found");
    budgets.chargeBytes(clientIp, sent.bytes);
    return sent.res;
  } catch (err) {
    if (err instanceof BadRequest) return problem(400, err.message);
    if (err instanceof PublicBusyError) {
      return problem(503, "public analytics is busy", { "Retry-After": String(err.retryAfterSeconds) });
    }
    // A full request pool, or a statement the 5 s timeout cancelled: transient, 503 with Retry-After.
    const failure = classifyDbFailure(err);
    if (failure === "db_saturated") return problem(503, "db_saturated", { "Retry-After": "1" });
    if (failure === "db_timeout") return problem(503, "query timed out", { "Retry-After": "5" });
    // A value that passed the checks above but Postgres still refuses is the
    // caller's input, not a server fault: SQLSTATE class 22 is "data exception".
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("22")) return problem(400, "a parameter is out of range");
    // Anything else keeps its own meaning: index.ts answers it (503 for an
    // unreachable database, else 500).
    throw err;
  }
}

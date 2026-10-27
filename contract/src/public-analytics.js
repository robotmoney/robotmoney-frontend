// Constants of the tokenless public analytics API (issue #1095, D58; issue 1422).
// Pure data, like routes.js. The JSON schemas of the JSON responses sit beside
// this file in schemas/, one per route. Every list body requires `schemaVersion`;
// the archive route's schema describes a format 1 `backup.json` record. A
// report body and an archive body are bytes, not JSON pages, and have no schema.

/** The `schemaVersion` every public analytics response carries. Bump on a breaking change to any schema. */
export const PUBLIC_ANALYTICS_SCHEMA_VERSION = 1;

/** Rows per page when ?limit= is absent. */
export const PUBLIC_ANALYTICS_DEFAULT_LIMIT = 100;

/** The cap on ?limit=. A larger value is clamped to this, not refused. */
export const PUBLIC_ANALYTICS_MAX_LIMIT = 1000;

/** A body over this many bytes is gzip-encoded for a client that accepts gzip. */
export const PUBLIC_ANALYTICS_GZIP_MIN_BYTES = 256 * 1024;

/** The `Cache-Control` of every successful list response (lists change as data arrives). */
export const PUBLIC_ANALYTICS_CACHE_CONTROL = "public, max-age=300";

/**
 * The `Cache-Control` of an immutable body: a published report, a sealed
 * backup's `backup.json` and every archive it lists (issue 1422). Its ETag is
 * its SHA-256, so a client revalidates without the server reading the bytes.
 */
export const PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

// ── Server load protection (issue 1422) ────────────────────────────────────
// Public traffic must never starve the site. These budgets apply to every
// route under /api/public/analytics/, archive routes included.

/** Public-analytics queries that may hold a database connection at once, process-wide. Beyond: 503 + Retry-After. */
export const PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES = 2;

/** Every public query runs with this statement timeout. A timed-out query answers 503 + Retry-After. */
export const PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS = 5000;

/** Weighted tokens per client ip per minute. */
export const PUBLIC_ANALYTICS_TOKENS_PER_MINUTE = 100;

/** Token cost of a list request (every route not named heavy). */
export const PUBLIC_ANALYTICS_LIST_COST = 1;

/** Token cost of a heavy request: an archive body or a published report's bytes. */
export const PUBLIC_ANALYTICS_HEAVY_COST = 10;

/**
 * Bytes served per client ip per minute. A request is admitted while the
 * client has any budget left; an archive is charged in full, so the budget may
 * go negative, and later requests answer 429 + Retry-After until it recovers.
 */
export const PUBLIC_ANALYTICS_BYTES_PER_MINUTE = 50 * 1024 * 1024;

// ── Format 1 archives (issue 1422, the robotmoney/csv-backups layout) ──────

/** The `format` every served backup record carries. */
export const ARCHIVE_FORMAT = 1;

/** Largest uncompressed archive part, as csvb's default `--part-mb 64`. A row is never cut. */
export const ARCHIVE_PART_BYTES = 64 * 1024 * 1024;

/** A served backup is named by its UTC day boundary and is sealed this long after it. */
export const ARCHIVE_SETTLE_MS = 60 * 60 * 1000;

/**
 * Route path -> schema file (relative to this directory), for every JSON list
 * route under ROUTES.publicAnalytics (every route but the archiveFiles prefix).
 * A test asserts each route has an entry and each file exists.
 */
export const PUBLIC_ANALYTICS_SCHEMAS = {
  "/api/public/analytics/raw-history": "schemas/public-analytics-raw-history.schema.json",
  "/api/public/analytics/asset-prices": "schemas/public-analytics-asset-prices.schema.json",
  "/api/public/analytics/vintages": "schemas/public-analytics-vintages.schema.json",
  "/api/public/analytics/overwrite-events": "schemas/public-analytics-overwrite-events.schema.json",
  "/api/public/analytics/source-versions": "schemas/public-analytics-source-versions.schema.json",
  "/api/public/analytics/reports": "schemas/public-analytics-reports.schema.json",
  "/api/public/analytics/archive/backups": "schemas/public-analytics-archive-backups.schema.json",
};

/**
 * The schema of a format 1 `backup.json` record, served under
 * ROUTES.publicAnalytics.archiveFiles. Not a list page, so it carries `format`
 * rather than `schemaVersion`. The archives it lists are gzipped COPY CSV.
 */
export const ARCHIVE_BACKUP_RECORD_SCHEMA = "schemas/public-analytics-archive-backup-record.schema.json";

// Constants of the tokenless public analytics API (issue #1095, D58). Pure data,
// like routes.js. The JSON schemas of the four responses sit beside this file in
// schemas/, one per route, each requiring `schemaVersion`.

/** The `schemaVersion` every public analytics response carries. Bump on a breaking change to any schema. */
export const PUBLIC_ANALYTICS_SCHEMA_VERSION = 1;

/** Rows per page when ?limit= is absent. */
export const PUBLIC_ANALYTICS_DEFAULT_LIMIT = 100;

/** The cap on ?limit=. A larger value is clamped to this, not refused. */
export const PUBLIC_ANALYTICS_MAX_LIMIT = 1000;

/** A body over this many bytes is gzip-encoded for a client that accepts gzip. */
export const PUBLIC_ANALYTICS_GZIP_MIN_BYTES = 256 * 1024;

/** The `Cache-Control` of every successful public analytics response. */
export const PUBLIC_ANALYTICS_CACHE_CONTROL = "public, max-age=300";

/**
 * Route path -> schema file (relative to this directory), for every route under
 * ROUTES.publicAnalytics. A test asserts each route has an entry and each file exists.
 */
export const PUBLIC_ANALYTICS_SCHEMAS = {
  "/api/public/analytics/raw-history": "schemas/public-analytics-raw-history.schema.json",
  "/api/public/analytics/asset-prices": "schemas/public-analytics-asset-prices.schema.json",
  "/api/public/analytics/vintages": "schemas/public-analytics-vintages.schema.json",
  "/api/public/analytics/overwrite-events": "schemas/public-analytics-overwrite-events.schema.json",
};

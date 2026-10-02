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
// WHAT IT WITHHOLDS. Yahoo-sourced rows (D58): the indicators whose registry
// source is yahoo, from raw-history, from the vintage members and from
// overwrite events on raw_indicator_history, and any asset_prices row whose
// provider is yahoo. The set is derived from the indicator registry and the
// source-tolerance table, not from configuration, so it cannot be changed at
// deploy time and cannot drift from the extractors.
//
// WHAT EVERY LIST RESPONSE CARRIES. `schemaVersion`, the effective `limit`
// (default 100, cap 1000, anything above is clamped) and `nextCursor` (opaque,
// null on the last page). Paging is keyset: a cursor names the last row served,
// so a row written while a client pages is seen once or not at all, never twice.
// Responses carry `Cache-Control: public, max-age=300` and a weak `ETag` of the
// body, answer a matching `If-None-Match` with 304, and are gzip-encoded when
// the client accepts it and the body is over 256 KB.
//
// RATE LIMIT. One shared sliding window per client ip, per process (see
// rate-limit.ts): 100 requests a minute across all four routes, then 429 with
// `Retry-After`.
import {
  PUBLIC_ANALYTICS_CACHE_CONTROL,
  PUBLIC_ANALYTICS_DEFAULT_LIMIT,
  PUBLIC_ANALYTICS_GZIP_MIN_BYTES,
  PUBLIC_ANALYTICS_MAX_LIMIT,
  PUBLIC_ANALYTICS_SCHEMA_VERSION,
  ROUTES,
} from "@robotmoney/contract";
import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { INDICATORS } from "../../analytics/analyze/indicators.ts";
import { SOURCE_TOLERANCES } from "../../analytics/source-tolerance.ts";
import { createRateLimiter } from "../rate-limit.ts";

const ROUTE = "src/api/routes/public-analytics";

export const PUBLIC_ANALYTICS_RATE_MAX = 100;
export const PUBLIC_ANALYTICS_RATE_WINDOW_MS = 60_000;
// overwrite-events rows carry whole previous/replacement rows, and a
// regime_snapshots row is ~0.5 MB. A page stops adding rows once this many
// bytes are in it (it always holds at least one), and says so with a cursor.
const OVERWRITE_PAGE_BYTE_BUDGET = 8 * 1024 * 1024;

const limiter = createRateLimiter({ max: PUBLIC_ANALYTICS_RATE_MAX, windowMs: PUBLIC_ANALYTICS_RATE_WINDOW_MS });
/** Forget every client's window. For tests. */
export function _resetPublicAnalyticsRateLimitForTests(): void {
  limiter.reset();
}

// ── What is withheld (D58) ──────────────────────────────────────────────────

/** raw_indicator_history ids whose registry source is Yahoo. */
export function yahooIndicatorIds(): string[] {
  return INDICATORS.filter((i) => i.source === "yahoo").map((i) => i.id);
}

/** Every ledger source_key backed by Yahoo: the registry's, plus the research and backtest overlays D56 tolerances name. */
export function yahooSourceKeys(): string[] {
  const keys = new Set(yahooIndicatorIds().map((id) => `raw_indicator_history:${id}`));
  for (const [key, tolerance] of Object.entries(SOURCE_TOLERANCES)) {
    if (tolerance.basis.startsWith("yahoo")) keys.add(key);
  }
  return [...keys].sort();
}

const EXCLUDED_PROVIDERS = ["yahoo"];

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
  purpose: "Page raw_indicator_history by (date, indicator) for GET /api/public/analytics/raw-history, withholding Yahoo-sourced indicators.",
  callers: [ROUTE],
  probe: {
    statement: `SELECT date::text AS date, indicator, value, source FROM raw_indicator_history
      WHERE (date, indicator) > ($1::date, $2::text)
        AND date >= $3::date AND date <= $4::date
        AND ($5::text IS NULL OR indicator = $6::text)
        AND indicator <> ALL($7::text[])
      ORDER BY raw_indicator_history.date, raw_indicator_history.indicator
      LIMIT $8`,
    params: ["0001-01-01", "", "0001-01-01", "9999-12-31", null, null, "{}", 2],
  },
});

const readAssetPrices = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listAssetPrices",
  purpose: "Page asset_prices by (price_date, symbol, time_basis) for GET /api/public/analytics/asset-prices, withholding Yahoo-sourced rows.",
  callers: [ROUTE],
  probe: {
    statement: `SELECT price_date::text AS price_date, symbol, time_basis, price_usd::float8 AS price_usd, currency, source,
        pool_key, token_address, observed_at, fetched_at, config_identity
      FROM asset_prices
      WHERE (price_date, symbol, time_basis) > ($1::date, $2::text, $3::text)
        AND price_date >= $4::date AND price_date <= $5::date
        AND ($6::text IS NULL OR symbol = $7::text)
        AND lower(source) NOT LIKE '%yahoo%'
      ORDER BY asset_prices.price_date, asset_prices.symbol, asset_prices.time_basis
      LIMIT $8`,
    params: ["0001-01-01", "", "", "0001-01-01", "9999-12-31", null, null, 2],
  },
});

const vintageProbe = {
  statement: `SELECT v.id::text AS id, r.run_key, r.asof::text AS asof, r.source_label, v.tool_id,
        v.knowledge_time_cutoff, v.market_time_cutoff::text AS market_time_cutoff, v.manifest_digest, v.member_count,
        v.build_identity, v.created_at, m.version_label, m.config_digest
      FROM analytics_data_vintages v
      JOIN analytics_ledger_runs r ON r.id = v.run_id
      JOIN analytics_ledger_methodology_versions m ON m.id = v.methodology_version_id
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

const readVintageMembers = registerQuery({
  role: "rm_app",
  object: "analytics_vintage_members",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listVintageMembers",
  purpose: "Page one vintage's members, each id range expanded to one row per source_value_versions id, withholding Yahoo-backed source keys.",
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
        AND m.source_key <> ALL($4::text[])
      ORDER BY m.source_value_version_id, g.id
      LIMIT $5`,
    params: [0, 0, 0, "{}", 2],
  },
});

const readOverwriteEvents = registerQuery({
  role: "rm_app",
  object: "analytics_overwrite_events",
  privileges: ["SELECT"],
  site: "src/api/routes/public-analytics:listOverwriteEvents",
  purpose: "Page recorded revisions by id for GET /api/public/analytics/overwrite-events, withholding Yahoo-sourced raw_indicator_history rows.",
  callers: [ROUTE],
  probe: {
    statement: `SELECT id::text AS id, table_name, operation, natural_key, previous_row, replacement_row, recorded_at
      FROM analytics_overwrite_events
      WHERE id > $1::bigint
        AND ($2::text IS NULL OR table_name = $3::text)
        AND NOT (table_name = 'raw_indicator_history' AND natural_key->>'indicator' = ANY($4::text[]))
      ORDER BY analytics_overwrite_events.id
      LIMIT $5`,
    params: [0, null, null, "{}", 2],
  },
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

async function rawHistory(url: URL) {
  const limit = limitParam(url);
  const indicator = textParam(url, "indicator");
  const from = dateParam(url, "from") ?? MIN_DATE;
  const to = dateParam(url, "to") ?? MAX_DATE;
  const cursor = decodeCursor(url, ["date", "text"]) ?? [MIN_DATE, ""];
  const rows = await on(sql, readRawHistory)<{ date: string; indicator: string; value: number; source: string }>`
    SELECT date::text AS date, indicator, value, source FROM raw_indicator_history
      WHERE (date, indicator) > (${cursor[0]}::date, ${cursor[1]}::text)
        AND date >= ${from}::date AND date <= ${to}::date
        AND (${indicator}::text IS NULL OR indicator = ${indicator}::text)
        AND indicator <> ALL(${yahooIndicatorIds()}::text[])
      ORDER BY raw_indicator_history.date, raw_indicator_history.indicator
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    excludedProviders: EXCLUDED_PROVIDERS,
    rows: page.map((r) => ({ date: r.date, indicator: r.indicator, value: Number(r.value), source: r.source })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.date, last.indicator]) : null,
  };
}

async function assetPrices(url: URL) {
  const limit = limitParam(url);
  const symbol = textParam(url, "symbol");
  const from = dateParam(url, "from") ?? MIN_DATE;
  const to = dateParam(url, "to") ?? MAX_DATE;
  const cursor = decodeCursor(url, ["date", "text", "text"]) ?? [MIN_DATE, "", ""];
  const rows = await on(sql, readAssetPrices)<{
    price_date: string; symbol: string; time_basis: string; price_usd: number; currency: string; source: string;
    pool_key: string | null; token_address: string | null; observed_at: Date; fetched_at: Date; config_identity: string;
  }>`
    SELECT price_date::text AS price_date, symbol, time_basis, price_usd::float8 AS price_usd, currency, source,
        pool_key, token_address, observed_at, fetched_at, config_identity
      FROM asset_prices
      WHERE (price_date, symbol, time_basis) > (${cursor[0]}::date, ${cursor[1]}::text, ${cursor[2]}::text)
        AND price_date >= ${from}::date AND price_date <= ${to}::date
        AND (${symbol}::text IS NULL OR symbol = ${symbol}::text)
        AND lower(source) NOT LIKE '%yahoo%'
      ORDER BY asset_prices.price_date, asset_prices.symbol, asset_prices.time_basis
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    excludedProviders: EXCLUDED_PROVIDERS,
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
}

async function vintages(url: URL) {
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
  const rows = await on(sql, readVintages, readVintageRuns, readVintageMethodology)<VintageRow>`
    SELECT v.id::text AS id, r.run_key, r.asof::text AS asof, r.source_label, v.tool_id,
        v.knowledge_time_cutoff, v.market_time_cutoff::text AS market_time_cutoff, v.manifest_digest, v.member_count,
        v.build_identity, v.created_at, m.version_label, m.config_digest
      FROM analytics_data_vintages v
      JOIN analytics_ledger_runs r ON r.id = v.run_id
      JOIN analytics_ledger_methodology_versions m ON m.id = v.methodology_version_id
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
      ...(withMembers ? { members: await vintageMembers(url, v.id, limit) } : {}),
    });
  }
  return {
    schemaVersion: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    limit,
    excludedProviders: EXCLUDED_PROVIDERS,
    vintages: out,
    nextCursor: !withMembers && rows.length > limit && last ? encodeCursor([last.id]) : null,
  };
}

async function vintageMembers(url: URL, vintageId: string, limit: number) {
  const after = decodeCursor(url, ["id"])?.[0] ?? "0";
  const rows = await on(sql, readVintageMembers)<{ source_key: string; source_value_version_id: string }>`
    SELECT m.source_key, g.id::text AS source_value_version_id
      FROM analytics_vintage_members m
      CROSS JOIN LATERAL generate_series(
        GREATEST(m.source_value_version_id, ${after}::bigint + 1),
        COALESCE(m.last_source_value_version_id, m.source_value_version_id)
      ) AS g(id)
      WHERE m.vintage_id = ${vintageId}::bigint
        AND COALESCE(m.last_source_value_version_id, m.source_value_version_id) > ${after}::bigint
        AND m.source_key <> ALL(${yahooSourceKeys()}::text[])
      ORDER BY m.source_value_version_id, g.id
      LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({ source_key: r.source_key, source_value_version_id: Number(r.source_value_version_id) })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.source_value_version_id]) : null,
  };
}

const OVERWRITE_TABLES = ["raw_indicator_history", "regime_snapshots", "research_signals"];

async function overwriteEvents(url: URL) {
  const limit = limitParam(url);
  const tableName = textParam(url, "table_name");
  if (tableName !== null && !OVERWRITE_TABLES.includes(tableName)) {
    throw new BadRequest(`table_name must be one of ${OVERWRITE_TABLES.join(", ")}`);
  }
  const cursor = decodeCursor(url, ["id"]);
  const rows = await on(sql, readOverwriteEvents)<{
    id: string; table_name: string; operation: string; natural_key: unknown; previous_row: unknown;
    replacement_row: unknown; recorded_at: Date;
  }>`
    SELECT id::text AS id, table_name, operation, natural_key, previous_row, replacement_row, recorded_at
      FROM analytics_overwrite_events
      WHERE id > ${cursor?.[0] ?? "0"}::bigint
        AND (${tableName}::text IS NULL OR table_name = ${tableName}::text)
        AND NOT (table_name = 'raw_indicator_history' AND natural_key->>'indicator' = ANY(${yahooIndicatorIds()}::text[]))
      ORDER BY analytics_overwrite_events.id
      LIMIT ${limit + 1}`;
  const events: Record<string, unknown>[] = [];
  let bytes = 0;
  let more = rows.length > limit;
  let lastId = "";
  for (const r of rows.slice(0, limit)) {
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
    excludedProviders: EXCLUDED_PROVIDERS,
    events,
    nextCursor: more && lastId ? encodeCursor([lastId]) : null,
  };
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

function ok(req: Request, body: unknown): Response {
  const identity = new TextEncoder().encode(JSON.stringify(body));
  const etag = etagOf(identity);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": PUBLIC_ANALYTICS_CACHE_CONTROL,
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (matchesEtag(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  if (identity.length > PUBLIC_ANALYTICS_GZIP_MIN_BYTES && acceptsGzip(req.headers.get("accept-encoding"))) {
    headers["Content-Encoding"] = "gzip";
    return new Response(Bun.gzipSync(identity), { status: 200, headers });
  }
  return new Response(identity, { status: 200, headers });
}

const R = ROUTES.publicAnalytics;
const HANDLERS: Record<string, (url: URL) => Promise<unknown>> = {
  [R.rawHistory]: rawHistory,
  [R.assetPrices]: assetPrices,
  [R.vintages]: vintages,
  [R.overwriteEvents]: overwriteEvents,
};

/**
 * Answer one request under /api/public/analytics/. Always returns a Response:
 * 429 over the shared limit, 405 for any method but GET, 404 for a path that is
 * not one of the four routes, 400 for a bad parameter or cursor, else the page.
 */
export async function handlePublicAnalytics(req: Request, url: URL, clientIp: string): Promise<Response> {
  const verdict = limiter.check(clientIp);
  if (verdict.limited) {
    return problem(429, "rate limit exceeded", { "Retry-After": String(verdict.retryAfterSeconds) });
  }
  if (req.method !== "GET") return problem(405, "method not allowed", { Allow: "GET" });
  const handler = HANDLERS[url.pathname];
  if (!handler) return problem(404, "not found");
  try {
    return ok(req, await handler(url));
  } catch (err) {
    if (err instanceof BadRequest) return problem(400, err.message);
    // A value that passed the checks above but Postgres still refuses is the
    // caller's input, not a server fault: SQLSTATE class 22 is "data exception".
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("22")) return problem(400, "a parameter is out of range");
    throw err;
  }
}

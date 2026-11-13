// The route and header contract of website-server (issue 1624,
// docs/technical/web-serving-architecture.md §3.3 and §5.2 item 4). Every
// visitor-visible answer the server owes is one row here. The table is data
// about HTTP answers only, never about the server that gives them: it passes
// against today's nginx image and must pass unchanged against its successor.
//
// A row is checked through one origin (website-routes-runner.ts, which reads
// ROUTES_TARGET_URL). Proxy and identity rows expect the stand-in api to echo
// the request it received as JSON ({ path, headers }), so they grade what the
// server forwarded, not what an api answered. Rows tagged `api-down` run after
// the api is stopped.
//
// The fixture site is part of the contract: the rows name its files.
// static-asset-cache.md C1 and C7 set the Cache-Control values.

export type Duty =
  | "static"
  | "fallback"
  | "missing-asset"
  | "cache-headers"
  | "security-headers"
  | "api-proxy"
  | "client-identity"
  | "maintenance"
  | "compression"
  | "health";

export const DUTIES: readonly Duty[] = [
  "static",
  "fallback",
  "missing-asset",
  "cache-headers",
  "security-headers",
  "api-proxy",
  "client-identity",
  "maintenance",
  "compression",
  "health",
];

export type Phase = "api-up" | "api-down";

/** Replaced by the target origin's host (with its port) before a comparison. */
export const ORIGIN_HOST = "{origin.host}";

export type Row = {
  id: string;
  duty: Duty;
  phase: Phase;
  path: string;
  requestHeaders?: Record<string, string>;
  status: number;
  /** Exact header values. `null` means the header must be absent. */
  headers?: Record<string, string | null>;
  bodyIncludes?: string;
  bodyExcludes?: string;
  /** Every listed field equals the JSON answer's field. */
  json?: Record<string, unknown>;
  /** Every listed header equals the one the stand-in api received. */
  echoHeaders?: Record<string, string>;
};

export const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://script.google.com https://script.googleusercontent.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

const HTML_CACHE = "no-cache";
const ASSET_CACHE = "public, max-age=300";

/**
 * The fixture site's identity. A real bundle identity (a hex commit), so the
 * same site packs into a signed bundle for the immutable image (issue 1627).
 */
export const SITE_VERSION = { version: "0.0.0-routes", commit: "0123abc" } as const;

export const SITE_FILES: Record<string, string> = {
  "index.html": "<!doctype html><title>routes-home</title>",
  "regime/index.html": "<!doctype html><title>routes-prerendered-regime</title>",
  "_shell.html": "<!doctype html><title>routes-shell</title>",
  "assets/js/app/main.js": "export const routesTable = 1;\n",
  "assets/css/views.css": "body { color: black; }\n",
  "version.json": JSON.stringify(SITE_VERSION),
  "sitemap.xml": '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>/regime</loc></url></urlset>',
};

/** Written beside the served site, where the maintenance answer reads it (scripts/lib/maintenance-file.ts). */
export const MAINTENANCE_STATUS = {
  state: "active" as const,
  startsAt: "2030-01-01T10:00:00.000Z",
  expectedEnd: "2030-01-01T11:00:00.000Z",
  message: "routes-table maintenance",
};

const TRUSTED_CLIENT = "203.0.113.9";

export const TABLE: readonly Row[] = [
  // Static files.
  { id: "static-root", duty: "static", phase: "api-up", path: "/", status: 200, bodyIncludes: "<title>routes-home</title>" },
  { id: "static-prerendered", duty: "static", phase: "api-up", path: "/regime", status: 200, bodyIncludes: "<title>routes-prerendered-regime</title>" },
  { id: "static-version-json", duty: "static", phase: "api-up", path: "/version.json", status: 200, json: { version: "0.0.0-routes", commit: "0123abc" } },
  { id: "static-sitemap", duty: "static", phase: "api-up", path: "/sitemap.xml", status: 200, bodyIncludes: "<loc>/regime</loc>" },
  { id: "static-asset", duty: "static", phase: "api-up", path: "/assets/js/app/main.js?v=abcd1234", status: 200, bodyIncludes: "routesTable" },

  // Fallback: a path with no extension falls back to its index.html, then the shell.
  { id: "fallback-client-route", duty: "fallback", phase: "api-up", path: "/swarm/members/42", status: 200, bodyIncludes: "<title>routes-shell</title>" },
  { id: "fallback-prerendered-first", duty: "fallback", phase: "api-up", path: "/regime", status: 200, bodyExcludes: "routes-shell" },

  // Missing asset: an extension and no file is a 404, never the shell.
  { id: "missing-asset-js", duty: "missing-asset", phase: "api-up", path: "/assets/js/app/missing.js", status: 404, bodyExcludes: "routes-shell" },
  { id: "missing-asset-png", duty: "missing-asset", phase: "api-up", path: "/og-missing.png", status: 404, bodyExcludes: "routes-shell" },

  // Cache headers (static-asset-cache.md C1, C7).
  { id: "cache-html-root", duty: "cache-headers", phase: "api-up", path: "/", status: 200, headers: { "cache-control": HTML_CACHE } },
  { id: "cache-html-client-route", duty: "cache-headers", phase: "api-up", path: "/swarm/members/42", status: 200, headers: { "cache-control": HTML_CACHE } },
  { id: "cache-asset-js", duty: "cache-headers", phase: "api-up", path: "/assets/js/app/main.js?v=abcd1234", status: 200, headers: { "cache-control": ASSET_CACHE } },
  { id: "cache-asset-css", duty: "cache-headers", phase: "api-up", path: "/assets/css/views.css", status: 200, headers: { "cache-control": ASSET_CACHE } },
  { id: "cache-version-json", duty: "cache-headers", phase: "api-up", path: "/version.json", status: 200, headers: { "cache-control": ASSET_CACHE } },
  { id: "cache-sitemap", duty: "cache-headers", phase: "api-up", path: "/sitemap.xml", status: 200, headers: { "cache-control": ASSET_CACHE } },

  // Security headers on every page answer.
  { id: "security-root", duty: "security-headers", phase: "api-up", path: "/", status: 200, headers: SECURITY_HEADERS },
  { id: "security-prerendered", duty: "security-headers", phase: "api-up", path: "/regime", status: 200, headers: SECURITY_HEADERS },
  { id: "security-client-route", duty: "security-headers", phase: "api-up", path: "/swarm/members/42", status: 200, headers: SECURITY_HEADERS },

  // API proxy, with the original Host header and its port (WebAuthn's origin).
  { id: "proxy-api", duty: "api-proxy", phase: "api-up", path: "/api/routes-echo", status: 200, json: { path: "/api/routes-echo" }, echoHeaders: { host: ORIGIN_HOST } },
  { id: "proxy-health", duty: "api-proxy", phase: "api-up", path: "/health", status: 200, json: { path: "/health" }, echoHeaders: { host: ORIGIN_HOST } },
  { id: "proxy-version", duty: "api-proxy", phase: "api-up", path: "/version", status: 200, json: { path: "/version" }, echoHeaders: { host: ORIGIN_HOST } },
  { id: "proxy-maintenance-route", duty: "api-proxy", phase: "api-up", path: "/api/status/maintenance", status: 200, json: { path: "/api/status/maintenance" }, echoHeaders: { host: ORIGIN_HOST } },

  // Client identity from a trusted peer: Cloudflare's CF-Connecting-IP becomes
  // X-Client-IP, and a caller-sent X-Client-IP is replaced. The untrusted-peer
  // case needs a peer address the runner cannot choose, so
  // website-server-routes.test.ts grades it from a container.
  {
    id: "identity-trusted-cf-passes",
    duty: "client-identity",
    phase: "api-up",
    path: "/api/routes-echo",
    requestHeaders: { "CF-Connecting-IP": TRUSTED_CLIENT, "X-Client-IP": "6.6.6.6" },
    status: 200,
    echoHeaders: { "x-client-ip": TRUSTED_CLIENT, "cf-connecting-ip": TRUSTED_CLIENT },
  },
  {
    id: "identity-health-cf-passes",
    duty: "client-identity",
    phase: "api-up",
    path: "/health",
    requestHeaders: { "CF-Connecting-IP": TRUSTED_CLIENT, "X-Client-IP": "6.6.6.6" },
    status: 200,
    echoHeaders: { "x-client-ip": TRUSTED_CLIENT, "cf-connecting-ip": TRUSTED_CLIENT },
  },

  // Compression belongs to the Cloudflare edge: the origin never encodes.
  { id: "compression-asset", duty: "compression", phase: "api-up", path: "/assets/js/app/main.js", requestHeaders: { "Accept-Encoding": "gzip, deflate, br" }, status: 200, headers: { "content-encoding": null } },
  { id: "compression-html", duty: "compression", phase: "api-up", path: "/", requestHeaders: { "Accept-Encoding": "gzip, deflate, br" }, status: 200, headers: { "content-encoding": null } },

  // Health: the container health check reads / on port 8080.
  { id: "health-root", duty: "health", phase: "api-up", path: "/", status: 200 },

  // Maintenance, with the api stopped.
  { id: "maintenance-status-file", duty: "maintenance", phase: "api-down", path: "/api/status/maintenance", status: 200, json: MAINTENANCE_STATUS },
  {
    id: "maintenance-other-api",
    duty: "maintenance",
    phase: "api-down",
    path: "/api/swarm/anything",
    status: 503,
    headers: { "retry-after": "60" },
    json: { error: "maintenance" },
  },
  { id: "maintenance-site-still-served", duty: "maintenance", phase: "api-down", path: "/", status: 200, bodyIncludes: "<title>routes-home</title>", headers: SECURITY_HEADERS },
];

/** Every way `res` differs from `row`, checked through `origin`. Empty means the row passes. */
export async function checkRow(origin: string, row: Row): Promise<string[]> {
  const host = new URL(origin).host;
  const fill = (v: string) => v.replaceAll(ORIGIN_HOST, host);
  // decompress: false so a Content-Encoding the server sent is seen, not undone.
  const res = await fetch(new URL(row.path, origin), { headers: row.requestHeaders, redirect: "manual", decompress: false } as RequestInit);
  const body = await res.text();
  const out: string[] = [];
  if (res.status !== row.status) out.push(`status ${res.status}, want ${row.status}`);
  for (const [name, want] of Object.entries(row.headers ?? {})) {
    const got = res.headers.get(name);
    if (got !== want) out.push(`header ${name} ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  if (row.bodyIncludes !== undefined && !body.includes(row.bodyIncludes)) out.push(`body lacks ${JSON.stringify(row.bodyIncludes)}`);
  if (row.bodyExcludes !== undefined && body.includes(row.bodyExcludes)) out.push(`body has ${JSON.stringify(row.bodyExcludes)}`);
  if (row.json || row.echoHeaders) {
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) out.push(`content-type ${res.headers.get("content-type")}, want JSON`);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      out.push(`body is not JSON: ${body.slice(0, 120)}`);
    }
    for (const [k, want] of Object.entries(row.json ?? {})) {
      if (JSON.stringify(parsed[k]) !== JSON.stringify(want)) out.push(`json ${k} ${JSON.stringify(parsed[k])}, want ${JSON.stringify(want)}`);
    }
    const echoed = (parsed.headers ?? {}) as Record<string, string>;
    for (const [name, want] of Object.entries(row.echoHeaders ?? {})) {
      if (echoed[name] !== fill(want)) out.push(`api received ${name} ${JSON.stringify(echoed[name])}, want ${JSON.stringify(fill(want))}`);
    }
  }
  return out;
}

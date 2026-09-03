// CORS support for a split-repo frontend calling this API cross-origin
// (issue #871), layered with a SEPARATE always-on public-read fallback
// (issue #867): every /api/dashboards, /api/projects and public /api/swarm
// GET is already anonymous public data, answers curl, and is what this
// site's own pages fetch — the only thing missing was an answer for a
// browser on ANOTHER origin. Two independent policies on one seam:
//   1. allowedOrigin(): the split-deploy allowlist, credentialed, specific
//      origin, config.corsAllowedOrigins-gated (issue #871, D43). Empty by
//      default, so this half is a no-op for today's single-box deployment.
//   2. isPublicRead(): keyed on the ABSENCE of a credential rather than a
//      path allowlist, so a route added later that reads a new credential
//      header is excluded automatically as long as it's added to
//      CREDENTIAL_HEADERS below — the request that would exercise it
//      carries the header this refuses. ALWAYS ON, independent of
//      corsAllowedOrigins: an allow-listed origin is checked FIRST and wins
//      (credentialed, specific origin); a public read is the fallback for
//      everyone else.
import { config } from "../config.ts";

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
// Every custom header a route reads off the request (auth.ts, projects.ts
// admin gate): Authorization, X-Admin-Token, X-Automation-Token.
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Admin-Token, X-Automation-Token";

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin || !config.corsAllowedOrigins.includes(origin)) return null;
  return origin;
}

// Every header that authenticates ANY request on this API (backend/src/api/
// auth.ts): member/analytics-provider bearer tokens and the automation role
// both ride on Authorization, host/admin rides on X-Admin-Token, automation
// also accepts X-Automation-Token directly. No cookies exist anywhere in
// backend/src (verified: WebAuthn's "session" is X-Admin-Token, not a
// cookie) — kept in the list anyway as a forward guard, since a browser
// attaches cookies to a same-origin-looking request without JS ever reading
// this list.
const CREDENTIAL_HEADERS = ["authorization", "x-admin-token", "x-automation-token", "cookie"];
// Every route prefix that is credential-gated even without necessarily
// requiring the header on THIS request (e.g. an admin GET probed
// anonymously still must not become cross-origin readable).
const CREDENTIALED_PREFIXES = ["/api/admin/", "/api/swarm/admin/", "/api/analytics/"];

// A request this API will answer identically for every caller, so opening it
// to a cross-origin browser reveals nothing an anonymous curl couldn't
// already get. Exported for tests.
export function isPublicRead(req: Request, pathname: string): boolean {
  // A preflight carries the real method in Access-Control-Request-Method,
  // not req.method (every preflight is itself an OPTIONS).
  const method = req.method === "OPTIONS" ? (req.headers.get("access-control-request-method") ?? "") : req.method;
  if (method !== "GET" && method !== "HEAD") return false;
  if (CREDENTIALED_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  if (CREDENTIAL_HEADERS.some((h) => req.headers.has(h))) return false;
  // A preflight that intends to send a credential is refused before it is
  // told the request would be allowed — encouraging it would be worse than
  // silence, since the browser would then actually send the credential
  // cross-origin on the real request.
  const asked = req.headers.get("access-control-request-headers") ?? "";
  if (asked && asked.split(",").some((h) => CREDENTIAL_HEADERS.includes(h.trim().toLowerCase()))) return false;
  return true;
}

// Vary: Origin is set on every response once CORS is actually turned on
// (corsAllowedOrigins non-empty) — allowed or not. A shared cache
// (Cloudflare, D13) that stored a disallowed-Origin response without it would
// later serve that ACAO-less copy to an allowed cross-origin caller, breaking
// assets and requests intermittently. There is no confidentiality risk in
// getting this wrong (an allow-listed response's bytes are the same for
// every caller), only a correctness one. Skipped entirely while
// corsAllowedOrigins is empty (today's single-box deployment), preserving the
// literal no-op this module promises for that case.
function addVaryOrigin(headers: Headers): void {
  if (config.corsAllowedOrigins.length === 0) return;
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", "Origin");
  } else if (!existing.split(",").map((v) => v.trim().toLowerCase()).includes("origin")) {
    headers.set("Vary", `${existing}, Origin`);
  }
}

// `Access-Control-Allow-Credentials` is deliberately never sent on the
// public-read branch. With `*` and no credentials flag a browser will not
// attach cookies (there are none anyway) or forward `Authorization`, so no
// ambient-authority request can be laundered through the wildcard origin.
// `Authorization`/`X-Admin-Token`/`X-Automation-Token` are deliberately
// absent from the public-read Allow-Headers for the same reason: a preflight
// that wants one of them fails isPublicRead() and gets refused above.
const PUBLIC_READ_METHODS = "GET, HEAD, OPTIONS";
const PUBLIC_READ_HEADERS = "Content-Type, Accept";

export function corsPreflightResponse(req: Request, pathname: string): Response {
  const origin = allowedOrigin(req);
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", "600");
    addVaryOrigin(headers);
  } else if (isPublicRead(req, pathname)) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", PUBLIC_READ_METHODS);
    headers.set("Access-Control-Allow-Headers", PUBLIC_READ_HEADERS);
    headers.set("Access-Control-Max-Age", "86400");
    // No Vary needed: a `*` response doesn't depend on Origin.
  } else {
    addVaryOrigin(headers);
  }
  return new Response(null, { status: 204, headers });
}

// Wraps every non-preflight response. Three outcomes, checked in order:
// allow-listed origin (credentialed, specific origin) wins; else a public
// read gets `*` (no credentials, no Vary — the bytes are identical for every
// caller); else a genuine no-op UNLESS the credentialed allowlist is
// configured at all, in which case Vary: Origin still protects that cache
// path (see addVaryOrigin) even on a request neither branch matched.
export function withCors(res: Response, req: Request, pathname: string): Response {
  const origin = allowedOrigin(req);
  const publicRead = !origin && isPublicRead(req, pathname);
  if (!origin && !publicRead && config.corsAllowedOrigins.length === 0) return res;
  const headers = new Headers(res.headers);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    addVaryOrigin(headers);
  } else if (publicRead) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Date, Cache-Control");
  } else {
    addVaryOrigin(headers);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

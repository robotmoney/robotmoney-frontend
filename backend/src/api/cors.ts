// Cross-origin reads for the public API.
//
// Every /api/dashboards, /api/projects and public /api/swarm GET is already
// anonymous data: it answers curl, it is listed in frontend/public/openapi.json,
// and it is what robotmoney.network's own pages fetch. What it does NOT do today
// is answer a browser on another origin. With no Access-Control-Allow-Origin
// header the browser fetches the bytes and then refuses to hand them to the
// page, so an agent that runs in a browser (a Claude artifact, an extension, a
// dashboard someone builds on this data) sees an opaque network error while the
// identical curl succeeds. That asymmetry is invisible from the server side and
// is the single reason this file exists.
//
// THE SAFETY RULE, and why it is shaped as a header check rather than a path
// allowlist: a permissive header is attached only to a request that carries NO
// credential. An allowlist of public prefixes has to be kept in sync with the
// route table by hand, and the failure mode of forgetting an entry is that a
// credentialed response becomes cross-origin readable. Keying on the absence of
// a credential inverts that: a route added tomorrow that reads an Authorization
// or X-Admin-Token header is excluded automatically, because the request that
// would exercise it carries the header this check refuses.
//
// Access-Control-Allow-Credentials is deliberately never sent. With `*` and no
// credentials flag a browser will not attach cookies, so no ambient-authority
// request can be laundered through this. Authorization is not offered in
// Allow-Headers for the same reason: a cross-origin caller has no business
// preflighting a credentialed request against this surface.

/** Headers a cross-origin caller must not be able to send under the * origin. */
const CREDENTIAL_HEADERS = ["authorization", "x-admin-token", "cookie"];

/** Namespaces that are credentialed by construction, belt to the braces above. */
const CREDENTIALED_PREFIXES = ["/api/admin/", "/api/swarm/admin/", "/api/analytics/"];

export function isPublicRead(req: Request, pathname: string): boolean {
  const method = req.method === "OPTIONS" ? (req.headers.get("access-control-request-method") ?? "") : req.method;
  if (method !== "GET" && method !== "HEAD") return false;
  if (CREDENTIALED_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  if (CREDENTIAL_HEADERS.some((h) => req.headers.has(h))) return false;
  // A preflight that intends to send a credential is refused before it is told
  // the request would be allowed.
  const asked = req.headers.get("access-control-request-headers") ?? "";
  if (asked && asked.split(",").some((h) => CREDENTIAL_HEADERS.includes(h.trim().toLowerCase()))) return false;
  return true;
}

/**
 * Attach the permissive headers to an already-built response. Returns the same
 * response object when the request does not qualify, so callers can apply this
 * unconditionally on the way out.
 */
export function withPublicReadCors(req: Request, pathname: string, res: Response): Response {
  if (!isPublicRead(req, pathname)) return res;
  res.headers.set("Access-Control-Allow-Origin", "*");
  // So a caller can read `asOf`/`stale` semantics off the response without a
  // second request, and can see how long a cached copy is good for.
  res.headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Date, Cache-Control");
  return res;
}

/** The 204 answer to a preflight for a public read. */
export function preflightResponse(req: Request, pathname: string): Response {
  const headers: Record<string, string> = {};
  if (isPublicRead(req, pathname)) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Accept";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return new Response(null, { status: 204, headers });
}

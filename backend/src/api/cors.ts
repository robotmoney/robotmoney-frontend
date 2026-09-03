// CORS support for a split-repo frontend calling this API cross-origin
// (issue #871). Disabled by default: config.corsAllowedOrigins is empty for
// the single-box same-origin deployment (D11/D13), so allowedOrigin() always
// returns null and every function here is a no-op — no header is added and
// no existing same-origin behavior changes.
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

export function corsPreflightResponse(req: Request): Response {
  const origin = allowedOrigin(req);
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", "600");
  }
  addVaryOrigin(headers);
  return new Response(null, { status: 204, headers });
}

// Wraps every non-preflight response so an allow-listed cross-origin caller's
// browser accepts it. Adds Vary: Origin once CORS is enabled at all, even for
// a disallowed origin (see addVaryOrigin); the ACAO/credentials headers
// themselves stay a no-op when the request's Origin isn't allow-listed,
// including same-origin requests (no Origin header at all on same-origin
// navigations/fetches in most browsers).
export function withCors(res: Response, req: Request): Response {
  if (config.corsAllowedOrigins.length === 0) return res;
  const origin = allowedOrigin(req);
  const headers = new Headers(res.headers);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  addVaryOrigin(headers);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

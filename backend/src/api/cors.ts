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

export function corsPreflightResponse(req: Request): Response {
  const origin = allowedOrigin(req);
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": ALLOWED_METHODS,
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

// Wraps every non-preflight response so an allow-listed cross-origin caller's
// browser accepts it. A no-op (returns res unchanged) when the request's
// Origin isn't allow-listed, including same-origin requests (no Origin header
// at all on same-origin navigations/fetches in most browsers).
export function withCors(res: Response, req: Request): Response {
  const origin = allowedOrigin(req);
  if (!origin) return res;
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

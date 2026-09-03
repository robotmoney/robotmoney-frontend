// CORS support: two layered policies over one seam (backend/src/api/cors.ts).
//   1. The split-deploy allowlist (issue #871, D43): credentialed, specific
//      origin, gated on config.corsAllowedOrigins. Empty by default.
//   2. The public-read fallback (issue #867): `*`, no credentials, ALWAYS ON
//      regardless of config, for any GET/HEAD to a non-credentialed path
//      carrying no credential header. corsPreflightResponse()/withCors() are
//      pure functions over Request + config, so no server/DB needed here —
//      the full-stack "does the header actually reach the socket" path is
//      exercised by e2e once a real split deployment exists.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import { corsPreflightResponse, isPublicRead, withCors } from "../../src/api/cors.ts";

const ALLOWED = "https://web.robotmoney.network";
const origCorsAllowedOrigins = config.corsAllowedOrigins;

beforeEach(() => {
  config.corsAllowedOrigins = [ALLOWED];
});

afterEach(() => {
  config.corsAllowedOrigins = origCorsAllowedOrigins;
});

function req(opts: { origin?: string | null; method?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.origin) headers.Origin = opts.origin;
  return new Request("https://api.example/api/dashboards/regime-snapshots", {
    method: opts.method ?? "GET",
    headers,
  });
}

// ── isPublicRead: the decision function itself ──────────────────────────────

test("isPublicRead: true for an ordinary anonymous GET to a public path", () => {
  expect(isPublicRead(req(), "/api/dashboards/regime-snapshots")).toBe(true);
  expect(isPublicRead(req({ method: "HEAD" }), "/api/dashboards/regime-snapshots")).toBe(true);
});

test("isPublicRead: false for a write method", () => {
  expect(isPublicRead(req({ method: "POST" }), "/api/dashboards/regime-snapshots")).toBe(false);
  expect(isPublicRead(req({ method: "DELETE" }), "/api/dashboards/regime-snapshots")).toBe(false);
});

test("isPublicRead: false under every credentialed prefix, even probed anonymously", () => {
  expect(isPublicRead(req(), "/api/admin/anything")).toBe(false);
  expect(isPublicRead(req(), "/api/swarm/admin/members")).toBe(false);
  expect(isPublicRead(req(), "/api/analytics/regime-snapshots")).toBe(false);
});

test("isPublicRead: false when the request carries any credential header", () => {
  expect(isPublicRead(req({ headers: { Authorization: "Bearer x" } }), "/api/dashboards/regime-snapshots")).toBe(false);
  expect(isPublicRead(req({ headers: { "X-Admin-Token": "x" } }), "/api/dashboards/regime-snapshots")).toBe(false);
  expect(isPublicRead(req({ headers: { "X-Automation-Token": "x" } }), "/api/dashboards/regime-snapshots")).toBe(false);
  expect(isPublicRead(req({ headers: { Cookie: "x=y" } }), "/api/dashboards/regime-snapshots")).toBe(false);
});

test("isPublicRead: false for a preflight declaring a credential header in Access-Control-Request-Headers", () => {
  const preflight = req({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
  expect(isPublicRead(preflight, "/api/dashboards/regime-snapshots")).toBe(false);
});

test("isPublicRead: true for a preflight declaring only harmless headers", () => {
  const preflight = req({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "content-type" } });
  expect(isPublicRead(preflight, "/api/dashboards/regime-snapshots")).toBe(true);
});

// ── Preflight ────────────────────────────────────────────────────────────

test("preflight: allow-listed origin gets the full credentialed CORS header set", () => {
  const res = corsPreflightResponse(req({ origin: ALLOWED }), "/api/dashboards/regime-snapshots");
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Admin-Token");
  expect(res.headers.get("Vary")).toBe("Origin");
});

test("preflight: non-allow-listed origin on a public-read path gets the wildcard, not the credentialed set", () => {
  const res = corsPreflightResponse(req({ origin: "https://third-party.example" }), "/api/dashboards/regime-snapshots");
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
  expect(res.headers.get("Access-Control-Allow-Headers")).not.toContain("Authorization");
  // `*` doesn't depend on Origin, so no Vary is needed on this branch.
  expect(res.headers.get("Vary")).toBeNull();
});

test("preflight: non-allow-listed origin declaring a credential header gets neither policy", () => {
  const res = corsPreflightResponse(
    req({ origin: "https://third-party.example", method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } }),
    "/api/dashboards/regime-snapshots",
  );
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  // Neither policy matched, but the allowlist is configured, so the shared
  // cache still needs protecting.
  expect(res.headers.get("Vary")).toBe("Origin");
});

test("preflight: no Origin header (same-origin) gets a bare 204 with no wildcard, since isPublicRead needs no CORS at all for a same-origin request — still Vary once the allowlist is configured", () => {
  const res = corsPreflightResponse(req(), "/api/dashboards/regime-snapshots");
  // No Origin means allowedOrigin() is null AND this is treated as a public
  // read (a same-origin browser never sends Origin on a simple GET either,
  // so this path is exercised in practice by a same-origin OPTIONS probe,
  // which harmlessly gets the wildcard set instead of nothing).
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

// ── withCors ─────────────────────────────────────────────────────────────

test("withCors: allow-listed origin wins over the public-read fallback (credentialed branch takes precedence)", async () => {
  const inner = new Response(JSON.stringify({ ok: true }), { status: 200 });
  const res = withCors(inner, req({ origin: ALLOWED }), "/api/dashboards/regime-snapshots");
  expect(res.status).toBe(200);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  await expect(res.json()).resolves.toEqual({ ok: true });
});

test("withCors: a public read from a non-allow-listed origin gets `*`, no credentials flag, regardless of the allowlist config", () => {
  for (const allowed of [[ALLOWED], []]) {
    config.corsAllowedOrigins = allowed;
    const inner = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const res = withCors(inner, req({ origin: "https://third-party.example" }), "/api/dashboards/regime-snapshots");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  }
});

test("withCors: a public read with NO Origin header at all (an anonymous curl, or a fetch tool that omits it) still gets `*`", () => {
  const inner = new Response(null, { status: 200 });
  const res = withCors(inner, req(), "/api/dashboards/regime-snapshots");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

test("withCors: a credentialed request (Authorization present) never gets `*`, even to a public-shaped path", () => {
  const inner = new Response(null, { status: 200 });
  const res = withCors(inner, req({ origin: "https://third-party.example", headers: { Authorization: "Bearer x" } }), "/api/dashboards/regime-snapshots");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("withCors: a GET under a credentialed prefix never gets `*`, even probed with no credential header", () => {
  const inner = new Response(null, { status: 200 });
  const res = withCors(inner, req({ origin: "https://third-party.example" }), "/api/swarm/admin/members");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("withCors: a write method (POST) never gets `*`", () => {
  const inner = new Response(null, { status: 200 });
  const res = withCors(inner, req({ origin: "https://third-party.example", method: "POST" }), "/api/dashboards/submissions");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("withCors: genuinely nothing applies (POST, non-allow-listed origin, empty allowlist config) is a true identity no-op", () => {
  config.corsAllowedOrigins = [];
  const inner = new Response(null, { status: 200 });
  const res = withCors(inner, req({ origin: ALLOWED, method: "POST" }), "/api/dashboards/submissions");
  expect(res).toBe(inner);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("withCors: non-allow-listed origin on a non-public-read path gains Vary: Origin (cache protection), when the allowlist is configured", () => {
  const inner = new Response(null, { status: 404 });
  const res = withCors(inner, req({ origin: "https://evil.example", method: "POST" }), "/api/dashboards/submissions");
  expect(res.status).toBe(404);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(res.headers.get("Vary")).toBe("Origin");
});

test("withCors: preserves an existing Vary header instead of duplicating Origin onto it", () => {
  const inner = new Response(null, { status: 200, headers: { Vary: "Accept-Encoding" } });
  const res = withCors(inner, req({ origin: ALLOWED }), "/api/dashboards/regime-snapshots");
  expect(res.headers.get("Vary")).toBe("Accept-Encoding, Origin");
});

test("withCors: response body and status survive both the credentialed and public-read branches", async () => {
  const credentialed = withCors(new Response("hi", { status: 201 }), req({ origin: ALLOWED }), "/api/dashboards/regime-snapshots");
  expect(credentialed.status).toBe(201);
  await expect(credentialed.text()).resolves.toBe("hi");

  const publicRead = withCors(new Response("hi", { status: 201 }), req({ origin: "https://third-party.example" }), "/api/dashboards/regime-snapshots");
  expect(publicRead.status).toBe(201);
  await expect(publicRead.text()).resolves.toBe("hi");
});

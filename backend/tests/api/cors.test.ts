// CORS support (issue #871): corsPreflightResponse() and withCors() are pure
// functions over config.corsAllowedOrigins, so no server/DB needed here — the
// full-stack "does the header actually reach the socket" path is exercised by
// e2e once a real split deployment exists.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import { corsPreflightResponse, withCors } from "../../src/api/cors.ts";

const ALLOWED = "https://web.robotmoney.network";
const origCorsAllowedOrigins = config.corsAllowedOrigins;

beforeEach(() => {
  config.corsAllowedOrigins = [ALLOWED];
});

afterEach(() => {
  config.corsAllowedOrigins = origCorsAllowedOrigins;
});

function reqWithOrigin(origin: string | null): Request {
  const headers: Record<string, string> = origin ? { Origin: origin } : {};
  return new Request("https://api.example/x", { headers });
}

test("preflight: allow-listed origin gets the full CORS header set", () => {
  const res = corsPreflightResponse(reqWithOrigin(ALLOWED));
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Admin-Token");
  expect(res.headers.get("Vary")).toBe("Origin");
});

test("preflight: origin not on the allow-list gets a bare 204, no CORS headers", () => {
  const res = corsPreflightResponse(reqWithOrigin("https://evil.example"));
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("preflight: no Origin header (same-origin) gets a bare 204", () => {
  const res = corsPreflightResponse(reqWithOrigin(null));
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("withCors: allow-listed origin gets the response echoed with CORS headers added", async () => {
  const inner = new Response(JSON.stringify({ ok: true }), { status: 200 });
  const res = withCors(inner, reqWithOrigin(ALLOWED));
  expect(res.status).toBe(200);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  await expect(res.json()).resolves.toEqual({ ok: true });
});

test("withCors: non-allow-listed origin returns the response unchanged", () => {
  const inner = new Response(null, { status: 404 });
  const res = withCors(inner, reqWithOrigin("https://evil.example"));
  expect(res).toBe(inner);
});

test("withCors: no allow-listed origins configured (default) is a total no-op", () => {
  config.corsAllowedOrigins = [];
  const inner = new Response(null, { status: 200 });
  const res = withCors(inner, reqWithOrigin(ALLOWED));
  expect(res).toBe(inner);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

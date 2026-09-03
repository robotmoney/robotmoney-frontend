// Cross-origin readability of the public API (backend/src/api/cors.ts).
//
// The property under test is a security property stated negatively: a
// credentialed response must never carry Access-Control-Allow-Origin: *. Both
// halves matter and only one of them is obvious, so both are asserted here. The
// permissive half is easy to eyeball in a browser; the refusal half is invisible
// until someone builds a page that exfiltrates an admin response, at which point
// the test that would have caught it does not exist.
//
// Pure over Request objects, no database and no server: the decision is made
// entirely from method, pathname and request headers, and testing it through a
// live stack would only add the ways a live stack can fail.
import { test, expect } from "bun:test";
import { isPublicRead, preflightResponse, withPublicReadCors } from "../../src/api/cors.ts";

const req = (path: string, init: RequestInit = {}) => new Request(`http://api.test${path}`, init);
const allow = (r: Response) => r.headers.get("Access-Control-Allow-Origin");

test("an anonymous GET to a public read is cross-origin readable", () => {
  for (const path of [
    "/health",
    "/api/dashboards/vault-economics",
    "/api/dashboards/regime-snapshots",
    "/api/swarm/members",
    "/api/swarm/sessions",
    "/api/projects",
    "/api/comments",
  ]) {
    expect(isPublicRead(req(path), path), path).toBe(true);
    expect(allow(withPublicReadCors(req(path), path, new Response("{}"))), path).toBe("*");
  }
});

test("a credentialed namespace is never cross-origin readable, even anonymously", () => {
  // Belt to the header check's braces: these prefixes are credentialed by
  // construction, so an unauthenticated probe of one gets no permissive header
  // either. Nothing about the response should hint at the surface's shape.
  for (const path of ["/api/admin/overview", "/api/swarm/admin/members", "/api/analytics/readiness"]) {
    expect(isPublicRead(req(path), path), path).toBe(false);
    expect(allow(withPublicReadCors(req(path), path, new Response("{}"))), path).toBeNull();
  }
});

test("a request carrying a credential is never cross-origin readable", () => {
  // The load-bearing rule. A route added tomorrow that reads one of these
  // headers is excluded automatically, because the request that exercises it
  // carries the header this refuses.
  const cases: [string, HeadersInit][] = [
    ["/api/swarm/members/x/takes", { authorization: "Bearer t" }],
    ["/api/swarm/sessions", { "x-admin-token": "t" }],
    ["/api/dashboards/allocation", { cookie: "session=t" }],
  ];
  for (const [path, headers] of cases) {
    expect(isPublicRead(req(path, { headers }), path), path).toBe(false);
    expect(allow(withPublicReadCors(req(path, { headers }), path, new Response("{}"))), path).toBeNull();
  }
});

test("writes are never cross-origin readable", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const path = "/api/swarm/submit";
    expect(isPublicRead(req(path, { method }), path), method).toBe(false);
  }
});

test("a preflight for a public read is allowed, and never advertises credential headers", () => {
  const path = "/api/dashboards/allocation";
  const res = preflightResponse(
    req(path, { method: "OPTIONS", headers: { "access-control-request-method": "GET" } }),
    path,
  );
  expect(res.status).toBe(204);
  expect(allow(res)).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
  expect(res.headers.get("Access-Control-Allow-Headers")!.toLowerCase()).not.toContain("authorization");
  // Credentials are never allowed, so a browser will not attach cookies and no
  // ambient-authority request can be laundered through the * origin.
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
});

test("a preflight that intends to send a credential is refused before it is encouraged", () => {
  const path = "/api/dashboards/allocation";
  const res = preflightResponse(
    req(path, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "GET", "access-control-request-headers": "content-type, authorization" },
    }),
    path,
  );
  expect(res.status).toBe(204);
  expect(allow(res)).toBeNull();
});

test("a preflight for a write is refused", () => {
  const path = "/api/swarm/submit";
  const res = preflightResponse(
    req(path, { method: "OPTIONS", headers: { "access-control-request-method": "POST" } }),
    path,
  );
  expect(allow(res)).toBeNull();
});

// What the SPA tells a reader when the backend is NOT the thing that answered
// its API call (issue #967).
//
// `frontend/public/assets/js/app/lib/api.js` is the single funnel every view's
// data load goes through, and ~30 views render `e.message` verbatim into their
// error banner. So whatever this module throws IS the user-visible copy for the
// whole site, and there was no test of it at all — which is how
//
//     Unexpected token '<', "<!doctype "... is not valid JSON
//
// became the entire error state of /regime on releases-0.5.x during manual
// testing. That string is `res.json()` parsing an HTML page: the call was
// answered with the SPA shell at HTTP 200, which is what happens when the api
// is not reachable and a proxy or static server answers in its place.
//
// The REAL module is imported and driven through a stubbed global fetch — no
// double, no re-implementation — so these assertions bind the shipped code
// path. Four answers, all of which mean "the backend is not serving this":
//
//   1. 200 text/html   — a static/proxy fallback answered instead of the api
//   2. 5xx text/html   — a reverse proxy in front of a dead api (nginx 502)
//   3. transport error — nothing is listening (api container down)
//   4. 5xx JSON        — the api is up and its database is not
//
// The invariant is the same for all four: the message a view will print must
// name the outage, and must never leak a JSON-parser message or raw markup.
// The assertions are on that invariant rather than on exact copy, so wording
// can be improved without editing this file.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// api.js reads the public API origin from window.RM_CONFIG at call time
// (frontend/public/config.js). "" is the deployed single-box value: same
// origin. Set before the import so module-load order can never matter.
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = { RM_CONFIG: { API_BASE_URL: "" } };

const { api, ApiError, ROUTES } = await import(
  "../../../frontend/public/assets/js/app/lib/api.js"
);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

// The prerendered shell the api serves for a client route, and the thing that
// answered the regime call in the reported incident. Only the opening bytes
// matter: JSON.parse gives up on the first '<'.
const SPA_SHELL = '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Robot Money</title>\n';
const NGINX_502 = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n";

// `as unknown as typeof fetch`: Bun's fetch type carries a `preconnect`
// property a bare function can't satisfy, and nothing under test touches it.
function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function answerWith(body: string, init: ResponseInit & { headers: Record<string, string> }) {
  stubFetch(async () => new Response(body, init));
}

async function errorFrom(call: () => Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await call();
  } catch (e) {
    return e as Error & { status?: number };
  }
  throw new Error("expected the call to throw, but it resolved");
}

// Every failure this funnel produces has to arrive as an ApiError carrying a
// status — never a raw SyntaxError from the parser or a raw TypeError from
// fetch. A view catching `e` can then branch on `e.status`, which is what the
// dossier/admin/apply views already do.
async function apiErrorFrom(call: () => Promise<unknown>): Promise<Error & { status: number }> {
  const e = await errorFrom(call);
  expect(e).toBeInstanceOf(ApiError);
  expectNoMachineNoise(e.message);
  return e as Error & { status: number };
}

const REGIME = () => api.get(ROUTES.dashboards.regimeSnapshots, { range: 4000, include: "backtest" });

// Applied to every failure mode: the shapes that must never reach a view's
// error banner, whatever the wording around them ends up being. The parser
// family is listed engine by engine on purpose: V8 says "Unexpected token
// '<', \"<!doctype \"... is not valid JSON" and JavaScriptCore says "JSON Parse
// error: Unexpected identifier", so a test that only knew one of them would
// pass under the other runtime. This rejects the whole family.
function expectNoMachineNoise(message: string) {
  expect(message).not.toMatch(/Unexpected token/i);
  expect(message).not.toMatch(/Unexpected identifier/i);
  expect(message).not.toMatch(/Unexpected end of/i);
  expect(message).not.toMatch(/is not valid JSON/i);
  expect(message).not.toMatch(/JSON Parse error/i);
  expect(message).not.toMatch(/SyntaxError/i);
  expect(message).not.toMatch(/Failed to fetch/i);
  expect(message).not.toMatch(/JSON\.parse/i);
  expect(message).not.toMatch(/<!doctype/i);
  expect(message).not.toMatch(/<html/i);
  expect(message).not.toMatch(/<\/?[a-z][^>]*>/i);
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

describe("api client: the backend is not what answered", () => {
  // THE REPORTED INCIDENT. A proxy or static server answered /api/... with the
  // SPA shell at 200, so `res.ok` was true and `res.json()` threw a parser
  // error that the page then printed as its only explanation.
  test("a 200 text/html answer is reported as an outage, not as a parse failure", async () => {
    answerWith(SPA_SHELL, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

    const { message } = await apiErrorFrom(REGIME);
    // It has to say WHAT is wrong: the API did not answer this request.
    expect(message).toMatch(/not (?:answer|serve)|didn't answer|static site|proxy|unreachable|can'?t reach|cannot reach/i);
  });

  test("a 200 answer that is labelled JSON but is not parseable is reported the same way", async () => {
    answerWith(SPA_SHELL, { status: 200, headers: { "Content-Type": "application/json" } });

    await apiErrorFrom(REGIME);
  });

  // A reverse proxy in front of a dead api (the website-server/nginx split, or
  // any edge). The body is an HTML error page; today it lands in the banner
  // verbatim, markup and all.
  test("a 502 HTML error page never puts markup in the message", async () => {
    answerWith(NGINX_502, { status: 502, headers: { "Content-Type": "text/html" } });

    const { message } = await apiErrorFrom(REGIME);
    expect(message).toMatch(/502/);
  });

  // Nothing listening at all — the api container is down, or the db it waits
  // on never came up, so compose never started it. fetch rejects; today the
  // banner reads "Failed to fetch".
  test("a transport failure is reported as an unreachable API, with status 0", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const err = await apiErrorFrom(REGIME);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/unreachable|can'?t reach|cannot reach|could not be reached|is down/i);
  });

  // The api is up and its database is not. The envelope is JSON, so the only
  // job here is to render it as prose rather than as a serialized object.
  test("a JSON error envelope is surfaced as prose, not as a serialized object", async () => {
    answerWith(JSON.stringify({ error: "database unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });

    const { message } = await apiErrorFrom(REGIME);
    expect(message).toMatch(/database unavailable/);
    expect(message).not.toMatch(/[{}"]/);
  });

  test("a 500 internal-error envelope still names the status and the reason", async () => {
    answerWith(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });

    const { message } = await apiErrorFrom(REGIME);
    expect(message).toMatch(/500/);
    expect(message).toMatch(/internal error/);
  });
});

describe("api client: behaviour the views already depend on", () => {
  // Regression fence around the error work: the branches in the dossier, admin
  // and apply views are `e.status === 404 / 403 / 409`, so the transport status
  // must keep coming through untouched.
  test("an HTTP status is preserved on the thrown error", async () => {
    for (const status of [403, 404, 409]) {
      answerWith(JSON.stringify({ error: "not found" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      const err = await apiErrorFrom(() => api.get(ROUTES.projects.list));
      expect(err.status).toBe(status);
    }
  });

  test("a healthy JSON answer is returned parsed", async () => {
    answerWith(JSON.stringify({ latest: { composite: 0.42 }, history: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const data = (await REGIME()) as { latest: { composite: number } };
    expect(data.latest.composite).toBe(0.42);
  });

  test("a 204 stays null rather than being parsed", async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    expect(await api.get(ROUTES.projects.list)).toBeNull();
  });
});

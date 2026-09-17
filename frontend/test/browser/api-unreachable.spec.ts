// What a READER sees on a dashboard page when the backend is not reachable
// (issue #967). The unit half of this guard drives lib/api.js directly
// (scripts/tests/unit/api-client-unreachable.test.ts); this half renders the
// real page and asserts on the pixels' worth of text the banner actually
// shows, because the two can diverge: a view is free to swallow, reformat, or
// leave `error` unrendered.
//
// The incident this comes from: manual testing of releases-0.5.x, where the
// whole error state of /regime was
//
//     Unexpected token '<', "<!doctype "... is not valid JSON
//
// because the regime call was answered with the SPA shell (HTTP 200,
// text/html) rather than by the api.
//
// NO LIVE BACKEND. Like preview-smoke.spec.ts, this spec spawns its own
// scripts/preview-server.ts (a static file server over the working tree) and
// serves the client route's document itself — which is exactly what the api's
// routeShell/nginx try_files does for a client route — so it runs in the
// `frontend` workflow on every frontend PR, not only in the ~40-minute e2e
// tier. The four backend answers below are the ones a down backend actually
// produces; every one of them is fulfilled by the test, so nothing here needs
// a database, a container, or a network.
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const SHELL = join(repoRoot, "frontend/public/index.html");

// The api's own client-route answer (backend/src/api/static.ts routeShell, and
// website-server/nginx.conf's `try_files ... /index.html`): the SPA shell, 200.
const spaShell = () => readFileSync(SHELL, "utf8");

const NGINX_502 =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

let server: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  server = spawn("bun", ["scripts/preview-server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview server did not print its URL within 15s")), 15_000);
    let out = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview server exited early (code ${code})`));
    });
  });
});

test.afterAll(() => {
  server?.kill();
});

// The static server has no SPA fallback of its own (it answers an extensionless
// path with its 404 page), so the document for the client route is served here
// — the same bytes, and the same 200, that the deployed static serving gives it.
// Assets, view fragments and /config.js all come from the real server.
async function openRoute(page: Page, route: string) {
  await page.route(`${baseUrl}${route}`, (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: spaShell() }));
  await page.goto(`${baseUrl}${route}`);
}

// The strings that must never reach a reader, whatever the copy around them is.
// A parser message is listed per engine (V8 and JavaScriptCore word it
// differently) so this can't pass by only knowing one of them.
const MACHINE_NOISE = [
  /Unexpected token/i,
  /Unexpected identifier/i,
  /is not valid JSON/i,
  /JSON Parse error/i,
  /SyntaxError/i,
  /Failed to fetch/i,
  /<!doctype/i,
  /<html/i,
];

// The banner has to SAY the backend is the problem. Deliberately a family of
// phrasings rather than one exact sentence: the point is that a reader (or an
// operator reading a screenshot) can tell this is an outage, not a bug in the
// regime data.
const NAMES_THE_OUTAGE =
  /unavailable|unreachable|can'?t reach|cannot reach|could not be reached|not responding|is down|try again/i;

async function errorText(page: Page): Promise<string> {
  const banner = page.locator(".rv__error");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  return (await banner.innerText()).trim();
}

async function expectReadableOutage(page: Page) {
  const text = await errorText(page);
  for (const pattern of MACHINE_NOISE) expect(text, `error banner leaks machine noise: ${text}`).not.toMatch(pattern);
  expect(text, `error banner does not name the outage: ${text}`).toMatch(NAMES_THE_OUTAGE);
}

const REGIME_CALL = "**/api/dashboards/regime-snapshots*";

test.describe("/regime with a backend that is not serving", () => {
  // THE REPORTED FAILURE. Something other than the api answered — a static
  // fallback, a proxy rule, an edge — so the body is the SPA shell at 200 and
  // `res.json()` chokes on the first '<'.
  test("an API call answered with the SPA shell reads as an outage, not as a parse error", async ({ page }) => {
    await page.route(REGIME_CALL, (r) =>
      r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: spaShell() }));

    await openRoute(page, "/regime");
    await expectReadableOutage(page);
  });

  // api process up, Postgres unreachable. Today: `API 500: {"error":"internal
  // error"}` — a serialized object, and it names neither the database nor the
  // fact that nothing is wrong with the page itself.
  test("a database outage reads as a database outage", async ({ page }) => {
    await page.route(REGIME_CALL, (r) =>
      r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "database unavailable" }) }));

    await openRoute(page, "/regime");
    const text = await errorText(page);
    for (const pattern of MACHINE_NOISE) expect(text).not.toMatch(pattern);
    expect(text).toMatch(/database/i);
    expect(text, "a JSON envelope is rendered as an object, not as prose").not.toMatch(/[{}"]/);
  });

  // A reverse proxy in front of a dead api.
  test("a 502 from a proxy never renders the proxy's markup", async ({ page }) => {
    await page.route(REGIME_CALL, (r) =>
      r.fulfill({ status: 502, contentType: "text/html", body: NGINX_502 }));

    await openRoute(page, "/regime");
    await expectReadableOutage(page);
  });

  // Nothing is listening: the api container never started (its database
  // dependency is unhealthy), or the origin is down behind the tunnel.
  test("a refused connection reads as an unreachable API", async ({ page }) => {
    await page.route(REGIME_CALL, (r) => r.abort("connectionrefused"));

    await openRoute(page, "/regime");
    await expectReadableOutage(page);
  });

  // The page must degrade, not disappear: the nav and the footer are shell
  // content with nothing to do with the snapshot, and an outage must not take
  // them down with it.
  test("the rest of the page still renders around the outage", async ({ page }) => {
    await page.route(REGIME_CALL, (r) => r.abort("connectionrefused"));

    await openRoute(page, "/regime");
    await errorText(page);
    await expect(page.locator("nav.nav")).toBeVisible();
    await expect(page.locator("footer.footer")).toBeVisible();
  });
});

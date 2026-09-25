// D54 (issue #1026 W7, criterion 163): the page checks GET /api/version against
// its own declared range at load, and when the API is outside it shows a reload
// notice INSTEAD OF calling the API.
//
// The failure this exists for: the site and the API ship separately now, so a
// tab left open across an API upgrade — or a site switched in ahead of the API
// it was built for — would render one API's shapes through another's page code.
// The page cannot fix that; it can say so, and stop.
//
// SPA LOADED DIRECTLY, not through the preview wrapper: the wrapper answers
// /api/* inside the page's own fetch, so no request would ever reach the
// network for Playwright to count. Here every /api/* request the page makes
// goes through page.route, which answers it from the committed goldens and
// counts it. Same arrangement as api-unreachable.spec.ts: the real
// scripts/preview-server.ts serves the working tree (including /version.json,
// which carries frontend/package.json's apiRange), and the client route's
// document is the SPA shell the deployed static serving returns for it.
//
// No backend, no Docker, no network beyond localhost.
import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const SHELL = join(repoRoot, "frontend/public/index.html");
const spaShell = () => readFileSync(SHELL, "utf8");
const GOLDENS = JSON.parse(readFileSync(join(repoRoot, "goldens/api-goldens.json"), "utf8")) as {
  routes: Record<string, unknown>;
};
const SITE_RANGE = (JSON.parse(readFileSync(join(repoRoot, "frontend/package.json"), "utf8")) as { apiRange: string }).apiRange;

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

interface Session {
  /** Every /api/* path the page requested, in order, /api/version included. */
  apiCalls: string[];
  consoleErrors: string[];
}

/**
 * Open `route` with /api/version answering `apiVersionBody` and every other
 * /api/* answered from goldens (an empty 200 object where no golden exists, so
 * a missing golden can never pose as a console error this spec is about).
 */
async function open(page: Page, route: string, apiVersionBody: unknown): Promise<Session> {
  const session: Session = { apiCalls: [], consoleErrors: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") session.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => session.consoleErrors.push(`pageerror: ${err.message}`));

  await page.route(`${baseUrl}/api/**`, (r: Route) => {
    const path = new URL(r.request().url()).pathname;
    session.apiCalls.push(path);
    const body = path === "/api/version" ? apiVersionBody : (GOLDENS.routes[path] ?? {});
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route(`${baseUrl}${route}`, (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: spaShell() }));
  await page.goto(`${baseUrl}${route}`);
  return session;
}

const NOTICE = "[data-api-compat-notice]";

test.describe("the page's API range check at load", () => {
  test("the site under test declares a range, and the golden API version is inside it", () => {
    expect(SITE_RANGE).toMatch(/\d+\.\d+\.\d+/);
    expect((GOLDENS.routes["/api/version"] as { api: string }).api).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("an API outside the range: reload notice, zero other /api/* calls, clean console", async ({ page }) => {
    const session = await open(page, "/", { api: "99.0.0", commit: null });

    const notice = page.locator(NOTICE);
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText(/reload/i);
    await expect(notice.getByRole("button", { name: /reload/i })).toBeVisible();
    await expect(notice).toHaveAttribute("data-api", "99.0.0");
    await expect(notice).toHaveAttribute("data-range", SITE_RANGE);

    // Let every view that would have loaded data get its chance to try.
    await expect(page.locator("nav.nav")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);

    expect(session.apiCalls).toEqual(["/api/version"]);
    expect(session.consoleErrors).toEqual([]);
  });

  test("an API inside the range: no notice, and the page loads its data", async ({ page }) => {
    const session = await open(page, "/", GOLDENS.routes["/api/version"]);

    await expect(page.locator("nav.nav")).toBeVisible({ timeout: 15_000 });
    // The home page reads the allocation framework (terminalBoot and the
    // architecture sleeves). Seeing that request is the proof the gate opened.
    await expect.poll(() => session.apiCalls.includes("/api/dashboards/allocation"), { timeout: 15_000 }).toBe(true);
    await page.waitForLoadState("networkidle");

    expect(session.apiCalls[0]).toBe("/api/version");
    expect(session.apiCalls.length).toBeGreaterThan(1);
    await expect(page.locator(NOTICE)).toHaveCount(0);
    expect(session.consoleErrors).toEqual([]);
  });

  test("red control: the notice is the check's doing — an in-range API on the same route never shows it, an out-of-range one always does", async ({ page, context }) => {
    // Same route, same goldens, only /api/version differs, in two pages of one
    // context; a notice that appeared for reasons other than the version would
    // show in both, and one the check never raised would show in neither.
    const golden = GOLDENS.routes["/api/version"] as { api: string };
    const bumped = { ...golden, api: "0.0.1" };

    const inRange = await open(page, "/", golden);
    await expect.poll(() => inRange.apiCalls.includes("/api/dashboards/allocation"), { timeout: 15_000 }).toBe(true);
    await page.waitForLoadState("networkidle");
    await expect(page.locator(NOTICE)).toHaveCount(0);

    const outPage = await context.newPage();
    const outOfRange = await open(outPage, "/", bumped);
    await expect(outPage.locator(NOTICE)).toBeVisible({ timeout: 15_000 });
    await expect(outPage.locator(NOTICE)).toHaveAttribute("data-api", "0.0.1");
    await outPage.waitForLoadState("networkidle");
    expect(outOfRange.apiCalls).toEqual(["/api/version"]);
  });

  test("an unreachable /api/version is not a mismatch: the page carries on", async ({ page }) => {
    // The api-unreachable path owns outages; this check must not turn one into
    // a "reload" notice.
    const apiCalls: string[] = [];
    await page.route(`${baseUrl}/api/**`, (r) => {
      const path = new URL(r.request().url()).pathname;
      apiCalls.push(path);
      if (path === "/api/version") return r.abort("connectionrefused");
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GOLDENS.routes[path] ?? {}) });
    });
    await page.route(`${baseUrl}/`, (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: spaShell() }));
    await page.goto(`${baseUrl}/`);
    await expect.poll(() => apiCalls.includes("/api/dashboards/allocation"), { timeout: 15_000 }).toBe(true);
    await expect(page.locator(NOTICE)).toHaveCount(0);
  });
});

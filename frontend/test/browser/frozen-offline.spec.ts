// The load-bearing proof of the server-less "frozen" static distribution: it
// writes the ACTUAL static dist the bake produces (from committed fixtures, no
// backend), serves it over HTTP with a dumb static server + SPA fallback (the
// exact shape any static host — GitHub Pages, S3, nginx — would serve), then
// drives every view through the SPA router and asserts each renders purely from
// the static /data/*.json snapshots.
//
// Two guarantees, loud-failing (never skipped): (1) ZERO external network — no
// request leaks to a CDN or any off-origin host, so a regression that re-adds a
// CDN <script> or a live API fetch cannot pass; the page's data comes from
// /data/… static JSON. (2) every view renders with no console/page error, with
// the regime / research / committee views built from the static snapshots.
//
// The dist is built hermetically from committed fixtures (no backend, no network)
// in beforeAll via the same writeFrozenDist() path CI publishes; vendored libs
// are local in the dist, so no page.route stubbing is needed.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { writeFrozenDist } from "../../../scripts/lib/frozen-build.ts";
import { fixtureFrozenData } from "../../../scripts/lib/frozen-fixtures.ts";

const repoRoot = process.cwd();
let server: Server;
let base: string;
let outDir: string;

// Module scripts require a correct JS MIME type or the browser refuses to run
// them, so serve real content types (mirrors what any static host sends).
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

test.beforeAll(async () => {
  // 1. Write the real static frozen dist from fixtures — no backend, no network.
  outDir = mkdtempSync(join(tmpdir(), "frozen-offline-"));
  writeFrozenDist({
    repoRoot,
    outDir,
    frozenData: fixtureFrozenData(repoRoot),
    meta: { bakedAt: "2026-06-29T00:00:00.000Z", source: "fixtures" },
  });

  // 2. Serve it over HTTP with an index.html SPA fallback (mirrors serve-frozen.ts).
  server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    // Resolve within outDir; missing files fall back to index.html (SPA deep links).
    const rel = normalize(p === "/" ? "index.html" : p.replace(/^\/+/, ""));
    let file = join(outDir, rel);
    if (!file.startsWith(outDir) || !existsSync(file) || !statSync(file).isFile()) {
      file = join(outDir, "index.html");
    }
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
  base = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

// SPA navigation via the history router (matches spa.spec.ts / analytics-views.spec.ts).
async function navigate(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

function trapErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  return errors;
}

test("home boots offline from the static dist with no console errors", async ({ page }) => {
  const errors = trapErrors(page);

  await page.goto(base + "/");
  // The shell + router boot and inject the home view into #view.
  await expect(page.locator("nav.nav")).toBeVisible();
  await expect.poll(async () =>
    (await page.locator("#view").innerHTML()).trim().length,
  ).toBeGreaterThan(0);

  await page.waitForTimeout(150);
  expect(errors).toEqual([]);
});

test("regime view renders from /data/api/dashboards/regime-snapshots.json", async ({ page }) => {
  const errors = trapErrors(page);

  await page.goto(base + "/");
  await navigate(page, "/regime");

  await expect(page.locator(".rv__title")).toContainText("Regime");
  // A canvas (the composite-history Chart.js instance) is built from the snapshot.
  await expect(page.locator(".rv__chart canvas").first()).toBeVisible();

  await page.waitForTimeout(150);
  expect(errors).toEqual([]);
});

test("research signal view renders its gauges from the static snapshot", async ({ page }) => {
  const errors = trapErrors(page);

  await page.goto(base + "/");
  await navigate(page, "/research/channel-divergence");

  await expect(page.locator(".rs__title")).toContainText("Channel divergence");
  await expect(page.locator(".rs__gauge")).toHaveCount(4);

  await page.waitForTimeout(150);
  expect(errors).toEqual([]);
});

test("committee view renders the baked takes from the static snapshot", async ({ page }) => {
  const errors = trapErrors(page);

  await page.goto(base + "/");
  await navigate(page, "/committee");

  await expect(page.locator(".cv__take")).toHaveCount(3);

  await page.waitForTimeout(150);
  expect(errors).toEqual([]);
});

test("data comes from /data static JSON and nothing leaks to an external origin", async ({ page }) => {
  const external: string[] = [];
  const dataHits: string[] = [];
  page.on("requestfinished", (req) => {
    const url = req.url();
    if (url.startsWith(base + "/data/")) dataHits.push(url);
    // Any request to a different origin (a CDN, a live API) is a leak.
    if (!url.startsWith(base + "/") && (url.startsWith("http://") || url.startsWith("https://"))) {
      external.push(`${req.method()} ${url}`);
    }
  });
  // Hard-block any external origin so a leak fails loudly rather than silently.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(base + "/")) return route.continue();
    external.push(`BLOCKED ${route.request().method()} ${url}`);
    return route.abort();
  });

  await page.goto(base + "/");
  await navigate(page, "/regime");
  await navigate(page, "/committee");
  await page.waitForTimeout(200);

  // At least one snapshot was fetched from the static /data tree…
  expect(dataHits.length).toBeGreaterThan(0);
  // …and nothing went off-origin (no CDN, no backend).
  expect(external).toEqual([]);
});

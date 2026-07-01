// The load-bearing proof of the server-less "frozen" build: it takes the ACTUAL
// single-file artifact the bake produces, loads it over the file:// scheme with
// NO backend and NO network, drives every view through the SPA router, and
// asserts the data-driven charts render from the baked snapshot — exactly the
// non-technical "double-click index.html" experience the issue ships.
//
// Two guarantees, loud-failing (never skipped): (1) ZERO network — any http(s)
// request from the page fails the test, so a regression that leaks a live fetch
// or a CDN <script> cannot pass; (2) every view renders with no console/page
// error, and the regime / research / allocation charts are real Chart.js
// instances built from the inlined data.
//
// The artifact is built hermetically from committed fixtures (no backend) in
// beforeAll via the same `scripts/bake-frozen.ts --fixtures` path CI publishes.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const repoRoot = process.cwd();
const builtFile = join(repoRoot, "dist", "frozen", "index.html");
const fileUrl = pathToFileURL(builtFile).href;

test.beforeAll(() => {
  // Build the real single-file artifact from fixtures — no backend, no network.
  execFileSync("bun", ["run", "scripts/bake-frozen.ts", "--fixtures"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (!existsSync(builtFile)) throw new Error(`frozen build did not emit ${builtFile}`);
});

// Fail on ANY off-file network request (http/https). file:// sub-resource loads
// are inlined away; only the top document itself is file://.
function trapNetwork(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("http://") || url.startsWith("https://")) hits.push(`${req.method()} ${url}`);
  });
  return hits;
}

function trapErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  return errors;
}

// In-app navigation that works under file:// (where history.pushState throws a
// swallowed SecurityError): synthesize an anchor and click it so the router's
// own click handler renders the target path from the anchor href, not location.
async function navigate(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    const a = document.createElement("a");
    a.setAttribute("href", p);
    a.textContent = "nav";
    a.style.position = "fixed";
    a.style.left = "-9999px";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, path);
}

test("loads offline from file:// with zero network and no errors", async ({ page }) => {
  const net = trapNetwork(page);
  const errors = trapErrors(page);

  await page.goto(fileUrl);
  // The shell renders the home view immediately (router boot). Under file:// the
  // boot path is index.html's own fs path, which the shim routes to home rather
  // than a 404 — what a double-click should show.
  await expect(page.locator("nav.nav")).toBeVisible();
  await expect.poll(async () =>
    (await page.locator("#view").innerText()).includes("Page not found"),
  ).toBe(false);
  await expect.poll(async () =>
    (await page.locator("#view").innerText()).length,
  ).toBeGreaterThan(500);

  // Walk every nav destination plus the two research signals — all inlined.
  const routes = [
    "/skills", "/tokenomics", "/allocation", "/allocation2", "/regime",
    "/committee", "/media", "/blog", "/docs", "/changelog",
    "/research/channel-divergence", "/research/late-cycle-signals", "/",
  ];
  for (const r of routes) {
    await navigate(page, r);
    // The router injected a non-empty view.
    await expect.poll(async () =>
      (await page.locator("#view").innerHTML()).trim().length,
    ).toBeGreaterThan(0);
  }

  // Let any deferred fetch/module failure surface on the event loop.
  await page.waitForTimeout(150);
  expect(net).toEqual([]);
  expect(errors).toEqual([]);
});

test("regime view renders a real chart + enriched panels from the baked snapshot", async ({ page }) => {
  await page.goto(fileUrl);
  await navigate(page, "/regime");

  await expect(page.locator(".rv__title")).toContainText("Regime");
  await expect(page.locator(".rv__panel")).toHaveCount(2);

  // The composite history canvas is a live Chart.js instance built from data.
  await expect.poll(async () =>
    page.locator(".rv__chart canvas").evaluate((c) =>
      Boolean((window as any).Chart?.getChart(c as HTMLCanvasElement)),
    ),
  ).toBe(true);
});

test("research signal view renders its gauges + chart offline", async ({ page }) => {
  await page.goto(fileUrl);
  await navigate(page, "/research/channel-divergence");

  await expect(page.locator(".rs__title")).toContainText("Channel divergence");
  await expect(page.locator(".rs__gauge")).toHaveCount(4);
  await expect(page.locator(".rs__gauge", { hasText: "Stablecoin vs QQQ flow" })
    .locator(".rs__gauge-val")).toHaveText("0.0137");

  await expect.poll(async () =>
    page.locator(".rs__chart canvas").evaluate((c) =>
      Boolean((window as any).Chart?.getChart(c as HTMLCanvasElement)),
    ),
  ).toBe(true);
});

test("committee view loads the baked session offline", async ({ page }) => {
  await page.goto(fileUrl);
  await navigate(page, "/committee");

  await expect(page.locator(".cv__title")).toContainText("Committee");
  // The baked published session renders (the empty-state stays hidden) with its
  // subject name pulled from the inlined snapshot.
  await expect(page.locator(".cv__empty")).toBeHidden();
  await expect.poll(async () =>
    (await page.locator("#view").innerText()).includes("Woon Treasury"),
  ).toBe(true);
});

test("allocation view renders its pie chart offline", async ({ page }) => {
  await page.goto(fileUrl);
  await navigate(page, "/allocation");

  await expect(page.locator("#allocationPie")).toBeVisible();
  await expect.poll(async () =>
    page.locator("#allocationPie").evaluate((c) =>
      Boolean((window as any).Chart?.getChart(c as HTMLCanvasElement)),
    ),
  ).toBe(true);
});

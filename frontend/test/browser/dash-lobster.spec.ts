// Render + interaction coverage for the /lobster "Lobster Coins" directory
// (issue #386, docs/bot-analytics-ui-port-plan.md §5.9, P2.3). Same harness
// as projects.spec.ts / dash-shell.spec.ts: the SPA + view HTML are served by
// the real backend at baseURL, vendor CDN scripts are fulfilled from
// node_modules, the gate's /api/admin/auth is mocked (dash-gate-mock.ts), and
// GET /api/dashboards/coins is stubbed with a deterministic DTO so assertions are
// network-free.
//
// Generate/refresh the visual baseline with:
//   bun run test:browser -- --update-snapshots dash-lobster
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { mockDashGateApi, loginToDash } from "./dash-gate-mock.ts";
import { navigate } from "./navigation.ts";

const COINS = {
  coins: [
    { id: "c-alp", name: "Alpha Coin", ticker: "ALP", priceUsd: 1.2345, marketCap: 8_000_000, volume24h: 500_000, percentChange24h: 4.2, chain: "base", refreshedAt: new Date().toISOString(), stale: false },
    { id: "c-bet", name: "Beta Coin", ticker: "BET", priceUsd: 0.000456, marketCap: 1_500_000, volume24h: 90_000, percentChange24h: -2.1, chain: "base", refreshedAt: null, stale: true },
    { id: "c-gam", name: "Gamma Coin", ticker: null, priceUsd: 1500.5, marketCap: null, volume24h: null, percentChange24h: null, chain: null, refreshedAt: null, stale: true },
  ],
};

function mockCoinsApi(page: Page, body: unknown = COINS): void {
  page.route("**/api/dashboards/coins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockDashGateApi(page);
});

test("routes to /lobster under the dash shell and renders the default mcap-desc sort", async ({ page }) => {
  mockCoinsApi(page);
  await page.goto("/");
  await loginToDash(page, "/lobster");

  await expect(page.locator("[data-dash-lobster]")).toBeVisible();
  const rows = page.locator("[data-dash-lobster-table] tbody tr");
  await expect(rows).toHaveCount(3);
  // Default sort is market cap desc; the null-mcap row sorts last.
  await expect(rows.nth(0)).toContainText("Alpha Coin");
  await expect(rows.nth(1)).toContainText("Beta Coin");
  await expect(rows.nth(2)).toContainText("Gamma Coin");
});

test("smart price precision renders per tier", async ({ page }) => {
  mockCoinsApi(page);
  await page.goto("/");
  await loginToDash(page, "/lobster");

  const rows = page.locator("[data-dash-lobster-table] tbody tr");
  await expect(rows.nth(0)).toContainText("$1.2345"); // >= 1 → 4dp
  await expect(rows.nth(1)).toContainText("$0.000456"); // >= 0.01 uses 6dp bucket; below it, toPrecision(4)
  await expect(rows.nth(2)).toContainText("$1,500.5"); // >= 1000 → locale, 2dp max
});

test("clicking a column header toggles sort direction and re-orders rows", async ({ page }) => {
  mockCoinsApi(page);
  await page.goto("/");
  await loginToDash(page, "/lobster");

  const rows = page.locator("[data-dash-lobster-table] tbody tr");
  await page.locator("[data-sort='name']").click();
  await expect(rows.nth(0)).toContainText("Alpha Coin"); // asc by name on first click

  await page.locator("[data-sort='name']").click();
  await expect(rows.nth(0)).toContainText("Gamma Coin"); // desc on second click of the same column
});

test("whole row navigates to the coin's dossier route", async ({ page }) => {
  mockCoinsApi(page);
  await page.goto("/");
  await loginToDash(page, "/lobster");

  await page.locator("[data-dash-lobster-table] tbody tr").first().click();
  await expect(page).toHaveURL(/\/lobster\/c-alp$/);
});

test("empty payload shows the empty state", async ({ page }) => {
  mockCoinsApi(page, { coins: [] });
  await page.goto("/");
  await loginToDash(page, "/lobster");

  await expect(page.locator("[data-dash-empty]")).toBeVisible();
  await expect(page.locator("[data-dash-lobster-table]")).not.toBeVisible();
});

test("refresh button is disabled (no on-demand trigger exists yet, D10)", async ({ page }) => {
  mockCoinsApi(page);
  await page.goto("/");
  await loginToDash(page, "/lobster");

  await expect(page.locator("[data-dash-refresh]")).toBeDisabled();
});

test("/lobster visual baseline", async ({ page }) => {
  mockCoinsApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loginToDash(page, "/lobster");
  await expect(page.locator("[data-dash-lobster-table]")).toBeVisible();
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("dash-lobster-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

// Render + interaction coverage for the /vaults "Agent-Managed Vaults"
// directory (issue #386, docs/bot-analytics-ui-port-plan.md §5.11, P2.4).
// Same harness as dash-lobster.spec.ts: real backend serving the SPA/view
// HTML, vendor CDN scripts fulfilled locally, gate mocked, and GET
// /api/dashboards/vaults stubbed with a deterministic DTO.
//
// Generate/refresh the visual baseline with:
//   bun run test:browser -- --update-snapshots dash-vaults
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { mockDashGateApi, loginToDash } from "./dash-gate-mock.ts";

const VAULTS = {
  vaults: [
    { id: "v-big", name: "Big Vault", strategyType: "erc4626", protocol: "aave", chain: "base", dataSource: "live", tvlUsd: 900_000, yieldApy: 5.25, managingAgentName: "Agent One", refreshedAt: new Date().toISOString(), stale: false },
    { id: "v-small", name: "Small Vault", strategyType: "lp", protocol: null, chain: "base", dataSource: "live", tvlUsd: 100_000, yieldApy: 2.1, managingAgentName: null, refreshedAt: null, stale: true },
    { id: "v-upcoming", name: "Upcoming Vault", strategyType: null, protocol: null, chain: null, dataSource: "upcoming", tvlUsd: null, yieldApy: null, managingAgentName: null, refreshedAt: null, stale: true },
  ],
};

function mockVaultsApi(page: Page, body: unknown = VAULTS): void {
  page.route("**/api/dashboards/vaults", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockDashGateApi(page);
});

test("routes to /vaults under the dash shell and renders the default tvl-desc sort", async ({ page }) => {
  mockVaultsApi(page);
  await page.goto("/");
  await loginToDash(page, "/vaults");

  await expect(page.locator("[data-dash-vaults]")).toBeVisible();
  const rows = page.locator("[data-dash-vaults-table] tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Big Vault");
  await expect(rows.nth(1)).toContainText("Small Vault");
  await expect(rows.nth(2)).toContainText("Upcoming Vault");
});

test("summary cards compute total TVL, average APY, and active vault count", async ({ page }) => {
  mockVaultsApi(page);
  await page.goto("/");
  await loginToDash(page, "/vaults");

  const summary = page.locator("[data-dash-vaults-summary]");
  await expect(summary).toContainText("$1.00M"); // 900k + 100k, upcoming vault contributes 0
  await expect(summary).toContainText("3"); // active vault count
});

test("an upcoming vault renders a dash for TVL and APY instead of a fabricated figure", async ({ page }) => {
  mockVaultsApi(page);
  await page.goto("/");
  await loginToDash(page, "/vaults");

  const upcomingRow = page.locator("[data-dash-vaults-table] tbody tr", { hasText: "Upcoming Vault" });
  await expect(upcomingRow.locator("td").nth(2)).toHaveText("—");
  await expect(upcomingRow.locator("td").nth(3)).toHaveText("—");
});

test("managing agent falls back to a dash when the vault has no resolvable agent", async ({ page }) => {
  mockVaultsApi(page);
  await page.goto("/");
  await loginToDash(page, "/vaults");

  const smallRow = page.locator("[data-dash-vaults-table] tbody tr", { hasText: "Small Vault" });
  await expect(smallRow).toContainText("—");
});

test("clicking the TVL header sorts ascending then descending", async ({ page }) => {
  mockVaultsApi(page);
  await page.goto("/");
  await loginToDash(page, "/vaults");

  const rows = page.locator("[data-dash-vaults-table] tbody tr");
  await page.locator("[data-sort='tvlUsd']").click();
  await expect(rows.nth(0)).toContainText("Upcoming Vault"); // asc: null tvl sorts lowest first

  await page.locator("[data-sort='tvlUsd']").click();
  await expect(rows.nth(0)).toContainText("Big Vault"); // desc restores default order
});

test("whole row navigates to the vault's dossier route", async ({ page }) => {
  mockVaultsApi(page);
  await page.goto("/");
  await loginToDash(page, "/vaults");

  await page.locator("[data-dash-vaults-table] tbody tr").first().click();
  await expect(page).toHaveURL(/\/vaults\/v-big$/);
});

test("empty payload shows the empty state", async ({ page }) => {
  mockVaultsApi(page, { vaults: [] });
  await page.goto("/");
  await loginToDash(page, "/vaults");

  await expect(page.locator("[data-dash-empty]")).toBeVisible();
  await expect(page.locator("[data-dash-vaults-table]")).not.toBeVisible();
});

test("/vaults visual baseline", async ({ page }) => {
  mockVaultsApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loginToDash(page, "/vaults");
  await expect(page.locator("[data-dash-vaults-table]")).toBeVisible();
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("dash-vaults-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

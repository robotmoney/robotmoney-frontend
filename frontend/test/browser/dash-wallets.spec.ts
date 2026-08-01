// Render + interaction coverage for the /wallets "Tracked Wallets" directory
// (issue #386, docs/bot-analytics-ui-port-plan.md §5.13, P2.5). Same harness
// as dash-lobster.spec.ts / dash-vaults.spec.ts: real backend serving the
// SPA/view HTML, vendor CDN scripts fulfilled locally, gate mocked, and GET
// /api/dashboards/wallets stubbed with a deterministic DTO.
//
// Generate/refresh the visual baseline with:
//   bun run test:browser -- --update-snapshots dash-wallets
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { mockDashGateApi, loginToDash } from "./dash-gate-mock.ts";
import { navigate } from "./navigation.ts";

const WALLETS = {
  wallets: [
    { id: "w-treasury", label: "Treasury", chain: "base", balanceUsd: 5000, address: "0xAAA1111111111111111111111111111111111111", lastTxAt: new Date().toISOString(), source: "tracked", protocol: null, agentId: null, refreshedAt: new Date().toISOString(), stale: false },
    { id: "a-solo", label: "Solo Agent", chain: null, balanceUsd: null, address: "0xBBB2222222222222222222222222222222222222", lastTxAt: null, source: "agent", protocol: "x402", agentId: "agent-solo", refreshedAt: null, stale: true },
    { id: "w-empty", label: "Empty Wallet", chain: "base", balanceUsd: 0, address: "0xCCC3333333333333333333333333333333333333", lastTxAt: null, source: "tracked", protocol: null, agentId: null, refreshedAt: null, stale: true },
  ],
};

function mockWalletsApi(page: Page, body: unknown = WALLETS): void {
  page.route("**/api/dashboards/wallets", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockDashGateApi(page);
});

test("routes to /wallets under the dash shell, hiding empty rows by default", async ({ page }) => {
  mockWalletsApi(page);
  await page.goto("/");
  await loginToDash(page, "/wallets");

  await expect(page.locator("[data-dash-wallets]")).toBeVisible();
  // hideEmpty defaults on (§5.13) — the $0-balance row is filtered out.
  const rows = page.locator("[data-dash-wallets-table] tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Treasury");
});

test("toggling Hide empty reveals the zero-balance row; summary counts all rows", async ({ page }) => {
  mockWalletsApi(page);
  await page.goto("/");
  await loginToDash(page, "/wallets");

  await expect(page.locator("[data-dash-summary]")).toContainText("3"); // total tracked, unaffected by the filter
  await page.locator("[data-dash-chip='hideEmpty']").click();
  const rows = page.locator("[data-dash-wallets-table] tbody tr");
  await expect(rows).toHaveCount(3);
});

test("X402 only isolates the agent-derived x402 row", async ({ page }) => {
  mockWalletsApi(page);
  await page.goto("/");
  await loginToDash(page, "/wallets");

  await page.locator("[data-dash-chip='hideEmpty']").click(); // reveal all rows first
  await page.locator("[data-dash-chip='x402']").click();
  const rows = page.locator("[data-dash-wallets-table] tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Solo Agent");
});

test("chain column is hidden entirely when every visible row shares one chain", async ({ page }) => {
  mockWalletsApi(page, {
    wallets: [
      { id: "w1", label: "One", chain: "base", balanceUsd: 100, address: "0x1", lastTxAt: null, source: "tracked", protocol: null, agentId: null, refreshedAt: null, stale: true },
      { id: "w2", label: "Two", chain: "base", balanceUsd: 200, address: "0x2", lastTxAt: null, source: "tracked", protocol: null, agentId: null, refreshedAt: null, stale: true },
    ],
  });
  await page.goto("/");
  await loginToDash(page, "/wallets");
  await expect(page.locator("[data-dash-chain-col]")).toBeHidden();
});

test("chain column shows when visible rows span multiple chains", async ({ page }) => {
  mockWalletsApi(page, {
    wallets: [
      { id: "w1", label: "One", chain: "base", balanceUsd: 100, address: "0x1", lastTxAt: null, source: "tracked", protocol: null, agentId: null, refreshedAt: null, stale: true },
      { id: "w2", label: "Two", chain: "ethereum", balanceUsd: 200, address: "0x2", lastTxAt: null, source: "tracked", protocol: null, agentId: null, refreshedAt: null, stale: true },
    ],
  });
  await page.goto("/");
  await loginToDash(page, "/wallets");
  await expect(page.locator("[data-dash-chain-col]")).toBeVisible();
});

test("agent-sourced row navigates to /agents/:id; tracked row navigates to /wallets/:id", async ({ page }) => {
  mockWalletsApi(page);
  await page.goto("/");
  await loginToDash(page, "/wallets");

  // Click the Label cell specifically — the row's own bounding-box center
  // (Playwright's default click point) can land on the address cell's
  // hover-revealed copy/explorer buttons on a wide table, which deliberately
  // stop propagation (see "copy button does not trigger row navigation"
  // below); clicking the label cell is the unambiguous "click the row" probe.
  await page.locator("[data-dash-wallets-table] tbody tr", { hasText: "Treasury" }).locator("td").first().click();
  await expect(page).toHaveURL(/\/wallets\/w-treasury$/);

  // Client-side nav back to /wallets — the SPA layout/gate session persists
  // across navigations (router.js's layout composition), so no re-login.
  await navigate(page, "/wallets");
  await page.locator("[data-dash-chip='hideEmpty']").click();
  await page.locator("[data-dash-wallets-table] tbody tr", { hasText: "Solo Agent" }).locator("td").first().click();
  await expect(page).toHaveURL(/\/agents\/agent-solo$/);
});

test("copy button does not trigger row navigation", async ({ page }) => {
  mockWalletsApi(page);
  await page.goto("/");
  await loginToDash(page, "/wallets");

  await page.locator("[data-dash-wallets-table] tbody tr", { hasText: "Treasury" }).locator(".a3-copy-btn").first().click();
  await expect(page).toHaveURL(/\/wallets$/);
});

test("Scan now is disabled (no wallet-scan pipeline exists yet, D10)", async ({ page }) => {
  mockWalletsApi(page);
  await page.goto("/");
  await loginToDash(page, "/wallets");

  await expect(page.locator("[data-dash-scan]")).toBeDisabled();
});

test("empty payload shows the empty state", async ({ page }) => {
  mockWalletsApi(page, { wallets: [] });
  await page.goto("/");
  await loginToDash(page, "/wallets");

  await expect(page.locator("[data-dash-empty]")).toBeVisible();
  await expect(page.locator("[data-dash-wallets-table]")).not.toBeVisible();
});

test("/wallets visual baseline", async ({ page }) => {
  mockWalletsApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loginToDash(page, "/wallets");
  await expect(page.locator("[data-dash-wallets-table]")).toBeVisible();
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("dash-wallets-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

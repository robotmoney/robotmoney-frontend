// Render + interaction tests for /list2 — "List v2 (WIP)" (issue #387,
// docs/bot-analytics-ui-port-plan.md §5.2, P2.6). Same harness as
// dash-shell.spec.ts / list-view.spec.ts (#384): vendor CDN scripts served
// from node_modules, the gate's POST /api/admin/auth mocked (its own wire
// contract is proven by admin-live.spec.ts), and GET /api/dashboards/list2
// stubbed with a deterministic DTO so tab switching, per-tab column
// presence/formats, sort defaults, and explorer hrefs are network-free and
// reproducible.
//
// Visual golden (issue #396): /list2 is not one of §7's 7 designated
// pixel-QA reference-fidelity shots (gate screen, /list, /list3 drawer,
// /projects mid-scroll, /agents/:id dossier, /dashboard terminal,
// /wallets/:id drawer), but it IS a shipped view like every sibling list
// page (list-view.spec.ts, agents-view.spec.ts, dash-lobster.spec.ts,
// dash-vaults.spec.ts, dash-wallets.spec.ts all carry one) — this was the
// one shipped Analytics Surface list view missing its own self-regression
// CSS-drift baseline; added here to close that gap, same convention.
//
// Generate/refresh the baseline with:
//   bun run test:browser -- --update-snapshots list2-view
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "demo-access-key";

const LIST2 = {
  agents: [
    {
      id: "a1", name: "Agent Alpha", href: "/agents/a1", protocol: "x402",
      earned30d: 500, tokenTax30d: 10, inflow30d: 510, x402Volume30d: 900, x402Txns30d: 12,
      walletAddress: "0xAAA1111111111111111111111111111111111a1", walletBalanceUsd: 4200,
      tokenTicker: "ALPHA", tokenMarketCapUsd: 1_500_000, lastActiveAt: "2026-07-31T22:00:00.000Z",
      priceSparkline: [1, 1.1, 1.2, 1.3],
    },
    {
      id: "a2", name: "Agent Beta", href: "/agents/a2", protocol: "olas",
      earned30d: 0, tokenTax30d: 0, inflow30d: 0, x402Volume30d: 0, x402Txns30d: 0,
      walletAddress: null, walletBalanceUsd: null,
      tokenTicker: null, tokenMarketCapUsd: null, lastActiveAt: null,
      priceSparkline: [],
    },
  ],
  coins: [
    {
      id: "c1", name: "Coin One", href: "/lobster/c1", ticker: "ONE", chain: "base",
      priceUsd: 2.5, percentChange24h: -1.4, marketCapUsd: 800_000, volume24hUsd: 12_000,
      contractAddress: "0xcontractone", priceSparkline: [1, 1.2, 1.3, 1.5],
    },
  ],
  vaults: [
    {
      id: "v1", name: "Vault One", href: "/vaults/v1", protocol: "aave", strategyType: "erc4626",
      chain: "base", tvlUsd: 900_000, apy: 0.07, dataSource: "live", contractAddress: "0xvaultone",
      lastRebalanceAt: "2026-07-30T00:00:00.000Z", tvlSparkline: [1, 1.05, 1.1, 1.2],
    },
  ],
  wallets: [
    {
      id: "w1", label: "Treasury Wallet", href: "/wallets/w1", category: "treasury", chain: "base",
      balanceUsd: 5_000, address: "0xwalletone", lastTxAt: "2026-07-31T20:00:00.000Z",
      refreshedAt: "2026-07-31T21:00:00.000Z", balanceSparkline: [1, 2, 1.5, 2.5],
    },
  ],
};

function mockGateApi(page: Page): void {
  page.route("**/api/admin/auth", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fulfill({ status: 405, body: "" });
    const token = req.headers()["x-admin-token"];
    if (token === ACCESS_KEY) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "bad token" }) });
  });
}

function mockList2Api(page: Page): void {
  page.route("**/api/dashboards/list2", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIST2) }));
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await navigate(page, "/list2");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-list2-view]")).toBeVisible();
  await expect(page.locator("[data-list2-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
  mockList2Api(page);
});

test("defaults to the Agents tab, sorted by 30d earned desc", async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-list2-tabs] [data-tab="agents"]')).toHaveClass(/is-active/);
  const rows = page.locator('[data-list2-table="agents"] tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Agent Alpha"); // earned30d 500 > 0
});

test("Agents tab renders the 30d earned/tax/inflow/x402/wallet/token columns", async ({ page }) => {
  await login(page);
  const firstRow = page.locator('[data-list2-table="agents"] tbody tr').first();
  await expect(firstRow).toContainText("$500.00"); // earned30d
  await expect(firstRow).toContainText("$10.00"); // tokenTax30d
  await expect(firstRow).toContainText("$510.00"); // inflow30d
  await expect(firstRow).toContainText("$900.00"); // x402Volume30d
  await expect(firstRow).toContainText("12"); // x402Txns30d
  await expect(firstRow.locator("[data-wallet-link]")).toHaveAttribute("href", /0xAAA1111/);
  await expect(firstRow).toContainText("ALPHA");
});

test("switching to the Coins tab shows coin-specific columns and explorer contract link", async ({ page }) => {
  await login(page);
  await page.locator('[data-list2-tabs] [data-tab="coins"]').click();
  await expect(page.locator('[data-list2-table="coins"] tbody tr')).toHaveCount(1);
  const row = page.locator('[data-list2-table="coins"] tbody tr').first();
  await expect(row).toContainText("ONE");
  await expect(row).toContainText("BASE");
  await expect(row.locator("[data-contract-link]")).toHaveAttribute("href", /0xcontractone/);
});

test("switching to the Vaults tab shows the SOURCE badge and REBALANCED column", async ({ page }) => {
  await login(page);
  await page.locator('[data-list2-tabs] [data-tab="vaults"]').click();
  const row = page.locator('[data-list2-table="vaults"] tbody tr').first();
  await expect(row).toContainText("LIVE");
  await expect(row).toContainText("erc4626");
});

test("switching to the Wallets tab shows CATEGORY and explorer address link", async ({ page }) => {
  await login(page);
  await page.locator('[data-list2-tabs] [data-tab="wallets"]').click();
  const row = page.locator('[data-list2-table="wallets"] tbody tr').first();
  await expect(row).toContainText("treasury");
  await expect(row.locator("[data-address-link]")).toHaveAttribute("href", /0xwalletone/);
});

test("clicking a sortable column header toggles sort direction", async ({ page }) => {
  await login(page);
  const header = page.locator('[data-list2-table="agents"] thead th').nth(2); // 30D EARNED
  await header.click();
  const firstAfterAsc = await page.locator('[data-list2-table="agents"] tbody tr').first().textContent();
  await header.click();
  const firstAfterDesc = await page.locator('[data-list2-table="agents"] tbody tr').first().textContent();
  expect(firstAfterAsc).not.toBe(firstAfterDesc);
});

test("row links resolve to the expected detail routes across all four tabs", async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-list2-table="agents"] [data-row-link]').first()).toHaveAttribute("href", "/agents/a1");
  await page.locator('[data-list2-tabs] [data-tab="coins"]').click();
  await expect(page.locator('[data-list2-table="coins"] [data-row-link]').first()).toHaveAttribute("href", "/lobster/c1");
  await page.locator('[data-list2-tabs] [data-tab="vaults"]').click();
  await expect(page.locator('[data-list2-table="vaults"] [data-row-link]').first()).toHaveAttribute("href", "/vaults/v1");
  await page.locator('[data-list2-tabs] [data-tab="wallets"]').click();
  await expect(page.locator('[data-list2-table="wallets"] [data-row-link]').first()).toHaveAttribute("href", "/wallets/w1");
});

test("an empty tab renders the empty-state card, not an empty table", async ({ page }) => {
  await page.route("**/api/dashboards/list2", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: [], coins: [], vaults: [], wallets: [] }) }));
  await login(page);
  await expect(page.locator("[data-list2-empty]")).toBeVisible();
});

test("full page visual golden at 1440x900 (self-regression baseline, not a §7 reference-fidelity shot)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("list2-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

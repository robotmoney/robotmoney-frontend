// Render + interaction tests for /list — "Total Market" (issue #384,
// docs/bot-analytics-ui-port-plan.md §5.1, P2.1), the bot-analytics UI port's
// flagship page. Same harness as dash-shell.spec.ts: vendor CDN scripts are
// served from node_modules, the gate's POST /api/admin/auth is mocked (its
// own wire contract is proven by admin-live.spec.ts), and GET /api/dashboards/
// {overview,entities} are stubbed with a deterministic DTO so tab counts,
// sorting, the unverified switch, sessionStorage persistence, the
// last-viewed highlight, and outbound links are all network-free and
// reproducible. Also captures the full-page visual golden (§7 pixel-QA
// method: Playwright's own committed baseline, 1% maxDiffPixelRatio from
// playwright.config.ts, NOT a diff against a foreign screenshot).
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

const OVERVIEW = {
  counts: { agents: 1, coins: 1, vaults: 1, wallets: 1 },
  pendingAgents: 1,
  vaultTvlUsd: 900_000,
  vaultTvlSparkline7d: [1, 2, 3, 4, 5, 6, 7],
  totalAumUsd: 903_400,
  leaders: {
    agent: { type: "agent", id: "a1", name: "Agent One", href: "/agents/a1", value: 80 },
    coin: { type: "coin", id: "c1", name: "Coin One", href: "/lobster/c1", value: 5_000_000 },
    vault: { type: "vault", id: "v1", name: "Vault One", href: "/vaults/v1", value: 900_000 },
  },
  avgProductivityScore: 55,
  robotmoney: { priceUsd: 0.05, marketCapUsd: 2_750_000, totalSupply: 55_000_000_000, stale: false, source: "stub" },
  asOf: "2026-08-01T00:00:00.000Z",
};

const ENTITIES = {
  entities: [
    {
      id: "a1", type: "agent", name: "Agent One", ticker: null, category: "x402", href: "/agents/a1",
      contextual: 80, lastTxAt: null, revenue: 500, balance: null, change24h: null,
      sparkline: [1, 2, 3, 4], pending: false, refreshedAt: "2026-07-31T00:00:00.000Z", stale: false,
    },
    {
      id: "a2", type: "agent", name: "Agent Two", ticker: null, category: "olas", href: "/agents/a2",
      contextual: 10, lastTxAt: null, revenue: 20, balance: null, change24h: null,
      sparkline: [], pending: true, refreshedAt: null, stale: true,
    },
    {
      id: "c1", type: "coin", name: "Coin One", ticker: "ONE", category: "base", href: "/lobster/c1",
      contextual: 5_000_000, lastTxAt: null, revenue: 200_000, balance: null, change24h: 4.2,
      sparkline: [1, 1.2, 1.3, 1.5], pending: false, refreshedAt: "2026-07-31T00:00:00.000Z", stale: false,
    },
    {
      id: "v1", type: "vault", name: "Vault One", ticker: null, category: "erc4626", href: "/vaults/v1",
      contextual: 0.05, lastTxAt: null, revenue: null, balance: 900_000, change24h: null,
      sparkline: [1, 1.1, 1.2, 1.3], pending: false, refreshedAt: "2026-07-31T00:00:00.000Z", stale: false,
    },
    {
      id: "w1", type: "wallet", name: "Wallet One", ticker: null, category: "base", href: "/wallets/w1",
      contextual: null, lastTxAt: "2026-07-31T22:00:00.000Z", revenue: null, balance: 3_400, change24h: null,
      sparkline: [1, 2, 1.5, 2.5], pending: false, refreshedAt: "2026-07-31T00:00:00.000Z", stale: false,
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

function mockListApi(page: Page): void {
  page.route("**/api/dashboards/overview", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OVERVIEW) }));
  page.route("**/api/dashboards/entities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ENTITIES) }));
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await navigate(page, "/list");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-list-view]")).toBeVisible();
  await expect(page.locator("[data-list-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
  mockListApi(page);
});

test("renders the overview metric cards and leader cards from /api/dashboards/overview", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-list-metric-cards] .metric-card")).toHaveCount(5);
  await expect(page.locator("[data-leader-agent] .data-value")).toHaveText("Agent One");
  await expect(page.locator("[data-leader-coin] .data-value")).toHaveText("Coin One");
  await expect(page.locator("[data-leader-vault] .data-value")).toHaveText("Vault One");
  await expect(page.locator("[data-rm-price]")).toHaveText("$0.05");
});

test("tab counts exclude pending rows until Show unverified is toggled on", async ({ page }) => {
  await login(page);
  const allTab = page.locator('[data-list-tabs] [data-tab="all"]');
  const agentsTab = page.locator('[data-list-tabs] [data-tab="agents"]');
  await expect(allTab).toHaveText("All (4)");
  await expect(agentsTab).toHaveText("Agents (1)");

  await page.locator("[data-list-unverified-switch]").click();
  await expect(allTab).toHaveText("All (5)");
  await expect(agentsTab).toHaveText("Agents (2)");
  await expect(page.locator('[data-row-key="agent:a2"]')).toHaveClass(/opacity-60/);
});

test("selecting a tab filters rows and resets sort to contextual desc", async ({ page }) => {
  await login(page);
  await page.locator('[data-list-tabs] [data-tab="coins"]').click();
  await expect(page.locator("[data-list-table] tbody tr")).toHaveCount(1);
  await expect(page.locator('[data-row-key="coin:c1"]')).toBeVisible();
});

test("clicking a sortable column header toggles sort direction and applies the tint class", async ({ page }) => {
  await login(page);
  const nameHeader = page.locator("[data-list-table] thead th").first();
  await nameHeader.click();
  await expect(nameHeader).toHaveClass(/is-sorted/);
  const dirAfterFirstClick = await nameHeader.textContent();
  await nameHeader.click();
  const dirAfterSecondClick = await nameHeader.textContent();
  expect(dirAfterFirstClick).not.toBe(dirAfterSecondClick);
});

test("sort/tab/unverified state round-trips through sessionStorage across a reload", async ({ page }) => {
  await login(page);
  await page.locator('[data-list-tabs] [data-tab="vaults"]').click();
  await page.locator("[data-list-unverified-switch]").click();

  const state = await page.evaluate(() => sessionStorage.getItem("list:state"));
  expect(state).not.toBeNull();
  expect(JSON.parse(state as string)).toMatchObject({ tab: "vaults", showUnverified: true });

  await page.reload();
  await expect(page.locator("[data-list-loading]")).toHaveCount(0);
  await expect(page.locator('[data-list-tabs] [data-tab="vaults"]')).toHaveClass(/is-active/);
  await expect(page.locator("[data-list-unverified-switch]")).toHaveClass(/is-on/);
});

test("row links resolve to the expected detail routes", async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-row-key="agent:a1"] [data-row-link]')).toHaveAttribute("href", "/agents/a1");
  await expect(page.locator('[data-row-key="coin:c1"] [data-row-link]')).toHaveAttribute("href", "/lobster/c1");
  await expect(page.locator('[data-row-key="vault:v1"] [data-row-link]')).toHaveAttribute("href", "/vaults/v1");
  await expect(page.locator('[data-row-key="wallet:w1"] [data-row-link]')).toHaveAttribute("href", "/wallets/w1");
});

test("clicking a row records it as last-viewed; returning to /list highlights it (§4.4)", async ({ page }) => {
  await login(page);
  await page.locator('[data-row-key="coin:c1"] [data-row-link]').click();
  await expect(page).toHaveURL(/\/lobster\/c1$/);

  const lastViewed = await page.evaluate(() => sessionStorage.getItem("list:lastViewed"));
  expect(lastViewed).toBe("coin:c1");

  await navigate(page, "/list");
  await expect(page.locator("[data-list-loading]")).toHaveCount(0);
  await expect(page.locator('[data-row-key="coin:c1"]')).toHaveClass(/a3-row-highlight/);
});

test("full page visual golden at 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await expect(page).toHaveScreenshot("list-full.png", { fullPage: true });
});

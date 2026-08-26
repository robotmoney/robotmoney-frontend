// Render + interaction tests for /agents — "OpenClaw Agents" (issue #385,
// docs/bot-analytics-ui-port-plan.md §5.7, P2.2). Same harness as
// dash-shell.spec.ts/list-view.spec.ts: vendor CDN scripts are served from
// node_modules, the gate's POST /api/admin/auth is mocked (its own wire
// contract is proven by admin-live.spec.ts), and GET /api/dashboards/agents
// is stubbed with a deterministic DTO so tab filtering, sorting, the
// sparkline metric selector, and summary math are all network-free and
// reproducible. Also captures the full-page visual golden (§7 pixel-QA
// method: Playwright's own committed baseline, 1% maxDiffPixelRatio from
// playwright.config.ts, NOT a diff against a foreign screenshot).
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

// a1's three sparkline series deliberately have DIFFERENT point counts (4 /
// 3 / 5) so switching the Sparkline metric selector visibly flips its 6M
// cell between a rendered line and the "< 4 points" empty state — a signal
// that doesn't depend on inspecting SVG path internals.
const AGENTS_RESPONSE = {
  agents: [
    {
      id: "a1", name: "Agent One", protocol: "x402", isFacilitator: false, active: true,
      score: 80, x402Txns: 12, x402VolumeUsd: 500, balanceUsd: 4_200, walletAddress: "0xabcdef0000000000000000000000000000beef",
      sparkline: { score: [10, 20, 30, 40], x402: [1, 2, 3], balance: [5, 6, 7, 8, 9] },
    },
    {
      id: "a2", name: "Agent Two", protocol: "olas", isFacilitator: false, active: false,
      score: 10, x402Txns: 0, x402VolumeUsd: 0, balanceUsd: null, walletAddress: null,
      sparkline: { score: [], x402: [], balance: [] },
    },
    {
      id: "f1", name: "Facilitator One", protocol: "facilitator", isFacilitator: true, active: true,
      score: 50, x402Txns: 5, x402VolumeUsd: 200, balanceUsd: 1_000, walletAddress: "0x1111111111111111111111111111111111aaaa",
      sparkline: { score: [1, 2, 3, 4], x402: [1, 1, 1, 1], balance: [1, 1, 1, 1] },
    },
  ],
  summary: { active: 2, idle: 1, x402Txns: 17, x402VolumeUsd: 700, totalBalanceUsd: 5_200 },
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

function mockAgentsApi(page: Page, body: unknown = AGENTS_RESPONSE): void {
  page.route("**/api/dashboards/agents", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await navigate(page, "/agents");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-agents-view]")).toBeVisible();
  await expect(page.locator("[data-agents-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

test("renders the summary strip from GET /api/dashboards/agents", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);
  await expect(page.locator("[data-agents-active-count]")).toHaveText("2");
  await expect(page.locator("[data-agents-idle-count]")).toHaveText("1");
  await expect(page.locator("[data-agents-x402-txns]")).toHaveText("17");
  await expect(page.locator("[data-agents-x402-vol]")).toHaveText("$700.00");
  await expect(page.locator("[data-agents-total-balance]")).toHaveText("$5.2K");
});

test("tabs count All/Agents/Facilitators and filter rows on click", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  await expect(page.locator('[data-agents-tabs] [data-tab="all"]')).toHaveText("All (3)");
  await expect(page.locator('[data-agents-tabs] [data-tab="agents"]')).toHaveText("Agents (2)");
  await expect(page.locator('[data-agents-tabs] [data-tab="facilitators"]')).toHaveText("Facilitators (1)");
  await expect(page.locator("[data-agents-table] tbody tr")).toHaveCount(3);

  await page.locator('[data-agents-tabs] [data-tab="facilitators"]').click();
  await expect(page.locator("[data-agents-table] tbody tr")).toHaveCount(1);
  await expect(page.locator('[data-row-key="f1"]')).toBeVisible();
});

test("default sort is composite score desc", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);
  const names = await page.locator("[data-agents-table] tbody tr [data-row-link]").allTextContents();
  expect(names).toEqual(["Agent One", "Facilitator One", "Agent Two"]); // scores 80, 50, 10
});

test("clicking a sortable column header toggles sort direction and applies the tint class", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);
  const nameHeader = page.locator("[data-agents-table] thead th").first();
  await nameHeader.click();
  await expect(nameHeader).toHaveClass(/is-sorted/);
  const namesAfterFirstClick = await page.locator("[data-agents-table] tbody tr [data-row-link]").allTextContents();
  await nameHeader.click();
  const namesAfterSecondClick = await page.locator("[data-agents-table] tbody tr [data-row-link]").allTextContents();
  expect(namesAfterFirstClick).not.toEqual(namesAfterSecondClick);
});

test("PROTOCOL and STATUS badges reflect the row's protocol and active flag", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);
  const row = page.locator('[data-row-key="a2"]');
  await expect(row.locator(".a3-badge").first()).toHaveText("OLAS");
  await expect(row.locator(".status-inactive")).toHaveText("Inactive");
  const activeRow = page.locator('[data-row-key="a1"]');
  await expect(activeRow.locator(".status-active")).toHaveText("Active");
});

test("switching the Sparkline metric selector changes which series each row's 6M column renders", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  const cell = page.locator('[data-row-key="a1"] td').last();
  // score has 4 points -> a rendered line, not the "< 4 points" empty marker.
  await expect(cell.locator(".a3-spark")).toHaveCount(1);
  await expect(cell.locator(".a3-spark-empty")).toHaveCount(0);

  await page.locator("[data-spark-select-trigger]").click();
  await page.locator('[data-spark-option="x402"]').click();
  await expect(page.locator("[data-spark-select-trigger]")).toContainText("x402 Vol");
  // x402 has only 3 points -> falls back to the empty marker.
  await expect(cell.locator(".a3-spark")).toHaveCount(0);
  await expect(cell.locator(".a3-spark-empty")).toHaveCount(1);

  await page.locator("[data-spark-select-trigger]").click();
  await page.locator('[data-spark-option="balance"]').click();
  await expect(page.locator("[data-spark-select-trigger]")).toContainText("Balance");
  // balance has 5 points -> a rendered line again.
  await expect(cell.locator(".a3-spark")).toHaveCount(1);
  await expect(cell.locator(".a3-spark-empty")).toHaveCount(0);
});

test("empty state renders when the backend returns no agents", async ({ page }) => {
  mockAgentsApi(page, { agents: [], summary: { active: 0, idle: 0, x402Txns: 0, x402VolumeUsd: 0, totalBalanceUsd: 0 } });
  await login(page);
  await expect(page.locator("[data-agents-empty]")).toBeVisible();
  await expect(page.locator("[data-agents-empty]")).toContainText("No agents tracked yet");
  await expect(page.locator("[data-agents-table]")).toHaveCount(0);
});

test("full page visual golden at 1440x900", async ({ page }) => {
  mockAgentsApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await expect(page).toHaveScreenshot("agents-full.png", { fullPage: true });
});

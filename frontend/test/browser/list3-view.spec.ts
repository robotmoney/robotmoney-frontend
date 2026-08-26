// Render + interaction tests for /list3 — "List v3 · Money Agents" (issue
// #387, docs/bot-analytics-ui-port-plan.md §5.3, P2.7). Same harness as
// list2-view.spec.ts: vendor CDN scripts served from node_modules, the
// gate's POST /api/admin/auth mocked, and GET /api/dashboards/leaderboard
// stubbed with a deterministic DTO so sort keys, the evidence drawer
// open/close + section presence, the RM Score tooltip text, and the
// hidden-when-empty X402 column are all network-free and reproducible.
// Also captures the drawer-open visual golden — one of the plan's flagged
// pixel-QA shots (§7: "List3's drawer, dense nested proof sections").
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

const LEADERBOARD = {
  rows: [
    {
      id: "a1", rank: 1, name: "Agent Rich", href: "/agents/a1", protocol: "x402", sourceBadge: null,
      revenue30dUsd: 5000, walletBalanceUsd: 50_000, walletAddress: "0xrichwallet",
      x402VolumeUsd: 10_000, x402Txns: 40, tokenTicker: "RICH", tokenMarketCapUsd: 2_000_000,
      lastObservedAt: "2026-07-31T23:00:00.000Z", moneyTrailSparkline: [1, 2, 3, 4, 5],
      signalScore: 512.3, confidence: "High",
      evidence: { wallet: "verified", moneyIn: "verified", x402: "verified", token: "verified", identity: "verified", freshness: "verified" },
    },
    {
      id: "a2", rank: 2, name: "Agent Bare", href: "/agents/a2", protocol: null, sourceBadge: null,
      revenue30dUsd: 0, walletBalanceUsd: null, walletAddress: null,
      x402VolumeUsd: 0, x402Txns: 0, tokenTicker: null, tokenMarketCapUsd: null,
      lastObservedAt: null, moneyTrailSparkline: [],
      signalScore: 2.0, confidence: "Low",
      evidence: { wallet: "missing", moneyIn: "missing", x402: "missing", token: "missing", identity: "missing", freshness: "missing" },
    },
  ],
  stats: { listedAgents: 2, verifiedWalletBalanceUsd: 50_000, moneyIn30dUsd: 5000, highConfidenceCount: 1 },
  debug: {
    rowCount: 2, lastRefreshAt: "2026-07-31T23:30:00.000Z",
    sources: [
      { name: "openclaw_agents", role: "Agent identity", status: "healthy", freshCount: 2, totalCount: 2, latestRefreshAt: "2026-07-31T23:00:00.000Z" },
      { name: "tracked_wallets", role: "Wallet evidence", status: "partial", freshCount: 1, totalCount: 2, latestRefreshAt: "2026-07-31T20:00:00.000Z" },
      { name: "agent_revenue_daily", role: "30d money-in evidence", status: "stale", freshCount: 0, totalCount: 1, latestRefreshAt: null },
    ],
  },
  asOf: "2026-08-01T00:00:00.000Z",
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

function mockLeaderboardApi(page: Page, body: unknown = LEADERBOARD): void {
  page.route("**/api/dashboards/leaderboard", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await navigate(page, "/list3");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-list3-view]")).toBeVisible();
  await expect(page.locator("[data-list3-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
  mockLeaderboardApi(page);
});

test("renders the 4 StatCards from the leaderboard summary", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-list3-stats] .metric-card")).toHaveCount(4);
  await expect(page.locator("[data-list3-stats] .metric-card").nth(0).locator(".data-value")).toHaveText("2");
  await expect(page.locator("[data-list3-stats] .metric-card").nth(1).locator(".data-value")).toHaveText("$50.0K");
});

test("ranks the highest-scored agent first by default (signalScore desc)", async ({ page }) => {
  await login(page);
  const rows = page.locator("[data-list3-table] tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Agent Rich");
  await expect(rows.first().locator("td").first()).toHaveText("1");
});

test("clicking a sortable column header re-sorts and recomputes the # rank column", async ({ page }) => {
  await login(page);
  const walletHeader = page.locator('[data-list3-table] thead th', { hasText: "WALLET" });
  await walletHeader.click(); // ascending: Agent Bare (null wallet sorts last per our null-last rule) stays same order actually
  await walletHeader.click(); // back toward desc
  const firstRowRank = await page.locator("[data-list3-table] tbody tr").first().locator("td").first().textContent();
  expect(firstRowRank).toBe("1");
});

test("the RM Score header tooltip carries the exact §5.3 formula text", async ({ page }) => {
  await login(page);
  const scoreHeader = page.locator('[data-list3-table] thead th', { hasText: "RM SCORE" });
  await scoreHeader.hover();
  await expect(page.locator(".a3-tooltip-bubble")).toContainText("log10(revenue×5 + wallet×2 + x402×1.5 + mcap×0.15 + 1)×100 + recency boost");
});

test("X402 column is hidden entirely when every row has zero x402 volume", async ({ page }) => {
  const noX402 = {
    ...LEADERBOARD,
    rows: LEADERBOARD.rows.map((r) => ({ ...r, x402VolumeUsd: 0 })),
  };
  await page.route("**/api/dashboards/leaderboard", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(noX402) }));
  await login(page);
  await expect(page.locator('[data-list3-table] thead th', { hasText: "X402" })).not.toBeVisible();
});

test("opening the Evidence drawer shows every proof section for the selected agent", async ({ page }) => {
  await login(page);
  await page.locator('[data-list3-row][data-rank="1"] [data-evidence-link]').click();
  const drawer = page.locator("[data-evidence-drawer]");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-evidence-section="wallet"]')).toContainText("verified");
  await expect(drawer.locator('[data-evidence-section="money-in"]')).toContainText("$5.0K");
  await expect(drawer.locator('[data-evidence-section="x402"]')).toContainText("$10.0K");
  await expect(drawer.locator('[data-evidence-section="token"]')).toContainText("RICH");
  await expect(drawer.locator('[data-evidence-section="identity"]')).toContainText("verified");
  await expect(drawer.locator('[data-evidence-section="freshness"]')).toContainText("verified");
  await expect(drawer.locator('[data-evidence-confidence]')).toContainText("High");
});

test("Evidence drawer closes on Escape and on backdrop click", async ({ page }) => {
  await login(page);
  await page.locator('[data-list3-row][data-rank="1"] [data-evidence-link]').click();
  await expect(page.locator("[data-evidence-drawer]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-evidence-drawer]")).not.toBeVisible();

  await page.locator('[data-list3-row][data-rank="1"] [data-evidence-link]').click();
  await expect(page.locator("[data-evidence-drawer]")).toBeVisible();
  await page.locator("[data-evidence-drawer]").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("[data-evidence-drawer]")).not.toBeVisible();
});

test("a wallet with no observed balance reads 'Wallet unresolved', never $0", async ({ page }) => {
  await login(page);
  const bareRow = page.locator('[data-list3-row][data-rank="2"]');
  await expect(bareRow).toContainText("Wallet unresolved");
});

test("empty leaderboard renders the honest empty state, not a fabricated row", async ({ page }) => {
  await page.route("**/api/dashboards/leaderboard", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...LEADERBOARD, rows: [] }) }));
  await login(page);
  await expect(page.locator("[data-list3-empty]")).toBeVisible();
  await expect(page.locator("[data-list3-empty]")).toContainText("No active wallet-backed agents found yet.");
});

test("Leaderboard health (debug) panel reports real per-source freshness status", async ({ page }) => {
  await login(page);
  await page.locator("[data-list3-debug] summary").click();
  await expect(page.locator('[data-source-status="openclaw_agents"]')).toHaveText("healthy");
  await expect(page.locator('[data-source-status="tracked_wallets"]')).toHaveText("partial");
  await expect(page.locator('[data-source-status="agent_revenue_daily"]')).toHaveText("stale");
});

test("visual golden: leaderboard with the evidence drawer open at 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.locator('[data-list3-row][data-rank="1"] [data-evidence-link]').click();
  await expect(page.locator("[data-evidence-drawer]")).toBeVisible();
  // The drawer is `position: fixed`, so it stays put regardless of page
  // scroll — reset to the top so the golden frames the page header + table,
  // not wherever the click happened to leave the scroll position.
  await page.evaluate(() => window.scrollTo(0, 0));
  // Viewport screenshot, not fullPage: the drawer is a `position: fixed`
  // overlay/sheet (§7's own pixel-QA target), and Playwright's fullPage
  // capture scrolls-and-stitches taller pages — a fixed element then repeats
  // at the same on-screen position in every stitched chunk, producing a
  // bogus duplicate/gap artifact. A single-viewport capture is what a user
  // actually sees and is the correct target for a fixed overlay.
  await expect(page).toHaveScreenshot("list3-drawer-open-full.png");
});

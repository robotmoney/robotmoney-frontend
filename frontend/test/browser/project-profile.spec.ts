// Render + interaction tests for /projects/:slug — ProjectProfile "dossier"
// (issue #389, docs/bot-analytics-ui-port-plan.md §5.5, P3.1). Same harness
// as submit-view.spec.ts — no gate mock needed, `/projects/:slug` is the one
// PARAM route routes.js marks `gated: false` (§5.5's own "— public" callout).
// GET /api/projects/:slug is stubbed with a deterministic DTO so the hero,
// KPI strip, all four facet tables, the 90d history charts, ratio tiles, and
// the not-found path are all network-free and reproducible. Also captures
// the full-page visual golden (§7 pixel-QA method: Playwright's own
// committed baseline, 1% maxDiffPixelRatio from playwright.config.ts, NOT a
// diff against a foreign screenshot — same convention agents-view.spec.ts/
// list-view.spec.ts/dashboard-view.spec.ts already established for every
// dash view, not only the 7 cross-reference-design shots §7 separately
// designates for the future dash-visual.spec.ts sweep).
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const SLUG = "dossier-co";

const PROJECT_DETAIL = {
  project: {
    id: "p1",
    slug: SLUG,
    displayName: "Dossier Co",
    logoUrl: null,
    overviewShort: "A test agentic-economy project.",
    overviewLong: "Long-form overview of Dossier Co's operations and revenue model.",
    websiteUrl: "https://dossier.example/",
    twitterHandle: "@dossierco",
    primaryChain: "base",
    dataCoverageScore: 82,
    breadthScore: 100,
    identityScore: 100,
    onchainScore: 70,
    activityScore: 60,
    coverageCalculatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    isSticky: false,
    facets: { agent: true, x402: true, coin: true, wallet: true, vault: true },
    sparkline: [1.1, 1.2, 1.15, 1.3, 1.25],
    kpis: {
      marketCapUsd: 5_000_000,
      fdvUsd: 8_000_000,
      revenue30dUsd: 45_000,
      psRatioAnnualized: 3.33,
      walletBalanceUsd: 120_000,
      walletCount: 2,
      vaultTvlUsd: 300_000,
      vaultWeightedApy: 6.5,
      x402VolumeUsd: 90_000,
      x402TxnCount: 410,
    },
    ratios: {
      psRatioAnnualized: 3.33,
      fdvToMarketCap: 1.6,
      tvlToMarketCap: 0.06,
      revenueGrowthPct: 12.5,
      capitalEfficiency: 0.11,
    },
    agents: [
      {
        id: "a1", name: "Dossier Agent", href: "/agents/a1", protocolStandard: "x402",
        isActive: true, x402Score: 71.2, x402TxnCount: 410, x402VolumeUsd: 90_000,
        revenue30dUsd: 45_000, productivityScore: 58,
      },
    ],
    coins: [
      {
        id: "c1", ticker: "DSR", name: "Dossier Coin", marketCap: 5_000_000, fdv: 8_000_000,
        percentChange24h: 3.2, priceUsd: 1.25, volume24h: 12_000, refreshedAt: null, stale: true,
        chain: "base", sparkline90d: [1, 1.05, 1.1, 1.2, 1.25],
      },
    ],
    wallets: [
      {
        id: "w1", label: "Dossier Treasury", chain: "base", balanceUsd: 120_000,
        refreshedAt: null, stale: true, address: "0x1111111111111111111111111111111111aaaa",
        lastTxAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    ],
    vaults: [
      {
        id: "v1", name: "Dossier Vault", protocol: "morpho", chain: "base", strategyType: "erc4626",
        tvlUsd: 300_000, yieldApy: 6.5, vaultAddress: "0x2222222222222222222222222222222222bbbb",
        refreshedAt: null, stale: true,
      },
    ],
    history: [
      { date: "2026-07-29", tokenPriceUsd: 1.2, marketCapUsd: 4_800_000, dailyRevenueUsd: 1_500, treasuryUsd: 415_000, avgProductivity: 55 },
      { date: "2026-07-30", tokenPriceUsd: 1.25, marketCapUsd: 5_000_000, dailyRevenueUsd: 1_800, treasuryUsd: 420_000, avgProductivity: 58 },
    ],
    activity: [
      { id: "e1", occurredAt: new Date(Date.now() - 3_600_000).toISOString(), agentId: "a1", agentName: "Dossier Agent", agentHref: "/agents/a1", actionType: "commit", status: "success", commitSummary: "Rebalanced treasury." },
    ],
  },
};

function mockProjectDetail(page: Page, body: unknown = PROJECT_DETAIL, status = 200): void {
  page.route(/\/api\/projects\/[^/]+$/, (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
});

test("renders ungated, with hero fields, facet pills, and coverage score bars", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-project-profile-view]")).toBeVisible();
  await expect(page.locator("[data-profile-loading]")).toHaveCount(0);

  await expect(page.locator("[data-profile-name]")).toHaveText("Dossier Co");
  await expect(page.locator("[data-profile-overview-short]")).toHaveText("A test agentic-economy project.");
  await expect(page.locator("[data-profile-facet-pills] .a3-badge")).toHaveCount(5); // agent/coin/wallet/vault + chain
  await expect(page.locator("[data-profile-score-value]")).toHaveText("82");
  await expect(page.locator('[data-scorebar="breadthScore"]')).toContainText("100");
});

test("renders all four facet tables with the correct row counts", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();

  await expect(page.locator("[data-profile-agents-table] tbody tr")).toHaveCount(1);
  await expect(page.locator("[data-profile-coins-table] tbody tr")).toHaveCount(1);
  await expect(page.locator("[data-profile-wallets-table] tbody tr")).toHaveCount(1);
  await expect(page.locator("[data-profile-vaults-table] tbody tr")).toHaveCount(1);

  await expect(page.locator("[data-profile-agent-row] a").first()).toHaveText("Dossier Agent");
  await expect(page.locator("[data-profile-coin-row] a").first()).toContainText("DSR");
  await expect(page.locator("[data-profile-wallet-row]").first()).toContainText("0x1111…aaaa");
  await expect(page.locator("[data-profile-vault-row]").first()).toContainText("Dossier Vault");
});

test("renders the KPI strip and ratio tiles from the DTO", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();

  await expect(page.locator('[data-kpi="marketCap"] .data-value')).toHaveText("$5.00M");
  await expect(page.locator('[data-kpi="revenue30d"] .data-value')).toHaveText("$45.0K");
  await expect(page.locator('[data-kpi="ps"] .data-value')).toHaveText("3.33×");
  await expect(page.locator('[data-kpi="walletBalance"] .data-value')).toHaveText("$120.0K");
  await expect(page.locator('[data-kpi="vaultTvl"] .data-value')).toHaveText("$300.0K");
  await expect(page.locator('[data-ratio="fdvMcap"] .data-value')).toHaveText("1.60×");
  await expect(page.locator('[data-ratio="revGrowth"] .data-value')).toHaveText("+12.5%");
});

test("renders the activity feed row when the DTO carries entries", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();

  await expect(page.locator("[data-profile-activity-section]")).toBeVisible();
  await expect(page.locator("[data-profile-activity-row]")).toHaveCount(1);
  await expect(page.locator("[data-profile-activity-row]")).toContainText("Rebalanced treasury.");
});

test("activity section stays hidden when the DTO carries no entries (P1.6 honesty contract)", async ({ page }) => {
  mockProjectDetail(page, { project: { ...PROJECT_DETAIL.project, activity: [] } });
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();

  await expect(page.locator("[data-profile-activity-section]")).not.toBeVisible();
});

test("renders history charts when the DTO carries a non-empty series, not the empty-state message", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();

  await expect(page.locator("[data-profile-history-empty]")).toHaveCount(0);
  await expect(page.locator('[data-chart-card="tokenPriceUsd"] canvas')).toBeVisible();
  await expect(page.locator('[data-chart-card="marketCapUsd"] canvas')).toBeVisible();
});

test("renders 'Not enough history yet.' when the DTO's history series is empty", async ({ page }) => {
  mockProjectDetail(page, { project: { ...PROJECT_DETAIL.project, history: [] } });
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();

  await expect(page.locator("[data-profile-history-empty]")).toHaveText("Not enough history yet.");
});

test("renders 'Project not found.' on a 404 from the backend", async ({ page }) => {
  mockProjectDetail(page, { error: "project not found" }, 404);
  await page.goto("/");
  await navigate(page, `/projects/unknown-slug-xyz`);

  await expect(page.locator("[data-profile-not-found]")).toHaveText("Project not found.");
  await expect(page.locator("[data-profile-content]")).toHaveCount(0);
});

test("full page visual golden at 1440x900", async ({ page }) => {
  mockProjectDetail(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("[data-profile-name]")).toBeVisible();
  await expect(page.locator('[data-chart-card="tokenPriceUsd"] canvas')).toBeVisible();
  await expect(page).toHaveScreenshot("project-profile-full.png", { fullPage: true });
});

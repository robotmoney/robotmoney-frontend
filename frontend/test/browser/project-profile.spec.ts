// Render tests for a project's page, /projects/:slug (RM-186). Public, with
// no dashboard layout. GET /api/projects/:slug is stubbed with a
// deterministic DTO, so the facts, the four tables, the market cap chart,
// what the page must leave out, the indexing rule and the not-found path are
// all network-free.
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
    overviewLong: "![Upload](https://example.com/x.png)\n\n## **Long-form** overview of Dossier Co.",
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
      marketCapUsd: 5_000_000, fdvUsd: 8_000_000, revenue30dUsd: 45_000, psRatioAnnualized: 3.33,
      walletBalanceUsd: 120_000, walletCount: 2, vaultTvlUsd: 300_000, vaultWeightedApy: 6.5,
      x402VolumeUsd: 90_000, x402TxnCount: 410,
    },
    ratios: { psRatioAnnualized: 3.33, fdvToMarketCap: 1.6, tvlToMarketCap: 0.06, revenueGrowthPct: 12.5, capitalEfficiency: 0.11 },
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
        percentChange24h: 3.2, priceUsd: 1.25, volume24h: 12_000, refreshedAt: "2026-10-20T14:10:00Z", stale: false,
        chain: "base", sparkline90d: [1, 1.05, 1.1, 1.2, 1.25],
      },
    ],
    wallets: [
      {
        id: "w1", label: "Dossier Treasury", chain: "base", balanceUsd: 120_000,
        refreshedAt: null, stale: true, address: "0x1111111111111111111111111111111111aaaa",
        lastTxAt: "2026-10-18T09:00:00Z",
      },
      {
        id: "w2", label: "Dossier peaq", chain: "peaq", balanceUsd: null,
        refreshedAt: null, stale: true, address: "0x3333333333333333333333333333333333cccc", lastTxAt: null,
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
      { date: "2026-10-17", tokenPriceUsd: 1.2, marketCapUsd: 4_800_000, dailyRevenueUsd: null, treasuryUsd: 415_000, avgProductivity: 0 },
      { date: "2026-10-18", tokenPriceUsd: 1.22, marketCapUsd: 4_900_000, dailyRevenueUsd: null, treasuryUsd: 418_000, avgProductivity: 0 },
      { date: "2026-10-19", tokenPriceUsd: 1.25, marketCapUsd: 5_000_000, dailyRevenueUsd: null, treasuryUsd: 420_000, avgProductivity: 0 },
    ],
    activity: [],
  },
};

function mockProjectDetail(page: Page, body: unknown = PROJECT_DETAIL, status = 200): void {
  page.route(/\/api\/projects\/[^/]+$/, (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
});

test("renders publicly, outside the dashboards, as a record", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator("[data-dash-gate]")).toHaveCount(0);
  await expect(page.locator(".a3-sidebar, [data-dash-sidebar]")).toHaveCount(0);
  await expect(page.locator(".rr-crumbs a[href='/projects']")).toBeVisible();
  await expect(page.locator("h1.sv__detail-title")).toHaveText("Dossier Co");
  await expect(page.locator(".rm-named .rm-role")).toHaveText("x402 service");
  await expect(page.locator(".rr-links a[href='https://dossier.example/']")).toBeVisible();
  await expect(page.locator(".rr-links a[href='https://x.com/dossierco']")).toHaveText("@dossierco");

  const meta = page.locator(".rr-meta").first();
  await expect(meta).toContainText("DSR price $1.25");
  await expect(meta).toContainText("+3.2%");
  await expect(meta).toContainText("Market cap $5.00M");
  await expect(meta).toContainText("FDV $8.00M");
  await expect(meta).toContainText("Volume 24h $12.0K");
});

test("a project we have not written up quotes its listing, cleaned, and is not indexed", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator(".pjp__listing")).toHaveText("Long-form overview of Dossier Co.");
  await expect(page.locator("#about .rr-note")).toHaveText("From the project's own listing.");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  await expect(page).toHaveTitle("Dossier Co | Agent Projects | Robot Money");
});

test("renders the token, agent, wallet and vault tables", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("h1.sv__detail-title")).toBeVisible();

  const coin = page.locator(".pjp__coins tbody tr");
  await expect(coin).toHaveCount(1);
  await expect(coin).toContainText("DSR");
  await expect(coin).toContainText("Dossier Coin");
  await expect(coin).toContainText("$5.00M");
  await expect(page.locator("#token .rr-note")).toContainText("As of Oct 20, 2026.");

  // Agents are named, not linked: their pages are behind the dashboards' gate.
  await expect(page.locator(".pjp__agents tbody tr")).toHaveCount(1);
  await expect(page.locator(".pjp__agents tbody a")).toHaveCount(0);
  await expect(page.locator(".pjp__agents tbody tr")).toContainText("Active");

  const wallets = page.locator(".pjp__wallets tbody tr");
  await expect(wallets).toHaveCount(2);
  await expect(page.locator(".pjp__wallets thead")).toContainText("ETH held");
  await expect(wallets.first().locator("a.rr-lnk")).toHaveAttribute("href", "https://basescan.org/address/0x1111111111111111111111111111111111aaaa");
  await expect(wallets.first()).toContainText("$120,000");
  await expect(wallets.nth(1)).toContainText("peaq");
  await expect(wallets.nth(1).locator("a")).toHaveCount(0);

  await expect(page.locator(".pjp__vaults tbody tr")).toContainText("$300.0K");
});

// RM-180's audit: a figure the data cannot back reads "Missing", with why,
// never a wrong number or a zero that means "not read".
test("shows Missing where the data cannot back a figure, and the rest as read", async ({ page }) => {
  const unread = structuredClone(PROJECT_DETAIL);
  Object.assign(unread.project.kpis, { revenue30dUsd: 0, psRatioAnnualized: null, x402VolumeUsd: 0, x402TxnCount: 0, vaultWeightedApy: 0 });
  Object.assign(unread.project.ratios, { psRatioAnnualized: null, revenueGrowthPct: null, capitalEfficiency: null });
  Object.assign(unread.project.agents[0], { x402Score: 0, x402TxnCount: 0, revenue30dUsd: 0, productivityScore: 0 });
  unread.project.vaults[0].yieldApy = 0;
  mockProjectDetail(page, unread);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator("h1.sv__detail-title")).toBeVisible();

  const fig = (label: string) => page.locator(".pjp__figs > div", { hasText: label }).locator("dd");
  for (const label of ["Revenue, 30 days", "Price to sales", "Revenue growth", "Capital efficiency", "Wallet balance", "Vault yield", "x402 volume", "x402 transactions"]) {
    await expect(fig(label), label).toHaveText("Missing");
  }
  await expect(fig("Wallet balance").locator(".rm-missing")).toHaveAttribute("title", /ETH only/);
  await expect(fig("Vault TVL")).toHaveText("$300.0K");
  await expect(fig("FDV to market cap")).toHaveText("1.60×");

  // Every agent figure, each wallet's balance and last transaction, the
  // vault's yield, and a token's liquidity and other chains.
  await expect(page.locator(".pjp__agents tbody .rm-missing")).toHaveCount(4);
  const wallet = page.locator(".pjp__wallets tbody tr").first();
  await expect(wallet).toContainText("$120,000");
  await expect(wallet.locator(".rm-missing")).toHaveCount(2);
  await expect(wallet).not.toContainText("Oct 18");
  await expect(page.locator(".pjp__vaults tbody .rm-missing")).toHaveCount(1);
  await expect(page.locator(".pjp__coins tbody .rm-missing")).toHaveCount(2);
  await expect(page.locator(".pjp__coins tbody .pjp__trend svg")).toHaveCount(1);

  // Revenue and the treasury have no history to draw: the chart says so.
  await page.locator(".pjp__chart .rm-chip", { hasText: "Daily revenue" }).click();
  await expect(page.locator(".pjp__chart .rm-nodata__h")).toHaveText("Missing");
  await page.locator(".pjp__chart .rm-chip", { hasText: "Treasury" }).click();
  await expect(page.locator(".pjp__chart .rm-nodata__d")).toContainText("ETH only");

  await expect(page.locator("#activity .rm-missing")).toHaveText("Missing");
});

test("shows the coverage score, its parts and what the project covers", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator("#coverage .rr-stat__v")).toHaveText("82");
  await expect(page.locator(".pjp__scores > div", { hasText: "Onchain" }).locator("b")).toHaveText("70");
  await expect(page.locator(".pjp__facets li.is-on")).toHaveCount(5);
});

test("a figure that was read shows its value", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  const fig = (label: string) => page.locator(".pjp__figs > div", { hasText: label }).locator("dd");
  await expect(fig("Revenue, 30 days")).toHaveText("$45.0K");
  await expect(fig("x402 transactions")).toHaveText("410");
  await expect(page.locator(".pjp__agents tbody tr")).toContainText("71.2");
});

test("draws the market cap a day at a time", async ({ page }) => {
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator(".pjp__chart .rr-area__plot")).toHaveAttribute("aria-label", /DSR market cap, Oct 17, 2026 to Oct 19, 2026/);
  await expect(page.locator(".pjp__chart .rr-area__pt")).toHaveCount(3);
});

test("one reading of market cap is the empty chart, saying so", async ({ page }) => {
  const one = structuredClone(PROJECT_DETAIL);
  one.project.history = one.project.history.slice(0, 1);
  mockProjectDetail(page, one);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator(".pjp__chart .rm-nodata__h")).toHaveText("Not enough data yet");
});

test("a project with no token shows no token section and counts its agents and wallets", async ({ page }) => {
  const tokenless = structuredClone(PROJECT_DETAIL);
  tokenless.project.coins = [];
  tokenless.project.vaults = [];
  mockProjectDetail(page, tokenless);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);

  await expect(page.locator("#token")).toHaveCount(0);
  await expect(page.locator(".rr-meta").first()).toContainText("Agents 1");
  await expect(page.locator(".rr-meta").first()).toContainText("Wallets 2");
});

test("a phone reads the page without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  mockProjectDetail(page);
  await page.goto("/");
  await navigate(page, `/projects/${SLUG}`);
  await expect(page.locator(".pjp__wallets")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const t of [".pjp__coins", ".pjp__agents", ".pjp__wallets", ".pjp__vaults"]) {
    const fits = await page.locator(t).evaluate((el) => el.scrollWidth <= (el.parentElement as HTMLElement).clientWidth);
    expect(fits, `${t} fits its column`).toBe(true);
  }
});

test("a missing project says so and offers the directory", async ({ page }) => {
  mockProjectDetail(page, { error: "project not found" }, 404);
  await page.goto("/");
  await navigate(page, `/projects/unknown-slug-xyz`);

  await expect(page.locator(".rr-missing h1")).toHaveText("Project not found");
  await expect(page.locator(".rr-missing a.rr-cta[href='/projects']")).toBeVisible();
  await expect(page.locator(".rr-missing button.rr-cta")).toHaveCount(0);
});

// A project we have written up (lib/project-copy.js): indexed under its own
// name, our description in place of its listing, and our links in place of
// the roster's where those point at the wrong place.
test("a project we have written up is indexed, with our copy and links", async ({ page }) => {
  const bankr = structuredClone(PROJECT_DETAIL);
  bankr.project.slug = "bankr-agent-614b56";
  bankr.project.displayName = "Bankr Agent";
  bankr.project.websiteUrl = "https://www.bankr.xyz";
  bankr.project.twitterHandle = "BankrAgent";
  mockProjectDetail(page, bankr);
  await page.goto("/");
  await navigate(page, "/projects/bankr-agent-614b56");

  await expect(page.locator("h1.sv__detail-title")).toHaveText("Bankr");
  await expect(page.locator(".rr-head .sv__lede")).toContainText("cross-chain wallet");
  await expect(page.locator(".pjp__about")).toContainText("deployed through Clanker");
  await expect(page.locator(".pjp__listing")).toHaveCount(0);
  await expect(page.locator(".rr-links a").first()).toHaveAttribute("href", "https://bankr.bot");
  await expect(page.locator(".rr-links a").nth(1)).toHaveText("@bankrbot");

  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow, max-image-preview:large, max-snippet:-1");
  await expect(page).toHaveTitle("Bankr | Agent Projects | Robot Money");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /^AI agent and infrastructure/);
});

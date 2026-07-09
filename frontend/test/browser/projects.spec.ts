// Render + interaction tests for the ported /projects directory (issue #70).
// Same harness as analytics-views.spec.ts: the SPA + view HTML are served by the
// backend at baseURL, vendor CDN scripts are fulfilled from node_modules, and the
// /api/projects response is STUBBED with a deterministic DTO so the assertions are
// network-free. We verify routing to /projects, table row rendering with the a2
// tokens, facet pills, the inline sparkline, and interactive column sorting.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

// Deterministic /api/projects payload (matches the @robotmoney/contract Project DTO
// the projectsView() factory consumes). Alpha leads on the default fdv-desc sort;
// Zeta has the higher 30d revenue; Sticky is pinned first on load despite 0 mcap.
const PROJECTS = {
  projects: [
    {
      id: "p-sticky", slug: "sticky", displayName: "Sticky Co", logoUrl: null,
      description: "pinned on first load", websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: true,
      facets: { agent: true, x402: false, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0, revenue30d: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [],
    },
    {
      id: "p-alpha", slug: "alpha", displayName: "Alpha Labs",
      logoUrl: null, description: "alpha blurb",
      websiteUrl: "https://alpha.example/", twitterHandle: "@alpha",
      dataCoverageScore: 92, isSticky: false,
      facets: { agent: true, x402: true, coin: true, wallet: true, vault: true },
      coins: [{ id: "c-alp", ticker: "ALP", name: "Alpha", marketCap: 12_000_000, fdv: 40_000_000, percentChange24h: 4.2, priceUsd: 1.5, volume24h: 800_000 }],
      wallets: [{ id: "w1", label: "Treasury", chain: "base", balanceUsd: 1500 }],
      walletTotalUsd: 1500, revenue30d: 350,
      maxMarketCap: 12_000_000, maxFdv: 40_000_000, sparkline: [1.0, 1.1, 1.3, 1.5],
      volume24h: 800_000, tvlUsd: 1_000_000,
    },
    {
      id: "p-zeta", slug: "zeta", displayName: "Zeta Systems",
      logoUrl: null, description: "zeta blurb",
      websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 70, isSticky: false,
      facets: { agent: false, x402: false, coin: true, wallet: false, vault: false },
      coins: [{ id: "c-zet", ticker: "ZET", name: "Zeta", marketCap: 3_000_000, fdv: 6_000_000, percentChange24h: -2.1 }],
      wallets: [], walletTotalUsd: 0, revenue30d: 9000,
      maxMarketCap: 3_000_000, maxFdv: 6_000_000, sparkline: [2.0, 1.8, 1.6],
    },
  ],
};

async function stubEnvironment(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  await page.route("**/api/projects*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PROJECTS) }));
}

async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

const rowNames = (page: Page) => page.locator(".pj-table tbody tr .pj-name__text");

test("routes to /projects and renders the directory table with a2 tokens", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  // Header + a2 gradient token.
  await expect(page.locator(".pj-title")).toContainText("Agentic Economy");
  await expect(page.locator(".pj-title .a2-grad")).toBeVisible();

  // Data present → the "No projects yet." empty state must not be shown (issue #87).
  await expect(page.locator(".pj-status", { hasText: "No projects yet" })).toBeHidden();

  // One row per project in the stub.
  await expect(page.locator(".pj-table tbody tr")).toHaveCount(3);

  // Alpha's row surfaces its aggregated numbers — every metric comes from the
  // /api/projects DTO the pipelines populate (market cap, 24h change, revenue).
  const alpha = page.locator(".pj-table tbody tr", { hasText: "Alpha Labs" });
  await expect(alpha).toContainText("$12.00M"); // max market cap
  await expect(alpha).toContainText("$40.00M"); // max fdv
  await expect(alpha).toContainText("+4.20%");  // 24h change
  await expect(alpha).toContainText("$350");    // trailing-30d revenue
  await expect(alpha.locator(".pj-link", { hasText: "alpha.example" })).toBeVisible();
  await expect(alpha.locator(".pj-link", { hasText: "@alpha" })).toBeVisible();

  // Facet pills: all five present, all lit for Alpha.
  const alphaPills = alpha.locator(".pj-pill");
  await expect(alphaPills).toHaveCount(5);
  await expect(alpha.locator(".pj-pill--on")).toHaveCount(5);

  // Inline sparkline SVG renders for a project with a price series.
  await expect(alpha.locator("svg.pj-spark")).toBeVisible();
});

test("sticky project pins first on load; clicking a header re-sorts and releases the pin", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await expect(rowNames(page)).toHaveCount(3);
  // First load: sticky pinned first, then market cap desc (Alpha > Zeta).
  await expect(rowNames(page)).toHaveText(["Sticky Co", "Alpha Labs", "Zeta Systems"]);

  // Sort by Revenue 30d desc → Zeta (9000) leads, sticky pin released.
  await page.locator(".pj-table thead .pj-sort", { hasText: "Revenue 30d" }).click();
  await expect(rowNames(page)).toHaveText(["Zeta Systems", "Alpha Labs", "Sticky Co"]);

  // Toggle to ascending → order reverses.
  await page.locator(".pj-table thead .pj-sort", { hasText: "Revenue 30d" }).click();
  await expect(rowNames(page)).toHaveText(["Sticky Co", "Alpha Labs", "Zeta Systems"]);
});

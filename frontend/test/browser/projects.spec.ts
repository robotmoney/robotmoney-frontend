// Render + interaction tests for the /projects directory (RM-186). The SPA
// and view HTML are served at baseURL, vendor CDN scripts are fulfilled from
// node_modules, and /api/projects is STUBBED with a deterministic DTO, so the
// assertions are network-free. Covered: the two lists (projects with a token,
// as a sortable table; every other project by name), the figures each row
// carries and the ones it must not, links to the project pages, the nav and
// the robots directive, and a phone that never scrolls sideways.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_COPY } from "../../public/assets/js/app/lib/project-copy.js";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

// Deterministic /api/projects payload (the @robotmoney/contract Project DTO).
// Alpha leads on market cap; Zeta's price is unknown; three projects have no
// token, two of them x402 services.
const PROJECTS = {
  projects: [
    {
      id: "p-sticky", slug: "sticky", displayName: "Sticky Co", logoUrl: null,
      description: "Discovered from Virtuals Protocol (STK)", websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: true,
      facets: { agent: true, x402: false, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [], tvlUsd: 0,
    },
    {
      id: "p-alpha", slug: "alpha", displayName: "Alpha Labs",
      logoUrl: null, description: "alpha blurb",
      websiteUrl: "https://alpha.example/", twitterHandle: "@alpha",
      dataCoverageScore: 92, isSticky: false,
      facets: { agent: true, x402: true, coin: true, wallet: true, vault: true },
      coins: [{ id: "c-alp", ticker: "ALP", name: "Alpha", marketCap: 12_000_000, fdv: 40_000_000, percentChange24h: 4.2, priceUsd: 1.5, volume24h: 800_000, refreshedAt: "2026-10-20T14:10:00Z", stale: false }],
      wallets: [{ id: "w1", label: "Treasury", chain: "base", balanceUsd: 1500, refreshedAt: null, stale: true }],
      walletTotalUsd: 1500,
      maxMarketCap: 12_000_000, maxFdv: 40_000_000, sparkline: [1.0, 1.1, 1.3, 1.5], tvlUsd: 1_000_000,
    },
    {
      id: "p-zeta", slug: "zeta", displayName: "Zeta Systems",
      logoUrl: null, description: "zeta blurb",
      websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 70, isSticky: false,
      facets: { agent: false, x402: false, coin: true, wallet: true, vault: false },
      coins: [{ id: "c-zet", ticker: "ZET", name: "Zeta", marketCap: 3_000_000, fdv: 6_000_000, percentChange24h: -2.1, priceUsd: null, volume24h: null, refreshedAt: null, stale: true }],
      wallets: [{ id: "w-zet", label: "Zeta Treasury", chain: "base", balanceUsd: 9000, refreshedAt: null, stale: true }],
      walletTotalUsd: 9000,
      maxMarketCap: 3_000_000, maxFdv: 6_000_000, sparkline: [2.0, 1.8, 1.6], tvlUsd: 0,
    },
    {
      id: "p-tokenless-active", slug: "tokenless-active", displayName: "Tokenless Active",
      logoUrl: null, description: "x402 with activity",
      websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: false,
      facets: { agent: true, x402: true, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [100, 200, 300], tvlUsd: 0,
    },
    {
      id: "p-tokenless-empty", slug: "tokenless-empty", displayName: "Tokenless Empty",
      logoUrl: null, description: "x402 no activity",
      websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: false,
      facets: { agent: true, x402: true, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [], tvlUsd: 0,
    },
  ],
};

async function stubEnvironment(page: Page) {
  await mockVendorScripts(page);
  await page.route("**/api/projects*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PROJECTS) }));
}

const tokenRows = (page: Page) => page.locator(".pjd__tokens tbody tr");
const tokenNames = (page: Page) => page.locator(".pjd__tokens tbody th .pjd__lnk");

test("renders the directory: projects with a token, then every other project", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await expect(page.locator(".a2-hero__title")).toHaveText("Agent Projects");
  const meta = page.locator(".pjd__meta");
  await expect(meta).toContainText("Projects 5");
  await expect(meta).toContainText("With a token 2");
  await expect(meta).toContainText("x402 services 3");
  await expect(meta).toContainText("Oct 20, 14:10 UTC");

  // Market cap, largest first.
  await expect(tokenRows(page)).toHaveCount(2);
  await expect(tokenNames(page)).toHaveText(["Alpha Labs", "Zeta Systems"]);
  const alpha = tokenRows(page).filter({ hasText: "Alpha Labs" });
  await expect(alpha).toContainText("ALP");
  await expect(alpha).toContainText("$1.5");
  await expect(alpha).toContainText("+4.2%");
  await expect(alpha).toContainText("$12.00M");
  await expect(alpha).toContainText("$40.00M");
  await expect(alpha).toContainText("30.0%"); // MC/FDV
  await expect(alpha).toContainText("92"); // coverage
  await expect(alpha.locator(".pjd__facets")).toHaveText("Agent · x402 · Token · Wallet · Vault");
  await expect(alpha.locator(".pjd__trend svg")).toHaveCount(1);
  await expect(alpha.locator(".alp__mv")).toHaveClass(/\bup\b/);
  await expect(tokenRows(page).filter({ hasText: "Zeta Systems" }).locator(".alp__mv")).toHaveText("−2.1%");
  await expect(page.locator(".pjd")).not.toContainText("Development data");

  // The rest, by name, an x402 service saying so and a scraped "Discovered
  // from" line never shown.
  const others = page.locator(".pjd__others tbody tr");
  await expect(others).toHaveCount(3);
  await expect(others.locator(".pjd__lnk")).toHaveText(["Sticky Co", "Tokenless Active", "Tokenless Empty"]);
  await expect(others.filter({ hasText: "Tokenless Active" })).toContainText("x402 service");
  await expect(others.filter({ hasText: "Tokenless Active" }).locator(".pjd__trend svg")).toHaveCount(1);
  await expect(page.locator(".pjd")).not.toContainText("Discovered from");
});

// A figure the data cannot back reads "Missing", with why, never a wrong
// number: the wallet balance counts ETH only, and a trend needs two readings.
test("shows Missing where the data cannot back a figure", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  const alpha = tokenRows(page).filter({ hasText: "Alpha Labs" });
  const wallet = alpha.locator(".rm-missing");
  await expect(wallet).toHaveText("Missing");
  await expect(wallet).toHaveAttribute("title", /ETH only/);
  await expect(alpha).toContainText("1 wallet");
  await expect(alpha).not.toContainText("$1.5K");

  // No wallets is "—", not Missing; no trend is Missing.
  const empty = page.locator(".pjd__others tbody tr").filter({ hasText: "Tokenless Empty" });
  await expect(empty.locator(".pjd__trend .rm-missing")).toHaveAttribute("title", /two daily readings/);
  await expect(empty.locator("td").nth(1)).toContainText("—");
});

test("the agents and services table pages and searches", async ({ page }) => {
  const many = structuredClone(PROJECTS);
  for (let i = 0; i < 60; i++) {
    many.projects.push({ ...structuredClone(PROJECTS.projects[0]), id: `p-n${i}`, slug: `n${i}`, displayName: `Agent ${String(i).padStart(2, "0")}`, isSticky: false });
  }
  await mockVendorScripts(page);
  await page.route("**/api/projects*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(many) }));
  await page.goto("/");
  await navigate(page, "/projects");

  const rows = page.locator(".pjd__others tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(page.locator(".rr-pager [role=status]")).toHaveText("1 to 50 of 63");
  await page.locator(".rr-pager button", { hasText: "Next" }).click();
  await expect(rows).toHaveCount(13);
  await expect(page.locator(".rr-pager [role=status]")).toHaveText("51 to 63 of 63");

  await page.locator("#others-q").fill("tokenless");
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".rr-pager")).toHaveCount(0);
  await page.locator("#others-q").fill("nothing like it");
  await expect(rows).toHaveText(["No project matches"]);
});

test("a column heading sorts the table and says which way", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  const mcap = page.locator(".pjd__tokens thead th.pjd__mc");
  await expect(mcap).toHaveAttribute("aria-sort", "descending");
  await mcap.locator(".rr-sort").click();
  await expect(mcap).toHaveAttribute("aria-sort", "ascending");
  await expect(tokenNames(page)).toHaveText(["Zeta Systems", "Alpha Labs"]);

  const name = page.locator(".pjd__tokens thead th").first();
  await name.locator(".rr-sort").click();
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await expect(mcap).not.toHaveAttribute("aria-sort", /.+/);
  await expect(tokenNames(page)).toHaveText(["Alpha Labs", "Zeta Systems"]);
});

test("every row links to its project's page", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await expect(tokenRows(page).filter({ hasText: "Alpha Labs" }).locator("a.pjd__who")).toHaveAttribute("href", "/projects/alpha");
  await expect(page.locator(".pjd__others a.pjd__who", { hasText: "Sticky Co" })).toHaveAttribute("href", "/projects/sticky");
});

test("the directory is in the nav and the footer, and indexed", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");

  await expect(page.locator('.nav a.nav__item[href="/projects"]')).toHaveCount(1);
  await expect(page.locator('.footer a[href="/projects"]')).toHaveCount(1);
  // The dead analytics subdomain stays unlinked.
  await expect(page.locator('a[href="https://analytics.robotmoney.net/projects"]')).toHaveCount(0);

  await navigate(page, "/projects");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow, max-image-preview:large, max-snippet:-1");
  await expect(page.locator('.nav__group[data-nav-section="research"] > .nav__top')).toHaveClass(/nav__top--active/);
});

test("a phone reads the directory without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");
  await expect(tokenRows(page)).toHaveCount(2);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The name, the token, its market cap and its move; the price and the FDV
  // are on the project's page.
  const alpha = tokenRows(page).filter({ hasText: "Alpha Labs" });
  await expect(alpha.locator(".pjd__mc")).toBeVisible();
  await expect(alpha.locator(".pjd__pct")).toBeVisible();
  await expect(alpha.locator(".pjd__fdv")).toBeHidden();
});

// navigate() resolves on the router's own completion event for the route it
// asked for, never on one for a route it left. Starts from a project page
// that is not indexed, so a stale directive would show.
test("navigate waits for the completion event for its requested route", async ({ page }) => {
  await stubEnvironment(page);
  await page.route(/\/api\/projects\/[^/]+$/, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "project not found" }) }));
  await page.goto("/");
  await navigate(page, "/projects/sticky");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");

  await page.route("**/views/regime.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.evaluate(() => {
    window.addEventListener("popstate", () => {
      window.dispatchEvent(new CustomEvent("rm:view-changed", { detail: { pathname: "/projects/sticky" } }));
    }, { once: true });
  });

  await navigate(page, "/regime");
  expect(await page.locator('meta[name="robots"]').getAttribute("content"))
    .toBe("index, follow, max-image-preview:large, max-snippet:-1");
  // One nav list serves desktop and phone (RM-124), so one current link, and
  // its group keeps the section's underline.
  await expect(page.locator('a[href="/regime"][aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('.nav__group[data-nav-section="research"] > .nav__top')).toHaveClass(/nav__top--active/);
});

test("navigate rejects within its configured timeout when completion never arrives", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await page.route("**/views/regime.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  await expect(navigate(page, "/regime", { timeoutMs: 25 })).rejects.toThrow(
    "navigate(/regime): router never dispatched rm:view-changed within 25ms",
  );
});

// The project pages in sitemap.xml are exactly the ones we have written up:
// a page with copy that is not listed is never crawled, and one listed
// without copy is noindex, which a sitemap must not advertise.
test("the sitemap lists exactly the project pages we have written up", () => {
  const xml = readFileSync(join(__dirname, "../../public/sitemap.xml"), "utf8");
  const listed = [...xml.matchAll(/<loc>https:\/\/robotmoney\.network\/projects\/([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  expect(listed).toEqual(Object.keys(PROJECT_COPY).sort());
  expect(xml).toContain("<loc>https://robotmoney.network/projects</loc>");
});

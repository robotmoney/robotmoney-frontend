// Render + interaction tests for the ported /projects directory (issue #70;
// fidelity upgrades from issue #388, §5.4). Same harness as
// analytics-views.spec.ts: the SPA + view HTML are served by the backend at
// baseURL, vendor CDN scripts are fulfilled from node_modules, and the
// /api/projects response is STUBBED with a deterministic DTO so the assertions are
// network-free. We verify routing to /projects, table row rendering with the a2
// tokens, facet pills, the inline sparkline, interactive column sorting, the
// Definitions dialog, column drag-resize persistence, the synced scroll
// mirror, and row links to the profile route.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { navigate } from "./navigation.ts";

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
// Zeta has the higher wallet balance; Sticky is pinned first on load despite 0 mcap.
// (issue #346: revenue30d is no longer part of the DTO — dropped here too.)
const PROJECTS = {
  projects: [
    {
      id: "p-sticky", slug: "sticky", displayName: "Sticky Co", logoUrl: null,
      description: "pinned on first load", websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: true,
      facets: { agent: true, x402: false, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [],
    },
    {
      id: "p-alpha", slug: "alpha", displayName: "Alpha Labs",
      logoUrl: null, description: "alpha blurb",
      websiteUrl: "https://alpha.example/", twitterHandle: "@alpha",
      dataCoverageScore: 92, isSticky: false,
      facets: { agent: true, x402: true, coin: true, wallet: true, vault: true },
      coins: [{ id: "c-alp", ticker: "ALP", name: "Alpha", marketCap: 12_000_000, fdv: 40_000_000, percentChange24h: 4.2, priceUsd: 1.5, volume24h: 800_000, refreshedAt: null, stale: true }],
      wallets: [{ id: "w1", label: "Treasury", chain: "base", balanceUsd: 1500, refreshedAt: null, stale: true }],
      walletTotalUsd: 1500,
      maxMarketCap: 12_000_000, maxFdv: 40_000_000, sparkline: [1.0, 1.1, 1.3, 1.5],
      volume24h: 800_000, tvlUsd: 1_000_000,
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
      maxMarketCap: 3_000_000, maxFdv: 6_000_000, sparkline: [2.0, 1.8, 1.6],
    },
    {
      id: "p-tokenless-active", slug: "tokenless-active", displayName: "Tokenless Active",
      logoUrl: null, description: "x402 with activity",
      websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: false,
      facets: { agent: true, x402: true, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [100, 200, 300],
    },
    {
      id: "p-tokenless-empty", slug: "tokenless-empty", displayName: "Tokenless Empty",
      logoUrl: null, description: "x402 no activity",
      websiteUrl: null, twitterHandle: null,
      dataCoverageScore: 60, isSticky: false,
      facets: { agent: true, x402: true, coin: false, wallet: false, vault: false },
      coins: [], wallets: [], walletTotalUsd: 0,
      maxMarketCap: 0, maxFdv: 0, sparkline: [],
    }
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

const rowNames = (page: Page) => page.locator(".pj-table tbody tr .pj-name__text");

test("routes to /projects and renders the directory table with a2 tokens", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  // Header + a2 gradient token.
  await expect(page.locator(".a2-hero__title")).toContainText("Agentic Economy");
  await expect(page.locator(".a2-hero__title .a2-grad")).toBeVisible();

  // Data present → the "No projects yet." empty state must not be shown (issue #87).
  await expect(page.locator(".pj-status", { hasText: "No projects yet" })).toBeHidden();

  // One row per project in the stub.
  await expect(page.locator(".pj-table tbody tr")).toHaveCount(5);

  // Alpha's row surfaces its aggregated numbers — every metric comes from the
  // /api/projects DTO the pipelines populate (market cap, 24h change, wallet).
  const alpha = page.locator(".pj-table tbody tr", { hasText: "Alpha Labs" });
  await expect(alpha).toContainText("$12.00M"); // max market cap
  await expect(alpha).toContainText("$40.00M"); // max fdv
  await expect(alpha).toContainText("+4.20%");  // 24h change
  await expect(alpha).toContainText("$1.5K");   // wallet balance (no revenue column, issue #346)
  await expect(alpha.locator(".pj-link", { hasText: "alpha.example" })).toBeVisible();
  await expect(alpha.locator(".pj-link", { hasText: "@alpha" })).toBeVisible();

  // Facet pills: all five present, all lit for Alpha.
  const alphaPills = alpha.locator(".pj-pill");
  await expect(alphaPills).toHaveCount(5);
  await expect(alpha.locator(".pj-pill--on")).toHaveCount(5);

  // Inline sparkline SVG renders for a project with a price series.
  await expect(alpha.locator("svg.pj-spark")).toBeVisible();

  // Tokenless x402 row renders sparkline <polyline> when activity exists, em-dash when absent.
  const tokenlessAct = page.locator(".pj-table tbody tr", { hasText: "Tokenless Active" });
  await expect(tokenlessAct.locator("svg.pj-spark polyline")).toBeVisible();

  const tokenlessEmp = page.locator(".pj-table tbody tr", { hasText: "Tokenless Empty" });
  await expect(tokenlessEmp.locator(".pj-spark-empty")).toBeVisible();
});

// Issue #346: ANALYTICS stays off site for the cutover, so all three places that
// advertised the in-domain table have to agree. The nav is asserted here rather
// than in spa.spec.ts because this spec already loads the shell and the route.
test("ANALYTICS navigates off site and /projects is de-advertised", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");

  // Desktop and mobile nav both leave the site, and neither still routes in-domain.
  const analytics = page.locator('a.nav__link:has-text("Analytics"), a.nav__mlink:has-text("Analytics")');
  await expect(analytics).toHaveCount(2);
  for (const href of await analytics.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) {
    expect(href).toBe("https://analytics.robotmoney.net/projects");
  }
  await expect(page.locator('a[href="/projects"]')).toHaveCount(0);

  // The route still resolves for anyone holding the URL, and says what backs it.
  await navigate(page, "/projects");
  await expect(page.locator(".pj-provenance")).toBeVisible();
  await expect(page.locator(".pj-provenance")).toContainText("seeded for development");

  // ...but it asks not to be indexed, and the directive is restored on the way out
  // so a noindex route cannot leak onto the next one.
  //
  // Keep these as retrying matchers as defense in depth. `navigate` now waits
  // for the router's matching rm:view-changed event, so the route metadata is
  // already applied when it resolves.
  const robots = page.locator('meta[name="robots"]');
  await expect(robots).toHaveAttribute("content", "noindex, follow");
  await navigate(page, "/regime");
  await expect(robots).toHaveAttribute("content", "index, follow, max-image-preview:large, max-snippet:-1");
});

test("navigate waits for the completion event for its requested route", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await page.route("**/views/regime.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.evaluate(() => {
    window.addEventListener("popstate", () => {
      window.dispatchEvent(new CustomEvent("rm:view-changed", { detail: { pathname: "/projects" } }));
    }, { once: true });
  });

  await navigate(page, "/regime");
  expect(await page.locator('meta[name="robots"]').getAttribute("content"))
    .toBe("index, follow, max-image-preview:large, max-snippet:-1");
  const currentNavLinks = page.locator('a[href="/regime"][aria-current="page"]');
  await expect(currentNavLinks).toHaveCount(2);
  await expect(currentNavLinks.first()).toHaveClass(/nav__link--active/);
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

// Issue #388 (P2.8, docs/bot-analytics-ui-port-plan.md §5.4): fidelity
// upgrades on the existing /projects directory — Definitions dialog, dual
// synced horizontal scrollbars, column resizing with localStorage
// persistence, and row links to the (still-stubbed) /projects/:slug profile
// route. Item 4 (sticky-left Project column) and item 6 (wallet/facet
// tooltips) were already shipped before this issue (native `title` attrs +
// `.a2-sticky`), so no new coverage is added for those.

test("row name links to the project profile route (§5.4 item 5)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  const alphaLink = page.locator(".pj-table tbody tr", { hasText: "Alpha Labs" }).locator("a.pj-name__link");
  await expect(alphaLink).toHaveAttribute("href", "/projects/alpha");
});

test("Definitions dialog lists a term for every column and closes on Escape (§5.4 item 1)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await expect(page.locator(".pj-dialog-overlay")).toBeHidden();
  await page.locator(".pj-defs-trigger").click();
  await expect(page.locator(".pj-dialog-overlay")).toBeVisible();

  const terms = page.locator(".pj-defs__item dt");
  await expect(terms).toHaveCount(13);
  await expect(page.locator(".pj-defs__item", { hasText: "Wallet Balance" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".pj-dialog-overlay")).toBeHidden();
});

test("column drag-resize persists to localStorage['projects-col-widths-v2'] (§5.4 item 3)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  const handle = page.locator('[data-col-resize="mcap"]');
  const box = await handle.boundingBox();
  if (!box) throw new Error("resize handle not found");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY, { steps: 5 });
  await page.mouse.up();

  const stored = await page.evaluate(() => localStorage.getItem("projects-col-widths-v2"));
  expect(stored).not.toBeNull();
  const widths = JSON.parse(stored as string);
  expect(widths.mcap).toBeGreaterThanOrEqual(130 + 80 - 5); // allow small rounding slack
});

test("the top scroll mirror stays in sync with the table's horizontal scroll (§5.4 item 2)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  // Widen nothing needed — the table is already wider than the viewport with
  // 12 fixed-width columns; scroll the main container and assert the mirror
  // follows, then the reverse.
  await page.locator(".pj-scroll").evaluate((el) => { el.scrollLeft = 40; });
  await expect(page.locator(".pj-scroll-mirror")).toHaveJSProperty("scrollLeft", 40);

  await page.locator(".pj-scroll-mirror").evaluate((el) => { el.scrollLeft = 15; });
  await expect(page.locator(".pj-scroll")).toHaveJSProperty("scrollLeft", 15);
});

test("sticky project pins first on load; clicking a header re-sorts and releases the pin", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await expect(rowNames(page)).toHaveCount(5);
  // First load: sticky pinned first, then market cap desc (Alpha > Zeta > Tokenless...).
  await expect(rowNames(page)).toHaveText(["Sticky Co", "Alpha Labs", "Zeta Systems", "Tokenless Active", "Tokenless Empty"]);

  // Sort by Wallet Balance desc → Zeta (9000) leads, sticky pin released.
  await page.locator(".pj-table thead .pj-sort", { hasText: "Wallet Balance" }).click();
  await expect(rowNames(page)).toHaveText(["Zeta Systems", "Alpha Labs", "Sticky Co", "Tokenless Active", "Tokenless Empty"]);

  // Toggle to ascending → order reverses (ties keep their original relative order).
  await page.locator(".pj-table thead .pj-sort", { hasText: "Wallet Balance" }).click();
  await expect(rowNames(page)).toHaveText(["Sticky Co", "Tokenless Active", "Tokenless Empty", "Alpha Labs", "Zeta Systems"]);
});

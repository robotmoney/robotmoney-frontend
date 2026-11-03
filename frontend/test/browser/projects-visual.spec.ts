// Visual-parity regression for /projects, mid-horizontal-scroll (issue #388,
// P2.8, docs/bot-analytics-ui-port-plan.md §5.4/§7): the plan calls this one
// of the highest-risk fidelity pages — "Projects' resizable sticky columns +
// dual synced scrollbars (easiest to get subtly wrong in CSS)" — so it gets
// its own committed baseline, same convention as regime-visual.spec.ts.
//
// The gate is Playwright's own committed baseline (toHaveScreenshot), not a
// byte-exact target. The animated mesh hero canvas is masked (non-deterministic
// p5 animation, same treatment as regime's `.rv__hero-art`).
//
// Generate/refresh the baseline with:
//   bun run test:browser -- --update-snapshots projects-visual
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

// Same deterministic fixture shape as projects.spec.ts, trimmed to the rows
// needed to fill the table width for a meaningful horizontal-scroll shot.
const PROJECTS = {
  projects: [
    {
      id: "p-alpha", slug: "alpha", displayName: "Alpha Labs",
      logoUrl: null, description: "Agentic revenue infrastructure for onchain protocols.",
      websiteUrl: "https://alpha.example/", twitterHandle: "@alpha",
      dataCoverageScore: 92, isSticky: false,
      facets: { agent: true, x402: true, coin: true, wallet: true, vault: true },
      coins: [{ id: "c-alp", ticker: "ALP", name: "Alpha", marketCap: 12_000_000, fdv: 40_000_000, percentChange24h: 4.2, priceUsd: 1.5, volume24h: 800_000, refreshedAt: null, stale: true }],
      wallets: [{ id: "w1", label: "Treasury", chain: "base", balanceUsd: 1500, refreshedAt: null, stale: true }],
      walletTotalUsd: 1500,
      maxMarketCap: 12_000_000, maxFdv: 40_000_000, sparkline: [1.0, 1.1, 1.3, 1.5, 1.4, 1.6],
      volume24h: 800_000, tvlUsd: 1_000_000,
    },
    {
      id: "p-zeta", slug: "zeta", displayName: "Zeta Systems",
      logoUrl: null, description: "Cross-chain wallet infrastructure for autonomous agents.",
      websiteUrl: "https://zeta.example/", twitterHandle: "@zeta",
      dataCoverageScore: 70, isSticky: false,
      facets: { agent: false, x402: false, coin: true, wallet: true, vault: false },
      coins: [{ id: "c-zet", ticker: "ZET", name: "Zeta", marketCap: 3_000_000, fdv: 6_000_000, percentChange24h: -2.1, priceUsd: null, volume24h: null, refreshedAt: null, stale: true }],
      wallets: [{ id: "w-zet", label: "Zeta Treasury", chain: "base", balanceUsd: 9000, refreshedAt: null, stale: true }],
      walletTotalUsd: 9000,
      maxMarketCap: 3_000_000, maxFdv: 6_000_000, sparkline: [2.0, 1.8, 1.6, 1.7],
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

test("projects directory matches its visual baseline mid-horizontal-scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/projects");

  await expect(page.locator(".pj-table tbody tr")).toHaveCount(2);

  // Engage the horizontal scroll (sticky Project column + dual scrollbar
  // sync are the fidelity-risk surface §7 calls out) before capturing.
  await page.locator(".pj-scroll").evaluate((el) => { el.scrollLeft = 200; });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("projects-mid-scroll.png", {
    fullPage: true,
    animations: "disabled",
    mask: [page.locator(".a2-hero__viz")],
    maxDiffPixelRatio: 0.01,
  });
});

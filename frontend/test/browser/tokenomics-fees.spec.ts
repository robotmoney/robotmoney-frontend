// Render test for the LIVE fee-split section of /tokenomics: the fee-distribution
// legend + per-partner breakdown cards are bound by the feeChart() factory to
// GET /api/dashboards/token-metrics (`feeSplit`) — the Protocol/Bankr/Clanker %
// literals are no longer baked into the view. Same harness pattern as
// allocation-view.spec.ts: the SPA + view HTML are served by the backend at
// baseURL (a preview server replaying goldens/api-goldens.json), vendor CDN
// scripts are fulfilled from node_modules, and the endpoint under test is stubbed.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

interface FeeLeg { label: string; pct: number }
interface TokenMetrics {
  robotmoney?: { priceUsd: number; totalSupply: number; marketCapUsd: number };
  feeSplit: FeeLeg[];
  asOf: string; source: string; stale: boolean;
}

function loadTokenMetricsGolden(): TokenMetrics {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes["/api/dashboards/token-metrics"];
  if (!payload) throw new Error("no /api/dashboards/token-metrics golden — run `bun run goldens:update`");
  return payload as TokenMetrics;
}

async function stubEnvironment(page: Page, metrics: TokenMetrics, onHit?: () => void) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  await page.route("**/api/dashboards/token-metrics", (route) => {
    onHit?.();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(metrics) });
  });
}

async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("tokenomics fee-split legend + breakdown cards render FROM GET /api/dashboards/token-metrics golden feeSplit", async ({ page }) => {
  const metrics = loadTokenMetricsGolden();
  const fs = metrics.feeSplit;
  expect(fs.length).toBeGreaterThan(0);
  let hit = false;
  await stubEnvironment(page, metrics, () => { hit = true; });
  await page.goto("/");
  await navigate(page, "/tokenomics");

  const legend = page.locator(".tok__legend-item");
  const pctCards = page.locator(".tok__fee-pct");
  await expect(legend).toHaveCount(fs.length);
  await expect(pctCards).toHaveCount(fs.length);
  for (let i = 0; i < fs.length; i++) {
    // feeLegend(i) === "Protocol (57%)"; feePctLabel(i) === "57%".
    await expect(legend.nth(i)).toContainText(`${fs[i]!.label} (${fs[i]!.pct}%)`);
    await expect(pctCards.nth(i)).toHaveText(`${fs[i]!.pct}%`);
  }
  expect(hit).toBe(true); // the endpoint was actually fetched
});

test("tokenomics fee-split reflects the SERVED percentages, not baked 57/40/3 literals", async ({ page }) => {
  const golden = loadTokenMetricsGolden();
  // Deliberately different percentages: if the DOM shows 50/45/5 they can only
  // have come from this response, proving the view is not rendering baked % text.
  const mutated: TokenMetrics = {
    ...golden,
    feeSplit: [
      { label: "Protocol", pct: 50 },
      { label: "Bankr", pct: 45 },
      { label: "Clanker", pct: 5 },
    ],
  };
  await stubEnvironment(page, mutated);
  await page.goto("/");
  await navigate(page, "/tokenomics");

  const pctCards = page.locator(".tok__fee-pct");
  await expect(pctCards.nth(0)).toHaveText("50%");
  await expect(pctCards.nth(1)).toHaveText("45%");
  await expect(pctCards.nth(2)).toHaveText("5%");
  // Never the retired baked Protocol=57% literal.
  await expect(pctCards.nth(0)).not.toHaveText("57%");
  await expect(page.locator(".tok__legend-item").nth(0)).toContainText("Protocol (50%)");
});

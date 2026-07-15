// Render test for the LIVE /performance page (issue #84). The walletPerfView
// factory used to bake a frozen 99-day per-asset series inline in
// alpine/views.js; it now derives the eight stacked series + the Historical Data
// table from GET /api/dashboards/wallet-balances (holdings[] = fixed
// group/colour order, history[] = continuous sparse byAsset per day).
//
// Same harness as allocation-view.spec.ts: the SPA + view HTML are served by the
// backend at baseURL, vendor CDN scripts are fulfilled from node_modules, and the
// wallet-balances endpoint is stubbed inline (no live prop-wallet capture — the
// addresses are owner data). Asserts: the table's series order matches the
// endpoint holdings[] order, the rows/totals come from history[], and the baked
// series literal no longer survives in the served view.
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

// The eight fixed series, in Stable→Protocol→Agent→Stocks group/colour order.
const SERIES: { symbol: string; color: string }[] = [
  { symbol: "USDC", color: "#10b981" },
  { symbol: "ZYFAI-SS1", color: "#10b981" },
  { symbol: "GIZA-SS1", color: "#10b981" },
  { symbol: "WETH", color: "#f59e0b" },
  { symbol: "ETH", color: "#f59e0b" },
  { symbol: "ROBOTMONEY", color: "#3b82f6" },
  { symbol: "BNKR", color: "#3b82f6" },
  { symbol: "SP500", color: "#8b5cf6" },
];

// Six days of continuous, sparse history (last 5 render collapsed).
const HISTORY = [
  { date: "2026-03-18", byAsset: { WETH: 21519, ROBOTMONEY: 51300, BNKR: 12 }, totalUsd: 72831 },
  { date: "2026-03-19", byAsset: { WETH: 20841, ROBOTMONEY: 45207, BNKR: 12 }, totalUsd: 66060 },
  { date: "2026-06-24", byAsset: { USDC: 8995, WETH: 25682, ETH: 83, ROBOTMONEY: 36143, BNKR: 11, SP500: 4669, "ZYFAI-SS1": 4537 }, totalUsd: 80120 },
  { date: "2026-06-25", byAsset: { USDC: 9042, WETH: 24916, ETH: 81, ROBOTMONEY: 31831, BNKR: 10, SP500: 4683, "ZYFAI-SS1": 4538 }, totalUsd: 75101 },
  { date: "2026-06-26", byAsset: { USDC: 9052, WETH: 24194, ETH: 78, ROBOTMONEY: 30652, BNKR: 9, SP500: 4656, "ZYFAI-SS1": 4538 }, totalUsd: 73180 },
  { date: "2026-06-27", byAsset: { USDC: 9100, WETH: 24000, ETH: 80, ROBOTMONEY: 30000, BNKR: 9, SP500: 4660, "ZYFAI-SS1": 4539 }, totalUsd: 72388 },
];

function walletStub() {
  return {
    asOf: "2026-07-07T20:12:13.482Z",
    totalUsd: HISTORY[HISTORY.length - 1]!.totalUsd,
    source: "stub",
    priceSource: "stub",
    holdings: SERIES.map((s) => ({ symbol: s.symbol, chain: "base", group: "Stable", color: s.color, amount: 1, priceUsd: 1, valueUsd: 1, priceSource: "pinned", provenance: "stub" })),
    history: HISTORY,
  };
}

function fmtUsd(v: number): string {
  return "$" + Number(v).toLocaleString("en-US");
}

async function stubEnvironment(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  await page.route("**/api/dashboards/wallet-balances", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(walletStub()) }));
}

async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("performance view draws the eight stacked series + Historical Data table from the wallet-balances history[] (issue #84)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/performance");

  // Both stacked charts mount their canvases.
  await expect(page.locator('canvas[x-ref="aum"]')).toBeVisible();
  await expect(page.locator('canvas[x-ref="alloc"]')).toBeVisible();

  // Table column headers = Date + the eight fixed series (endpoint holdings[]
  // order: Stable→Protocol→Agent→Stocks) + Total AUM.
  const headers = page.locator("table.a2-table thead th");
  await expect(headers).toHaveText(["Date", ...SERIES.map((s) => s.symbol), "Total AUM"]);

  // Collapsed = last 5 days.
  const rows = page.locator("table.a2-table tbody tr");
  await expect(rows).toHaveCount(5);

  // The latest row's date + Total AUM come straight from history[].
  const latest = HISTORY[HISTORY.length - 1]!;
  const lastRow = rows.last();
  await expect(lastRow.locator("td.a2-sticky")).toHaveText("Jun 27");
  await expect(lastRow.locator("td.a2-total")).toHaveText(fmtUsd(latest.totalUsd));

  // Per-symbol cells reflect the sparse byAsset map: a held symbol shows its
  // USD value; an absent symbol renders the em-dash.
  const held = SERIES.findIndex((s) => s.symbol === "WETH");
  await expect(lastRow.locator("td.a2-r").nth(held)).toContainText(fmtUsd(latest.byAsset.WETH!));

  // "Show All" expands to every day the endpoint returned.
  await page.locator(".a2-table__toggle").click();
  await expect(page.locator("table.a2-table tbody tr")).toHaveCount(HISTORY.length);
  await expect(page.locator("table.a2-table tbody tr").first().locator("td.a2-sticky")).toHaveText("Mar 18");
});

test("the served performance view no longer bakes the frozen walletPerfView series (issue #84)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  // walletPerfView lives in its own module since the per-view split of the old
  // monolithic views.js (review-maintainability finding 025, issue #129).
  const src = await page.evaluate(async () => (await fetch("/assets/js/app/alpine/views/wallet-perf.js")).text());
  // The retired baked arrays (a distinctive frozen totalAum literal + a labels
  // array) must be gone; the live endpoint wiring must be present.
  expect(src).not.toContain("totalAum: [72831");
  expect(src).not.toContain('labels: ["Mar 18","Mar 19"');
  expect(src).toContain("ROUTES.dashboards.walletBalances");
});

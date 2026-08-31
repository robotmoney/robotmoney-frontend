// Render test for the LIVE fee-split section of /tokenomics: the fee-distribution
// legend + per-partner breakdown cards are bound by the feeChart() factory to
// GET /api/dashboards/token-metrics (`feeSplit`) — the Protocol/Bankr/Clanker %
// literals are no longer baked into the view. Same harness pattern as
// vault-view.spec.ts: the SPA + view HTML are served by the backend at
// baseURL (a preview server replaying goldens/api-goldens.json), vendor CDN
// scripts are fulfilled from node_modules, and the endpoint under test is stubbed.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { navigate } from "./navigation.ts";

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

// ── Migrated from allocation-view.spec.ts (issue #800, Cluster A) ────────────
// RM-105 (PR #774) deleted the /allocation route, taking with it the only other
// rendering of the buyback history — and its spec was left driving an address
// that no longer resolves. /tokenomics renders the SAME feed, every row and the
// same tfoot totals, through the buybackSummary() factory, so the binding
// assertion moves here rather than being dropped with the page.
interface BuybackRow { date: string; txHash: string; wethSpent: number; valueUsd: number; robotmoneyReceived: number }
interface Buybacks { rows: BuybackRow[]; totals: { wethSpent: number; valueUsd: number; robotmoneyReceived: number }; source: string }

function loadBuybacksGolden(): Buybacks {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes["/api/dashboards/buybacks"];
  if (!payload) throw new Error("no /api/dashboards/buybacks golden — run `bun run goldens:update`");
  return payload as Buybacks;
}

const fmtWeth = (v: number) => v.toFixed(4);
const fmtWethLabel = (v: number) => v.toFixed(6) + " WETH";
const fmtUsd0 = (v: number) => "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtRmoney = (v: number) => (v / 1e6).toFixed(2) + "M";

test("Buyback History rows + totals render FROM GET /api/dashboards/buybacks, not baked rows", async ({ page }) => {
  const metrics = loadTokenMetricsGolden();
  const buybacks = loadBuybacksGolden();
  expect(buybacks.rows.length).toBeGreaterThan(0);
  let hit = false;
  await stubEnvironment(page, metrics);
  await page.route("**/api/dashboards/buybacks", (route) => {
    hit = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buybacks) });
  });
  await page.goto("/");
  await navigate(page, "/tokenomics");

  // One row per served buyback. The loading and empty placeholder <tr>s carry
  // no date cell content, so scope to the rendered rows by their tbody
  // position: x-for emits exactly rows.length of them between the two.
  const table = page.locator("#buybacks .tok__table");
  const dataRows = table.locator("tbody tr").filter({ hasText: buybacks.rows[0]!.date.slice(0, 4) });
  await expect(dataRows).toHaveCount(buybacks.rows.length);
  expect(hit).toBe(true); // the endpoint was actually fetched

  // Every column of the first row comes from the served DTO, not a literal.
  const first = dataRows.first().locator("td");
  await expect(first.nth(0)).toHaveText(buybacks.rows[0]!.date);
  await expect(first.nth(1)).toHaveText(fmtWeth(buybacks.rows[0]!.wethSpent));
  await expect(first.nth(2)).toHaveText(fmtUsd0(buybacks.rows[0]!.valueUsd));
  await expect(first.nth(3)).toHaveText(fmtRmoney(buybacks.rows[0]!.robotmoneyReceived));

  // Total-spent chip + tfoot totals are computed by the API and echoed verbatim.
  const wethLabel = fmtWethLabel(buybacks.totals.wethSpent);
  await expect(page.locator("#buybacks .tok__bb-summary-val")).toHaveText(wethLabel);
  const totalRow = table.locator("tfoot tr").locator("td");
  await expect(totalRow.nth(1)).toHaveText(wethLabel);
  await expect(totalRow.nth(2)).toHaveText(fmtUsd0(buybacks.totals.valueUsd));
  await expect(totalRow.nth(3)).toHaveText(fmtRmoney(buybacks.totals.robotmoneyReceived));
});

test("Buyback History reflects the SERVED rows, not the goldens it usually matches", async ({ page }) => {
  // The mutation half: a payload that shares no value with the golden. If these
  // numbers reach the DOM, the table can only be reading the response.
  const mutated: Buybacks = {
    source: "live",
    rows: [{ date: "2026-01-02", txHash: "0xdead", wethSpent: 9.5, valueUsd: 12345, robotmoneyReceived: 7000000 }],
    totals: { wethSpent: 9.5, valueUsd: 12345, robotmoneyReceived: 7000000 },
  };
  await stubEnvironment(page, loadTokenMetricsGolden());
  await page.route("**/api/dashboards/buybacks", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mutated) }));
  await page.goto("/");
  await navigate(page, "/tokenomics");

  const table = page.locator("#buybacks .tok__table");
  const row = table.locator("tbody tr").filter({ hasText: "2026-01-02" }).locator("td");
  await expect(row.nth(1)).toHaveText("9.5000");
  await expect(row.nth(2)).toHaveText("$12,345");
  await expect(row.nth(3)).toHaveText("7.00M");
  await expect(page.locator("#buybacks .tok__bb-summary-val")).toHaveText("9.500000 WETH");
});

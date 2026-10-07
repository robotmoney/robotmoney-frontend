// Render test for /treasury (RM-157), which replaced /performance. The page
// is the team's check on the protocol wallets, so what it asserts is accuracy:
// only on-chain holdings count (the hard-coded S&P 500 position is left out of
// every figure), wallets are named by what they hold, a gap in the history is
// a gap, and a read that fails says so where its figure would be.
//
// Same harness as tokenomics-fees.spec.ts: the SPA is served at baseURL, vendor
// scripts come from node_modules, and the four reads the page makes are stubbed.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { navigate } from "./navigation.ts";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js": "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js": "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js": "node_modules/p5/lib/p5.min.js",
};

const PRIMARY = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";
const SS1 = "0x422c906083ca40b7e055b811d517f03bbbef8eee";
const SS2 = "0x8d0c331e45beca4184b758f3049f8897aabb9442";

// Twelve days: eight in a row, a nine-day gap, then four. SP500 rides along on
// every day and must count on none.
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08",
  "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"];
const HISTORY = DAYS.map((date, i) => ({
  date,
  byAsset: { ROBOTMONEY: 20_000 + i * 100, WETH: 25_000, USDC: 400, SP500: 5_000 },
  totalUsd: 50_400 + i * 100,
  provenance: "live",
}));

function balances() {
  return {
    asOf: "2026-09-21T12:00:00Z", source: "live", priceSource: "live", totalUsd: 55_500,
    holdings: [
      { symbol: "USDC", amount: 400, priceUsd: 1, valueUsd: 400, provenance: "live" },
      { symbol: "WETH", amount: 10, priceUsd: 2_500, valueUsd: 25_000, provenance: "live" },
      { symbol: "ROBOTMONEY", amount: 7e9, priceUsd: 0.0000030, valueUsd: 21_000, provenance: "live" },
      { symbol: "SP500", amount: 0.633, priceUsd: 7_900, valueUsd: 5_000, provenance: "live" },
      { symbol: "ZYFAI-SS1", amount: 0.00004, priceUsd: 1, valueUsd: 0.00004, provenance: "live" },
    ],
    history: HISTORY,
    historyProvenance: { live: HISTORY.length, stub: 0, stale: 0, seed: 0, backfilled: 0 },
  };
}

function sleeves() {
  return {
    asOf: "2026-09-21T12:00:00Z", source: "live", stale: false,
    wallets: [
      { name: "Bankr", address: PRIMARY, type: "primary", totalUsd: 21_000, stale: false,
        holdings: [{ symbol: "ROBOTMONEY", amount: 7e9, priceUsd: 0.000003, valueUsd: 21_000, provenance: "live" }] },
      { name: "Stablecoin Strategy 1", address: SS1, type: "strategy", totalUsd: 25_000, stale: false,
        holdings: [{ symbol: "WETH", amount: 10, priceUsd: 2_500, valueUsd: 25_000, provenance: "live" },
          { symbol: "ZYFAI-SS1", amount: 0.00004, priceUsd: 1, valueUsd: 0.00004, provenance: "live" }] },
      { name: "Stablecoin Strategy 2", address: SS2, type: "strategy", totalUsd: 400, stale: false,
        holdings: [{ symbol: "USDC", amount: 400, priceUsd: 1, valueUsd: 400, provenance: "live" },
          { symbol: "GIZA-SS1", amount: 1_200, priceUsd: 1, valueUsd: 1_200, provenance: "live" }] },
    ],
  };
}

const METRICS = { feeSplit: [{ label: "Protocol", pct: 57 }, { label: "Bankr", pct: 36.1 }], feeIncome: { lifetimeWeth: 33.47, lifetimeRobotmoney: 7.97e9, lifetimeUsd: 118_000, last30DaysUsd: 1_210 } };
const BUYBACKS = { source: "live", rows: [{ date: "2026-03-23", txHash: "0x" + "a1".repeat(32), wethSpent: 0.1, valueUsd: 250, robotmoneyReceived: 18e6 }], totals: { wethSpent: 0.1, valueUsd: 250, robotmoneyReceived: 18e6 } };

async function stub(page: Page, over: Partial<Record<"balances" | "sleeves" | "metrics" | "buybacks", number>> = {}) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  const serve = (path: string, key: keyof typeof over, body: unknown) =>
    page.route(`**/api/dashboards/${path}`, (route) =>
      over[key] ? route.fulfill({ status: over[key], body: "{}" }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
  await serve("wallet-balances", "balances", balances());
  await serve("wallet-sleeves", "sleeves", sleeves());
  await serve("token-metrics", "metrics", METRICS);
  await serve("buybacks", "buybacks", BUYBACKS);
}

test("only on-chain holdings count: the S&P 500 is in no figure, today's or the history's", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await navigate(page, "/treasury");
  // 400 + 25,000 + 21,000; the Zyfai dust and the S&P 500 are out.
  await expect(page.locator(".trs__meta .rr-meta__i").first()).toContainText("$46,400");
  await expect(page.locator(".trs__legend li")).toHaveCount(3);
  await expect(page.locator("#holdings")).not.toContainText(/S&P|SP500/);
  // The newest day's total: 20,000 + 1,100 + 25,000 + 400, without its 5,000 of SP500.
  const first = page.locator(".trs__daily tbody tr").first();
  await expect(first.locator("th")).toHaveText("Sep 21, 2026");
  await expect(first.locator("td").last()).toHaveText("$46,500");
  await expect(page.locator(".trs__daily thead")).not.toContainText(/S&P|SP500/);
});

test("wallets are named by what they are, and each strategy account says what it holds", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await navigate(page, "/treasury");
  const heads = page.locator(".trs__wallet th");
  await expect(heads).toHaveCount(3);
  await expect(heads.nth(0)).toContainText("Primary wallet");
  await expect(heads.nth(1)).toContainText("Strategy wallet 1");
  await expect(heads.nth(1)).toContainText("Zyfai strategy account: empty");
  await expect(heads.nth(2)).toContainText("Giza strategy account: $1,200");
  await expect(page.locator(".trs__wallets")).not.toContainText("Stablecoin Strategy");
  await expect(heads.nth(0).locator("a")).toHaveAttribute("href", `https://basescan.org/address/${PRIMARY}`);
});

test("a gap in the history is drawn as a gap, not bridged", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await navigate(page, "/treasury");
  // Two unbroken runs (the eight days, then the four): two edges, two fills.
  const value = page.locator("#history .rr-area__svg").first();
  await expect(value.locator("polyline")).toHaveCount(2);
  await expect(value.locator("polygon")).toHaveCount(2);
});

test("the daily table is newest first, ten to a page", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await navigate(page, "/treasury");
  await expect(page.locator(".trs__daily tbody tr")).toHaveCount(10);
  await expect(page.locator("#history .rr-pager [role=status]")).toHaveText("1–10 of 12");
  await page.getByRole("button", { name: "Older" }).click();
  await expect(page.locator(".trs__daily tbody tr")).toHaveCount(2);
  await expect(page.locator(".trs__daily tbody tr").last().locator("th")).toHaveText("Sep 1, 2026");
});

test("in and out: fees earned against buybacks spent, the WETH share in WETH on both sides", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await navigate(page, "/treasury");
  await expect(page.locator(".trs__meta")).toContainText("Fee income over 30 days ~$1,210");
  const fees = page.locator(".trs__flow").nth(0);
  const out = page.locator(".trs__flow").nth(1);
  await expect(fees.locator(".rr-stat__v")).toHaveText("$118,000");
  await expect(fees.locator("dd")).toHaveText(["33.47 WETH", "7.97B", "57%"]);
  await expect(out.locator(".rr-stat__v")).toHaveText("$250");
  // 0.1 WETH spent of 33.47 earned.
  await expect(out.locator("dd")).toHaveText(["1", "Mar 23, 2026", "0.1000 WETH", "0.3%", "18.00M"]);
});

test("a failed wallet read says no data is available where each figure would be; the fee and buyback figures stand", async ({ page }) => {
  await stub(page, { balances: 503 });
  await page.goto("/");
  await navigate(page, "/treasury");
  await expect(page.locator("#holdings .trs__ring .rm-nodata__h")).toHaveText("No data available");
  await expect(page.locator("#history .rm-nodata__h")).toHaveText(["No data available", "No data available"]);
  await expect(page.locator("#flows")).toContainText("$118,000");
  await expect(page.locator("#flows")).toContainText("Mar 23, 2026");
});

test("/performance, the page's old address, moves to /treasury", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  // The router reports the page it lands on, /treasury, so navigate() (which
  // waits for the path it was given) cannot drive this one.
  await page.evaluate(() => {
    history.pushState({}, "", "/performance");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/treasury$/);
  await expect(page.getByRole("heading", { name: "Treasury", level: 1 })).toBeVisible();
});

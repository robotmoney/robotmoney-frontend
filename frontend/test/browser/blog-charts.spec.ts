// Issue #350: five research/blog posts were ported as static notes because the
// router injects view fragments with innerHTML, so a <script> inside a
// fragment never executes. This spec exercises the restored REAL render path —
// the alpine/views/blog-charts.js factories registered at boot — against the
// REAL committed data fixtures (frontend/public/data/{regime-eq-comparison,
// weighting-comparison,treasury-allocation,regime-conservative-aggressive}.json),
// served by the live backend's static file route exactly as production would
// serve them. No route stubbing of the data fetch: this is the same
// "exercise the shipped archive fixture, not a mock" pattern
// committee-subject.spec.ts established for the committee static-archive
// fallback.
//
// Chart.js v4 exposes a static Chart.getChart(canvas) registry lookup, so the
// assertions below check an actual chart INSTANCE with the expected dataset
// count mounted on each canvas — a markup substring check on figure text
// would not prove a chart executed.
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

async function stubVendorScripts(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
}

async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

// Reads Chart.js's own instance registry off a <canvas x-ref="…">, returning
// null if nothing is mounted (never masking a draw failure as "0 datasets").
async function chartInfo(page: Page, ref: string) {
  return page.evaluate((r) => {
    const canvas = document.querySelector(`canvas[x-ref="${r}"]`) as HTMLCanvasElement | null;
    const chart = canvas && (window as any).Chart?.getChart(canvas);
    return chart ? { type: chart.config.type, datasets: chart.data.datasets.length } : null;
  }, ref);
}

test("regime-eq-vs-base renders its three restored charts from the committed regime-eq-comparison.json fixture", async ({ page }) => {
  await stubVendorScripts(page);
  await page.goto("/");
  await navigate(page, "/blog/regime-eq-vs-base");

  await expect(page.locator(".blog-figure-chart canvas")).toHaveCount(3);

  const equity = await chartInfo(page, "equity");
  expect(equity).toEqual({ type: "line", datasets: 3 });

  const sharpe = await chartInfo(page, "sharpe");
  expect(sharpe).toEqual({ type: "bar", datasets: 5 });

  const index = await chartInfo(page, "index");
  expect(index).toEqual({ type: "line", datasets: 3 });
});

test("honest-backtesting-weights renders its restored equity-curve chart from the committed weighting-comparison.json fixture", async ({ page }) => {
  await stubVendorScripts(page);
  await page.goto("/");
  await navigate(page, "/blog/honest-backtesting-weights");

  await expect(page.locator(".blog-figure-chart canvas")).toHaveCount(1);

  const chart = await chartInfo(page, "chart");
  expect(chart).toEqual({ type: "line", datasets: 3 });
});

test("treasury-allocation renders its restored backtest + attribution charts from the committed treasury-allocation.json fixture", async ({ page }) => {
  await stubVendorScripts(page);
  await page.goto("/");
  await navigate(page, "/blog/treasury-allocation");

  await expect(page.locator(".blog-research__figure-chart canvas")).toHaveCount(2);

  const backtest = await chartInfo(page, "backtest");
  expect(backtest).toEqual({ type: "line", datasets: 5 });

  // The attribution chart is the one issue #350's notes flag: production drew
  // it as two stacked cyan fills (the anti-pattern #327 already hit). This
  // restores it as three plain strokes instead — assert no dataset here
  // carries a `fill` truthy value, so a future edit can't silently reintroduce
  // a filled mass on the composite line.
  const attributionFills = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[x-ref="attribution"]') as HTMLCanvasElement | null;
    const chart = canvas && (window as any).Chart?.getChart(canvas);
    return chart ? chart.data.datasets.map((d: any) => !!d.fill) : null;
  });
  expect(attributionFills).toEqual([false, false, false]);

  const attribution = await chartInfo(page, "attribution");
  expect(attribution).toEqual({ type: "line", datasets: 3 });
});

test("regime-conservative-aggressive renders its restored regime-band panels + rule-comparison chart from the committed regime-conservative-aggressive.json fixture", async ({ page }) => {
  await stubVendorScripts(page);
  await page.goto("/");
  await navigate(page, "/blog/regime-conservative-aggressive");

  await expect(page.locator(".blog-research__band-chart canvas")).toHaveCount(3);
  await expect(page.locator(".blog-research__figure-chart canvas")).toHaveCount(1);

  const bandsComposite = await chartInfo(page, "bandsComposite");
  expect(bandsComposite).toEqual({ type: "line", datasets: 1 });
  const bandsConservative = await chartInfo(page, "bandsConservative");
  expect(bandsConservative).toEqual({ type: "line", datasets: 1 });
  const bandsAggressive = await chartInfo(page, "bandsAggressive");
  expect(bandsAggressive).toEqual({ type: "line", datasets: 1 });

  const rules = await chartInfo(page, "rules");
  expect(rules).toEqual({ type: "line", datasets: 5 });
});

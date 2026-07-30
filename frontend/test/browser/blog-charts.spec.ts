// Issue #350: five research/blog posts were ported as static notes because the
// router injects view fragments with innerHTML, so a <script> inside a
// fragment never executes. This spec exercises the restored REAL render path —
// the alpine/views/blog-charts.js factories registered at boot — against the
// REAL committed data fixtures (frontend/public/data/{regime-eq-comparison,
// weighting-comparison}.json), served by the live backend's static file
// route exactly as production would serve them. No route stubbing of the
// data fetch: this is the same "exercise the shipped archive fixture, not a
// mock" pattern committee-subject.spec.ts established for the committee
// static-archive fallback.
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

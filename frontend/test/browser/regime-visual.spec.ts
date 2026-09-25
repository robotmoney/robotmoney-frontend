// Visual-parity regression for the /regime dashboard. Renders the full page at
// the same 1440-wide viewport the original-site reference screenshots were
// captured at (frontend/test/fixtures/screenshots/original/regime.png), stubbing
// the API with the vendored eq-snapshot through the SAME pure mapper the live
// endpoint uses — so the render is deterministic and network-free.
//
// The gate is Playwright's own committed baseline (toHaveScreenshot), NOT a
// strict diff against the foreign Next.js screenshot: sub-pixel AA / font
// hinting differ across renderers, so original/regime.png is a design reference
// for human review, not a byte-exact target. The animated p5 hero is masked.
//
// Generate/refresh the baseline with:
//   bun run test:browser -- --update-snapshots regime-visual
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mapEqSnapshotToDto } from "../../../backend/src/analytics/report/regime-eq-map.ts";
import { navigate } from "./navigation.ts";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

function regimeDto() {
  const gz = join(process.cwd(), "backend/tests/fixtures/regime/regime-eq-snapshot.json.gz");
  return mapEqSnapshotToDto(JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8")));
}

async function stub(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(regimeDto()) }));
}

// Layout stability while the snapshot is still in flight. /regime used to
// announce loading with one line of text and then replace it with several
// screens of dashboard, so the methodology block, the disclaimer and the footer
// all dropped by a viewport the moment the fetch landed: measured CLS 0.2872,
// where 0.25 is already "poor". The .rv__skel skeleton holds that shape and
// height instead, measuring 0.0001.
//
// This is the guard the two earlier fixes of the same bug did NOT get. /swarm
// (0.4974) and /skills (0.53) both recorded their numbers in a source comment
// and nothing else, so nothing would go red if a skeleton were dropped, or if
// its height drifted away from the content it stands in for. A comment is not a
// test. The threshold is the "good" bound rather than the measured value, so
// ordinary sub-pixel noise cannot make this flaky while a regression to the
// one-line-of-text behaviour still fails it by 3x.
test("the loading skeleton holds the page still while the snapshot is in flight", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  // Held back deliberately: with an instant stub the skeleton is never painted,
  // so the test would pass on a page that has no skeleton at all.
  await page.route("**/api/dashboards/regime-snapshots*", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(regimeDto()) });
  });

  await page.addInitScript(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput) (window as any).__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  await page.goto("/regime");
  await expect(page.locator(".rv__skel")).toBeVisible();
  await expect(page.locator(".rv__panel-card").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);

  const cls = await page.evaluate(() => (window as any).__cls as number);
  expect(cls, `cumulative layout shift on /regime was ${cls.toFixed(4)}`).toBeLessThan(0.1);
});

test("regime dashboard matches its visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page);
  await page.goto("/");
  await navigate(page, "/regime");

  // Deterministic capture: wait for the enriched view + every chart canvas, let
  // fonts settle, and hold the Chart.js paints (all use animation:false anyway).
  await expect(page.locator(".rv__bt-card:visible")).toHaveCount(3);
  await expect(page.locator(".rv__spark-svg").first()).toBeVisible();
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(500);

  await expect(page).toHaveScreenshot("regime-full.png", {
    fullPage: true,
    animations: "disabled",
    mask: [page.locator(".rv__hero-art")],
    maxDiffPixelRatio: 0.01,
  });
});

// A chart with nothing to draw says so (.rm-nodata) over its own box. The
// history line needs two readings: with one, Chart.js drew its axes around
// nothing, and with none the canvas was left blank. It is not drawn at all now,
// since an empty Chart.js still paints gridlines under the empty state.
test("a history of one reading shows the empty chart, not axes around nothing", async ({ page }) => {
  await stub(page);
  const dto = regimeDto();
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...dto, history: dto.history.slice(-1) }) }));
  await page.goto("/");
  await navigate(page, "/regime");

  const empty = page.locator(".rv__chart-card .rm-nodata");
  await expect(empty.locator(".rm-nodata__h")).toHaveText("Not enough data yet");
  await expect(empty.locator(".rm-nodata__d")).toHaveText("One reading so far");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drawn = await page.evaluate(() => !!(window as any).Chart.getChart(document.querySelector(".rv__chart canvas")));
  expect(drawn).toBe(false);
});

// A failed read leaves no dashboard to render. Its place holds the empty
// chart, under the outage line (api-unreachable.spec.ts), instead of the
// methodology rising into a blank page.
test("a failed read holds the dashboard's place with the empty chart", async ({ page }) => {
  await stub(page);
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "database unavailable" }) }));
  await page.goto("/");
  await navigate(page, "/regime");

  await expect(page.locator(".rv__error")).toBeVisible();
  await expect(page.locator(".rv__body > .rm-nodata .rm-nodata__h")).toHaveText("No data available");
  await expect(page.locator(".rv__dash")).toHaveCount(0);
});

// The baseline above is captured at ONE width and cannot see this: a panel
// table wider than the card holding it. That had been true at every viewport
// under about 1250px — the grid went three-across from 768px and the card's
// `overflow: hidden` ate whatever did not fit, so the Weight column was simply
// absent, with nothing to show it was missing. The clip is gone now (the header
// tooltips have to be able to leave the card), so an overflow would spill
// past it rather than hide. So the fit is asserted rather than trusted.
//
// The panels sit one at a time behind tabs, so each is checked while its tab is
// open (a hidden card measures 0 and would pass without being looked at).
// 700 is the narrowest width before a card scrolls instead; 1440 is the width
// the visual baseline is captured at.
const FIT_WIDTHS = [1440, 1024, 900, 700];

test("each panel table fits its card, at every width, with its tab open", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: FIT_WIDTHS[0], height: 900 });
  await page.goto("/");
  await navigate(page, "/regime");
  await expect(page.locator(".rv__spark-svg").first()).toBeVisible();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);

  for (const width of FIT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForTimeout(250);

    for (let t = 0; t < 3; t++) {
      await tabs.nth(t).click();
      const fit = await page.evaluate(() =>
        [...document.querySelectorAll(".rv__panel-card")].filter((c) => (c as HTMLElement).offsetParent).map((card) => {
          const table = card.querySelector("table") as HTMLElement;
          return {
            card: Math.round(card.getBoundingClientRect().width),
            table: Math.round(table.getBoundingClientRect().width),
          };
        }));
      expect(fit.length, `one panel shown at ${width}px, tab ${t}`).toBe(1);
      expect(fit[0]!.card, `panel ${t} has width at ${width}px`).toBeGreaterThan(0);
      expect(fit[0]!.table, `panel ${t} table vs card at ${width}px`).toBeLessThanOrEqual(fit[0]!.card);
    }

    // A tooltip bubble is `visibility: hidden` at rest, which still lays out and
    // still counts toward the document's scroll width — an unclamped one on the
    // rightmost column gave the whole page a horizontal scrollbar before anyone
    // hovered anything. Hence .rm-tip--end on both header tips.
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(doc.scrollWidth, `no horizontal page overflow at ${width}px`).toBeLessThanOrEqual(doc.innerWidth);
  }
});

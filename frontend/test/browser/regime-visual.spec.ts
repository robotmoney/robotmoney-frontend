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

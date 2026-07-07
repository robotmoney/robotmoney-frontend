// Seam spec for the frontend-consolidation full-bleed hero fix (issue #52).
// This dev-scout pass (issue #62) reserves the frontend/test/browser/hero-width.spec.ts
// path and its testDir wiring so #52's real CSS/markup diff can land with
// bounding-box width/x-offset assertions added on top of this scaffold. For
// now it is a real, executing placeholder: each of the three affected routes
// (/tokenomics, /blog, /faq) loads through the SPA router with zero console
// errors, using the same harness pattern as spa.spec.ts (vendor CDN scripts
// fulfilled from node_modules; backend serves index.html for any client
// route, see backend/src/api/index.ts).
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

test.beforeEach(async ({ page }) => {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
});

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  // Let pending module/CDN failures reach the browser event loop.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual([]);
}

const routes: Array<{ path: string; heroSelector: string }> = [
  { path: "/tokenomics", heroSelector: ".tok__hero" },
  { path: "/blog", heroSelector: ".blog-idx__hero" },
  { path: "/faq", heroSelector: ".faq__hero" },
];

for (const { path, heroSelector } of routes) {
  test(`${path} loads its hero with zero console errors`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);

    await page.goto(path);
    await expect(page.locator(heroSelector)).toBeVisible();

    await expectNoBrowserErrors(errors);
  });
}

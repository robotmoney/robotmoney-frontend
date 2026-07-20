import { join } from "node:path";
import type { Page } from "@playwright/test";

// Same vendor-script interception as spa.spec.ts: serve Alpine (+ chart/p5)
// from node_modules so the SPA boots without reaching a CDN. Shared by
// admin-view.spec.ts (fully mocked admin-API coverage) and admin-live.spec.ts
// (issue #185 — live-backend admin coverage, zero admin-endpoint mocking).
//
// Deliberately NOT named *.spec.ts / *.test.ts: playwright.config.ts's
// default testMatch would otherwise pick this file up as its own test file,
// and Playwright refuses to let one discovered test file import another
// (`test file "X.spec.ts" should not import test file "Y.spec.ts"`) — which
// is exactly why this helper lives in its own plain module rather than being
// imported directly out of admin-view.spec.ts.
const vendorScripts: Record<string, string> = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

export async function mockVendorScripts(page: Page): Promise<void> {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
}

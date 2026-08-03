// Full-bleed hero width spec for the frontend-consolidation fix (issue #52).
// The tokenomics, blog, and faq page heroes were nested inside their
// width-constrained content containers (max-width 1100px/1000px/840px), which
// clipped each hero's background/canvas art to the container instead of the
// full-bleed pattern already used on home/performance/allocation/media/regime/
// swarm (width:100vw with negative margins to escape the container, while
// inner text keeps its own max-width). This spec pins that fix:
//   - the hero element spans the full viewport width, flush to the left edge;
//   - the hero title stays within the page's content max-width, proving the
//     inner text/CTA content is NOT also full-bleed.
// It runs through the SPA router with the same harness as spa.spec.ts (vendor
// CDN scripts fulfilled from node_modules; the backend serves index.html for
// any client route, see backend/src/api/index.ts) and is picked up
// automatically by the required e2e CI job (scripts/lib/demo-main.ts runs the
// full `bun run test:browser` suite against the demo backend).
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

// AC viewport: 1280x900. Full-bleed width is asserted against
// document.documentElement.clientWidth (excludes any scrollbar) rather than a
// hard-coded 1280 so the check stays correct if the runner reserves scrollbar
// space.
const VIEWPORT = { width: 1280, height: 900 };

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
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

// Each affected route: its full-bleed hero, the hero title that must stay
// constrained, and that page's existing content max-width (px).
const routes: Array<{
  path: string;
  heroSelector: string;
  titleSelector: string;
  contentMaxWidth: number;
}> = [
  { path: "/tokenomics", heroSelector: ".tok__hero", titleSelector: ".tok__h1", contentMaxWidth: 1280 },
  { path: "/blog", heroSelector: ".blog-idx__hero", titleSelector: ".blog-idx__title", contentMaxWidth: 1000 },
  { path: "/faq", heroSelector: ".faq__hero", titleSelector: ".faq__title", contentMaxWidth: 840 },
];

// Padding tolerance (3rem @16px = 48px) added to the content max-width when
// asserting the title stays constrained, so the check stays a meaningful
// "inner text is not full-bleed" assertion rather than a pixel-exact one.
const PADDING_TOLERANCE = 48;

for (const { path, heroSelector, titleSelector, contentMaxWidth } of routes) {
  test(`${path} hero is full-bleed with constrained inner text`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);

    await page.goto(path);
    const hero = page.locator(heroSelector);
    const title = page.locator(titleSelector);
    await expect(hero).toBeVisible();
    await expect(title).toBeVisible();

    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const heroBox = await hero.boundingBox();
    const titleBox = await title.boundingBox();
    expect(heroBox, `${heroSelector} should have a bounding box`).not.toBeNull();
    expect(titleBox, `${titleSelector} should have a bounding box`).not.toBeNull();

    // AC1: hero spans the full viewport width (within 2px).
    expect(
      Math.abs(heroBox!.width - clientWidth),
      `${heroSelector} width ${heroBox!.width} should be within 2px of clientWidth ${clientWidth}`,
    ).toBeLessThanOrEqual(2);

    // AC2: hero is flush with the left viewport edge, not inset inside the
    // page's content container.
    expect(
      heroBox!.x,
      `${heroSelector} left offset ${heroBox!.x} should be <= 1px (flush to edge)`,
    ).toBeLessThanOrEqual(1);

    // AC3: the hero title stays within the page's content max-width, proving
    // the inner text/CTA content is not also full-bleed.
    expect(
      titleBox!.width,
      `${titleSelector} width ${titleBox!.width} should stay within content max-width ${contentMaxWidth} (+${PADDING_TOLERANCE}px padding tolerance)`,
    ).toBeLessThanOrEqual(contentMaxWidth + PADDING_TOLERANCE);

    await expectNoBrowserErrors(errors);
  });
}

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

test("renders allocation and dynamic committee routes through Alpine", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const today = new Date().toISOString().slice(0, 10);

  await page.goto("/");
  await page.evaluate(() => {
    history.pushState({}, "", "/allocation");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  // The allocationView factory draws the strategy/vault/wallet pie canvases.
  await expect(page.locator("canvas").first()).toBeVisible();
  // Vault-economics content is served by the in-CI deterministic Base RPC stub
  // (issue #48): the stub's fixed totalAssets fixture ($84,320.12) drives the
  // hero Total AUM, so /allocation renders live-endpoint-derived content with
  // ZERO live Base mainnet calls. Auto-retries while the async fetch settles.
  await expect(page.locator(".alloc-aum__value")).toHaveText("$84,320");

  // Test performance page with Wallet Performance heading
  await page.evaluate(() => {
    history.pushState({}, "", "/performance");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: /Wallet Performance/, exact: false })).toBeVisible();

  await page.goto("/committee/members/athena");
  await expect(page.locator(".profile-name")).toHaveText("Athena");
  await expect(page.locator(".profile-role")).not.toHaveText("");

  await page.goto(`/committee/${today}/woon`);
  await expect(page.locator(".session-title")).toHaveText("Woon Treasury");
  await expect(page.locator(".session-submissions tbody tr")).toHaveCount(3);

  await expectNoBrowserErrors(errors);
});

test("latest navigation wins when an earlier fragment response is delayed", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.goto("/");

  await page.route("**/views/committee/member.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.evaluate(() => {
    history.pushState({}, "", "/committee/members/athena");
    window.dispatchEvent(new PopStateEvent("popstate"));
    history.pushState({}, "", "/allocation");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  await expect(page.locator(".profile-name")).toHaveCount(0);

  await expectNoBrowserErrors(errors);
});

test("navigation destroys Chart.js and p5 resources from the previous view", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.goto("/");
  await page.evaluate(() => {
    history.pushState({}, "", "/allocation");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const allocCanvas = page.locator(".rm-chart canvas").first();
  await expect(allocCanvas).toBeVisible();
  const chartId = await allocCanvas.evaluate((canvas) => {
    const chart = window.Chart?.getChart(canvas as HTMLCanvasElement);
    if (!chart) throw new Error("allocation Chart.js instance was not created");
    return chart.id;
  });

  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(page.locator(".rm-chart canvas")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate((id) => Boolean(window.Chart?.instances?.[id]), chartId)
  ).toBe(false);

  await page.evaluate(() => {
    history.pushState({}, "", "/blog");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const p5Canvas = page.locator(".hero-art__canvas canvas").first();
  await expect(p5Canvas).toBeVisible();
  const handle = await p5Canvas.elementHandle();
  if (!handle) throw new Error("p5 canvas was not created");

  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect.poll(() => handle.evaluate((canvas) => canvas.isConnected)).toBe(false);

  await expectNoBrowserErrors(errors);
});

declare global {
  interface Window {
    Chart?: {
      getChart(canvas: HTMLCanvasElement): { id: string } | undefined;
      instances?: Record<string, unknown>;
    };
  }
}

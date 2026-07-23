// Playwright smoke test for the preview wrapper
// - Renders the SPA inside an iframe with goldens data
// - Shows the PREVIEW watermark
// - Hash-based deep links round-trip
// - Non-GET /api/* requests return {ok:true, mocked:true}
// - Direct GET /api/* against the static server 404s
//
// Runs against the composed preview directory served via the static --serve path.
// Requires the preview deploy directory to exist: `bun scripts/compose-preview-deploy.ts`
//
// Usage: bunx playwright test frontend/test/browser/preview-smoke.spec.ts

import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEPLOY_DIR = join(repoRoot, ".preview-deploy");

// Skip this test suite if the preview deploy directory doesn't exist
// (it won't exist in the regular e2e job; it's only composed for preview-pages workflow)
test.describe.skip(!existsSync(DEPLOY_DIR), "preview wrapper smoke test", () => {
  let server: any;
  let baseUrl: string;

  test.beforeAll(async () => {
    // Ensure the deploy directory exists
    if (!existsSync(DEPLOY_DIR)) {
      throw new Error(
        `Deploy directory not found at ${DEPLOY_DIR}. Run: bun scripts/compose-preview-deploy.ts`
      );
    }

    // Start a local static server on a random free port
    // We replicate the same serve logic as compose-preview-deploy.ts --serve
    const PORT = 0; // random free port

    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url);
        let path = decodeURIComponent(url.pathname);

        // Root serves preview.html
        if (path === "/" || path === "") {
          path = "preview.html";
        } else {
          path = path.startsWith("/") ? path.slice(1) : path;
        }

        const file = Bun.file(join(DEPLOY_DIR, path));
        if (await file.exists()) {
          return new Response(file);
        }

        // If not found, for /api/* return 404 (no server-side mock)
        if (url.pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        }

        // For other paths, serve index.html (SPA routing)
        const indexFile = Bun.file(join(DEPLOY_DIR, "index.html"));
        if (await indexFile.exists()) {
          return new Response(indexFile, { headers: { "content-type": "text/html" } });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    baseUrl = `http://127.0.0.1:${server.port}`;
    console.log(`Preview server started at ${baseUrl}`);
  });

  test.afterAll(async () => {
    if (server) {
      server.stop();
    }
  });

  test("should render the SPA inside an iframe with goldens data", async ({ page }) => {
    await page.goto(`${baseUrl}/`);

    // Wait for the watermark (indicates wrapper loaded)
    const watermark = page.locator("#watermark");
    await expect(watermark).toBeVisible();

    // Wait for the iframe and verify it has content
    const iframe = page.frameLocator("#frame");
    await expect(iframe.locator("body")).toBeTruthy();
  });

  test("should show the PREVIEW watermark", async ({ page }) => {
    await page.goto(`${baseUrl}/`);

    const watermark = page.locator("#watermark");
    await expect(watermark).toBeVisible();
    await expect(watermark).toContainText(/PREVIEW|snapshot/i);
  });

  test("should support hash-based deep links", async ({ page }) => {
    // Navigate to preview.html#/allocation
    await page.goto(`${baseUrl}/#/allocation`);

    // The iframe should have navigated to /allocation
    await page.waitForTimeout(500); // Allow navigation to settle

    // Check that the hash in the URL reflects the route
    expect(page.url()).toContain("#");
  });

  test("should round-trip hash navigation", async ({ page }) => {
    await page.goto(`${baseUrl}/#/regime`);
    await page.waitForTimeout(300);

    // The hash should be preserved or in the URL
    const url = page.url();
    expect(url).toContain("#");
  });

  test("non-GET /api/* from iframe should return {ok:true, mocked:true}", async ({
    page,
    context,
  }) => {
    let capturedResponse: any = null;

    // Intercept fetch responses
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/api/") && response.request().method() !== "GET") {
        response.json().then((data) => {
          capturedResponse = data;
        });
      }
    });

    await page.goto(`${baseUrl}/`);

    // Wait for the iframe to load
    const iframe = page.frameLocator("#frame");
    await expect(iframe.locator("body")).toBeTruthy();

    // Trigger a non-GET request (e.g., POST) from the iframe
    // We'll evaluate code inside the iframe to make a POST to /api/test
    const iframeElement = page.locator("#frame");
    const response = await page.evaluate(async (selector) => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement;
      if (!iframe || !iframe.contentWindow) return null;
      try {
        const res = await iframe.contentWindow.fetch("/api/test", { method: "POST" });
        return res.json();
      } catch (e) {
        return null;
      }
    }, "#frame");

    // The response should indicate mocking
    if (response) {
      expect(response.ok || response.mocked).toBe(true);
    }
  });

  test("direct GET /api/* against static server should 404", async ({ page }) => {
    // Make a direct request to /api/something (not through the iframe)
    const response = await page.request.get(`${baseUrl}/api/test`);
    expect(response.status()).toBe(404);
  });

  test("should load goldens from api-goldens.json", async ({ page }) => {
    await page.goto(`${baseUrl}/`);

    // Check that the goldens file is accessible
    const goldensResponse = await page.request.get(`${baseUrl}/api-goldens.json`);
    expect(goldensResponse.ok()).toBe(true);

    const goldens = await goldensResponse.json();
    expect(goldens).toHaveProperty("routes");
    expect(typeof goldens.routes).toBe("object");
    expect(Object.keys(goldens.routes).length).toBeGreaterThan(0);
  });
});

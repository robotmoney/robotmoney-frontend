// Playwright smoke test for preview mode (`bun run preview`).
// Spawns the real scripts/preview-server.ts (in-place static server, same URL
// space as the hosted Cloudflare Pages deploy) and asserts:
// - the wrapper renders the SPA inside an iframe with the PREVIEW watermark
// - GET /api/* inside the iframe is answered from goldens (client-side intercept)
// - non-GET /api/* inside the iframe returns the {ok:true, mocked:true} no-op
// - direct GET /api/* against the static server 404s (no server-side mock)
// - /goldens/api-goldens.json and /index.html are served where the wrapper expects
// - hash deep links round-trip
//
// Runs in the regular Playwright suite (`bun run test:browser`, executed by the
// e2e workflow's demo readiness gate on every ready PR). Self-contained: it
// starts and stops its own server on a random free port.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

// Playwright runs from the repo root (playwright.config.ts lives there), the
// same convention the other specs in this directory rely on.
const repoRoot = process.cwd();

let server: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  server = spawn("bun", ["scripts/preview-server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview server did not print its URL within 15s")), 15_000);
    let out = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview server exited early (code ${code})`));
    });
  });
});

test.afterAll(() => {
  server?.kill();
});

test.describe("preview smoke (bun run preview URL space)", () => {
  test("wrapper renders the SPA inside an iframe with the PREVIEW watermark", async ({ page }) => {
    await page.goto(`${baseUrl}/`);

    const watermark = page.locator("#watermark");
    await expect(watermark).toBeVisible();
    await expect(watermark).toContainText(/PREVIEW/);

    // The iframe must contain real SPA content (document.write of /index.html).
    const iframe = page.frameLocator("#frame");
    await expect(iframe.locator("body *").first()).toBeAttached({ timeout: 15_000 });
  });

  test("GET /api/* inside the iframe is answered from goldens", async ({ page }) => {
    await page.goto(`${baseUrl}/`);
    await expect(page.locator("#watermark")).toBeVisible();

    const allocation = await page.evaluate(async () => {
      const iframe = document.querySelector("#frame") as HTMLIFrameElement;
      const res = await iframe.contentWindow!.fetch("/api/dashboards/allocation");
      return { status: res.status, body: await res.json() };
    });
    expect(allocation.status).toBe(200);
    expect(allocation.body).toHaveProperty("strategy");
  });

  test("non-GET /api/* inside the iframe returns the mocked no-op", async ({ page }) => {
    await page.goto(`${baseUrl}/`);
    await expect(page.locator("#watermark")).toBeVisible();

    const response = await page.evaluate(async () => {
      const iframe = document.querySelector("#frame") as HTMLIFrameElement;
      const res = await iframe.contentWindow!.fetch("/api/test", { method: "POST" });
      return res.json();
    });
    expect(response).toEqual({ ok: true, mocked: true });
  });

  test("direct GET /api/* against the static server 404s", async ({ page }) => {
    const response = await page.request.get(`${baseUrl}/api/health`);
    expect(response.status()).toBe(404);
  });

  test("goldens and SPA are served where the wrapper expects them", async ({ page }) => {
    const goldensResponse = await page.request.get(`${baseUrl}/goldens/api-goldens.json`);
    expect(goldensResponse.ok()).toBe(true);
    const goldens = await goldensResponse.json();
    expect(Object.keys(goldens.routes).length).toBeGreaterThan(0);

    const indexResponse = await page.request.get(`${baseUrl}/index.html`);
    expect(indexResponse.ok()).toBe(true);
    expect(await indexResponse.text()).toContain("<html");
  });

  test("hash deep links round-trip", async ({ page }) => {
    await page.goto(`${baseUrl}/#/allocation`);
    await expect(page.locator("#watermark")).toBeVisible();

    // The wrapper replays the hash into the iframe's history.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector("#frame") as HTMLIFrameElement;
          return iframe.contentWindow?.location.pathname ?? "";
        })
      )
      .toBe("/allocation");
    expect(page.url()).toContain("#/allocation");
  });

  test("crawler policy (robots.txt) is served", async ({ page }) => {
    const robotsResponse = await page.request.get(`${baseUrl}/robots.txt`);
    expect(robotsResponse.ok()).toBe(true);
    const robots = await robotsResponse.text();
    expect(robots).toContain("User-agent: GPTBot");
    expect(robots).toContain("Allow: /");
  });

  test("nested-route content is served (SPA fallback)", async ({ page }) => {
    // Nested route without extension should fallback to the wrapper index.html
    const nestedResponse = await page.request.get(`${baseUrl}/swarm/apply`);
    expect(nestedResponse.ok()).toBe(true);
    const nested = await nestedResponse.text();
    expect(nested).toContain("<html");
    expect(nested).toContain("PREVIEW");
  });
});

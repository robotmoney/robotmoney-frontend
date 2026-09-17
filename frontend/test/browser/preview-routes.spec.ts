// Every route in sitemap.xml loads inside the preview wrapper with ZERO
// console errors and zero uncaught exceptions. This is the web client's own
// merge gate (.github/workflows/web-client.yml): the page must load at all,
// and the Chrome console must stay clean. Nothing here needs a backend,
// Docker, or the network — the wrapper answers /api/* from goldens.
//
// PREVIEW_API=prod|stage|<origin> runs the SAME sweep with the wrapper's
// `?api=` switch pointed at a live api. That run is advisory in CI: a live
// host being down says nothing about the client, so the workflow marks the
// step continue-on-error and reports it in the job summary instead of
// blocking the merge.
//
// Each route is its own test, so the report names the route that broke.
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const ORIGIN = "https://robotmoney.network";

// Same derivation scripts/prerender.ts uses: the sitemap is the route list.
function sitemapRoutes(): string[] {
  const xml = readFileSync(join(repoRoot, "frontend/public/sitemap.xml"), "utf8");
  const pattern = new RegExp(`<loc>${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^<]*)</loc>`, "g");
  return Array.from(xml.matchAll(pattern), (m) => m[1] || "/");
}

const api = process.env.PREVIEW_API ?? "fixtures";
const query = api === "fixtures" ? "" : `?api=${encodeURIComponent(api)}`;

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

const routes = sitemapRoutes();

test.describe(`every sitemap route loads in the preview (api: ${api})`, () => {
  test("the sitemap is not empty — the sweep cannot be vacuously green", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  for (const route of routes) {
    test(`${route} renders with a clean console`, async ({ page }) => {
      const problems: string[] = [];
      let notFoundFetched = false;
      page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
      });
      // router.js falls back to views/not-found.html when a route's own view
      // fragment fails to load; a sitemap route must never take that path.
      page.on("request", (req) => {
        if (new URL(req.url()).pathname.endsWith("/not-found.html")) notFoundFetched = true;
      });

      await page.goto(`${baseUrl}/${query}#${route}`);
      await expect(page.locator("#watermark")).toBeVisible();

      // The wrapper records which api it resolved, so a typo in `?api=` cannot
      // quietly run the fixtures sweep under a live label.
      const resolved = await page.evaluate(() => document.documentElement.dataset.previewApi);
      if (api === "fixtures") expect(resolved).toBe("fixtures");
      else expect(resolved, `wrapper did not resolve ?api=${api} to a live origin`).toMatch(/^https?:\/\//);

      // Deep link replayed into the iframe, and the router rendered SOMETHING
      // into <main id="view"> for it.
      await expect
        .poll(() => page.evaluate(() => (document.querySelector("#frame") as HTMLIFrameElement).contentWindow?.location.pathname ?? ""))
        .toBe(route);
      const view = page.frameLocator("#frame").locator("main#view > *");
      await expect(view.first()).toBeAttached({ timeout: 15_000 });
      await page.waitForLoadState("networkidle");

      expect(notFoundFetched, `${route} rendered the not-found view`).toBe(false);
      expect(problems, `${route} logged errors:\n  ${problems.join("\n  ")}`).toEqual([]);
    });
  }
});

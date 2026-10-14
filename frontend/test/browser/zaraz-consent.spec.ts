// Executes the production SPA with intercepted same-origin Zaraz. Uses the
// actual nginx CSP as the browser response header; never contacts Cloudflare/GA.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const PUB = join(ROOT, "frontend/public");
const ORIGIN = "https://robotmoney.network";
const nginx = readFileSync(join(ROOT, "website-server/nginx.conf"), "utf8");
const CSP = /add_header Content-Security-Policy "([^"]+)"/.exec(nginx)![1];
const shell = readFileSync(join(PUB, "index.html"), "utf8");
const goldens = JSON.parse(readFileSync(join(ROOT, "goldens/api-goldens.json"), "utf8")).routes;
const VENDORS: Record<string, string> = {
  "/assets/js/vendor/alpinejs-3.14.9.min.js": "node_modules/alpinejs/dist/cdn.min.js",
  "/assets/js/vendor/chart-4.5.1.umd.min.js": "node_modules/chart.js/dist/chart.umd.min.js",
  "/assets/js/vendor/p5-1.11.2.min.js": "node_modules/p5/lib/p5.min.js",
};
const fixture = `window.zaraz = {
  consent: { APIReady: true, purposes: { analytics: {} }, modal: false, set(choices) { this.choices = choices; } },
  track(event, fields) { return fetch('/cdn-cgi/zaraz/t', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,fields})}); }
}; document.dispatchEvent(new Event('zarazConsentAPIReady'));`;

async function setup(page: Page, options: { accepted?: boolean; enabled?: boolean; blocked?: boolean; unavailable?: boolean; origin?: string } = {}) {
  const origin = options.origin || ORIGIN;
  const loads: string[] = [];
  const events: any[] = [];
  const documents: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  if (options.accepted) await page.addInitScript(() => localStorage.setItem("rm_analytics_consent", JSON.stringify({ version: 1, choice: "accepted" })));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/cdn-cgi/zaraz/i.js") {
      loads.push(url.pathname);
      if (options.blocked) return route.abort();
      return route.fulfill({ contentType: "text/javascript", body: options.unavailable ? "/* no API */" : fixture });
    }
    if (url.pathname === "/cdn-cgi/zaraz/t") {
      events.push(request.postDataJSON());
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/analytics-config.js")) return route.fulfill({ contentType: "text/javascript", body: `export const analyticsConfig = {enabled:${options.enabled !== false},purposeId:'analytics'};` });
    if (url.pathname === "/api/admin/is-claimed") return route.fulfill({ json: { claimed: true } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "0.5.0" } });
    if (url.pathname === "/version.json") return route.fulfill({ json: { version: "0.1.0", apiRange: "^0.5.0" } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: goldens[url.pathname] ?? {} });
    if (request.isNavigationRequest()) {
      documents.push(url.pathname);
      return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": CSP }, body: shell });
    }
    const file = VENDORS[url.pathname] ? join(ROOT, VENDORS[url.pathname]) : join(PUB, url.pathname);
    if (existsSync(file)) return route.fulfill({ path: file, contentType: extname(file) === ".js" ? "text/javascript" : undefined });
    return route.fulfill({ status: 404, body: "not found" });
  });
  return { loads, events, documents, errors, origin };
}

async function rendered(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("#view")).not.toBeEmpty();
}

async function spa(page: Page, path: string) {
  await page.evaluate(path => new Promise<void>(resolve => {
    window.addEventListener("rm:view-changed", () => resolve(), { once: true });
    history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate"));
  }), path);
}

test("consent controls persist rejection; accepted SPA views have final sanitized metadata", async ({ page }) => {
  const s = await setup(page);
  await rendered(page, ORIGIN + "/privacy?token=secret#private");
  expect(s.loads).toHaveLength(0); expect(s.events).toHaveLength(0);
  await page.getByRole("button", { name: "Reject analytics", exact: true }).click();
  await page.reload(); await expect(page.locator("#view")).not.toBeEmpty();
  await expect(page.getByRole("button", { name: "Accept analytics", exact: true })).toBeHidden();
  expect(s.loads).toHaveLength(0);
  await page.getByRole("button", { name: "Analytics preferences", exact: true }).click();
  await page.getByRole("button", { name: "Accept analytics", exact: true }).click();
  await expect.poll(() => s.events.length).toBe(1);
  expect(s.loads).toHaveLength(1);
  expect(s.events[0].fields.page_location).toBe(ORIGIN + "/privacy");
  expect(s.events[0].fields.page_title).toBe(await page.title());
  await spa(page, "/terms?email=private#secret");
  await expect.poll(() => s.events.length).toBe(2);
  expect(s.events[1].fields.page_path).toBe("/terms");
  expect(s.events[1].fields.page_title).toBe(await page.title());
  expect(JSON.stringify(s.events)).not.toMatch(/token=|email=|#secret|#private/);
  // Idempotent boot does not add another route listener or loader.
  await page.evaluate(async () => { const path = "/assets/js/app/analytics.js"; const module = await import(path); module.startAnalytics(); });
  await spa(page, "/privacy"); await expect.poll(() => s.events.length).toBe(3);
  expect(s.loads).toHaveLength(1);
  await page.getByRole("button", { name: "Analytics preferences", exact: true }).click();
  await page.getByRole("button", { name: "Reject analytics", exact: true }).click();
  await expect.poll(() => s.documents.length).toBe(3);
  await expect(page.locator("#view")).not.toBeEmpty();
  await spa(page, "/terms");
  expect(s.events).toHaveLength(3); expect(s.loads).toHaveLength(1);
  expect(s.errors).toEqual([]);
});

test("accepted reload sends exactly one initial pageview", async ({ page }) => {
  const s = await setup(page, { accepted: true });
  await rendered(page, ORIGIN + "/privacy");
  await expect.poll(() => s.events.length).toBe(1);
  await page.reload(); await expect.poll(() => s.events.length).toBe(2);
  expect(s.loads).toHaveLength(2); expect(s.errors).toEqual([]);
});

test("direct admin entry loads no Zaraz and sign-in remains available", async ({ page }) => {
  const s = await setup(page, { accepted: true });
  await rendered(page, ORIGIN + "/admin");
  await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
  expect(s.loads).toHaveLength(0); expect(s.events).toHaveLength(0);
});

test("public link and history entry to privileged routes replace document", async ({ page }) => {
  const s = await setup(page, { accepted: true });
  await rendered(page, ORIGIN + "/privacy"); await expect.poll(() => s.events.length).toBe(1);
  await page.evaluate(() => { const a = document.createElement("a"); a.href = "/admin"; a.textContent = "Test admin"; document.body.append(a); (window as any).publicMarker = true; });
  await page.getByRole("link", { name: "Test admin" }).click();
  await expect.poll(() => s.documents.length).toBe(2); await expect(page.locator("#view")).not.toBeEmpty();
  expect(await page.evaluate(() => (window as any).publicMarker)).toBeUndefined();
  expect(s.loads).toHaveLength(1); expect(s.events).toHaveLength(1);
  // Back to public starts a clean loader; forward to admin never injects it.
  await page.goBack(); await expect.poll(() => s.events.length).toBe(2);
  await page.goForward(); await expect(page).toHaveURL(ORIGIN + "/admin");
  await expect(page.locator("#view")).not.toBeEmpty();
  expect(s.loads).toHaveLength(2); expect(s.events).toHaveLength(2);
});

test("SPA popstate into privileged history entry reloads before rendering", async ({ page }) => {
  const s = await setup(page, { accepted: true });
  await rendered(page, ORIGIN + "/privacy"); await expect.poll(() => s.events.length).toBe(1);
  await page.evaluate(() => { (window as any).publicMarker = true; history.pushState({}, "", "/dashboard"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect.poll(() => s.documents.length).toBe(2);
  await expect(page.locator("#view")).not.toBeEmpty();
  expect(await page.evaluate(() => (window as any).publicMarker)).toBeUndefined();
  expect(s.loads).toHaveLength(1); expect(s.events).toHaveLength(1);
});

test("same-origin transport executes under production CSP, Google/GTM blocked", async ({ page }) => {
  const s = await setup(page, { accepted: true });
  await rendered(page, ORIGIN + "/privacy"); await expect.poll(() => s.events.length).toBe(1);
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", event => violations.push(event.blockedURI));
    const urls = ["https://www.googletagmanager.com/gtm.js?id=GTM-TEST", "https://www.google-analytics.com/analytics.js"];
    const blocked = await Promise.all(urls.map(src => new Promise<boolean>(resolve => {
      const script = document.createElement("script"); script.src = src;
      script.onerror = () => resolve(true); script.onload = () => resolve(false); document.head.append(script);
    })));
    return { blocked, violations };
  });
  expect(result.blocked).toEqual([true, true]);
  expect(result.violations).toEqual(expect.arrayContaining(["https://www.googletagmanager.com/gtm.js?id=GTM-TEST", "https://www.google-analytics.com/analytics.js"]));
  expect(s.events[0].event).toBe("rm_page_view");
});

for (const options of [{ blocked: true }, { unavailable: true }, { enabled: false }, { origin: "https://staging.robotmoney.network" }]) {
  test(`unavailable/disabled analytics leaves navigation functional ${JSON.stringify(options)}`, async ({ page }) => {
    const s = await setup(page, { ...options, accepted: true });
    await rendered(page, s.origin + "/privacy"); await spa(page, "/terms");
    expect(s.events).toHaveLength(0); expect(s.errors).toEqual([]);
    if (options.enabled === false || options.origin) expect(s.loads).toHaveLength(0);
  });
}

// The deposit page's wallet connect flow under the production CSP (issue 1615).
//
// Local preview sends no CSP, so a policy that blocks the wallet kit only shows
// after a deploy. Here every page answer carries WEBSITE_CSP, the policy the
// website-server sends (scripts/lib/website-image.ts, held equal to the
// Caddyfile and nginx.conf by website-csp.test.ts), on the production origin.
// Same-origin files come from frontend/public. The approved Reown services
// answer with mocks, so nothing leaves the machine. Every other origin is
// aborted by the route. One the CSP does not approve never reaches the route:
// the page refuses it first, and the refusal shows as a violation.
//
// The early access gate is not under test: access.js is served with GATE_ON
// false. The page then loads the vendored kit on Connect wallet and opens its
// modal, which is the flow a CSP mistake breaks.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { WEBSITE_CSP } from "../../../scripts/lib/website-image.ts";

const ROOT = process.cwd();
const PUB = join(ROOT, "frontend/public");
const ORIGIN = "https://robotmoney.network";
const shell = readFileSync(join(PUB, "index.html"), "utf8");
const goldens = JSON.parse(readFileSync(join(ROOT, "goldens/api-goldens.json"), "utf8")).routes;
const VENDORS: Record<string, string> = {
  "/assets/js/vendor/alpinejs-3.14.9.min.js": "node_modules/alpinejs/dist/cdn.min.js",
  "/assets/js/vendor/chart-4.5.1.umd.min.js": "node_modules/chart.js/dist/chart.umd.min.js",
  "/assets/js/vendor/p5-1.11.2.min.js": "node_modules/p5/lib/p5.min.js",
};

/** Hosts the CSP approves for the kit, answered here with mocks. */
const REOWN_HTTP = /^https:\/\/(rpc\.walletconnect\.(org|com)|api\.web3modal\.(org|com)|fonts\.reown\.com|mainnet\.base\.org)$/;
const UNAPPROVED = "https://unapproved.example.com/feed";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

/** A JSON-RPC answer that reads as "nothing there", enough for the kit to settle. */
function rpcAnswer(body: string | null): unknown {
  let req: unknown;
  try { req = JSON.parse(body || "null"); } catch { req = null; }
  const one = (r: { id?: number; method?: string }) => ({
    jsonrpc: "2.0",
    id: r?.id ?? 1,
    result: r?.method === "eth_chainId" ? "0x2105" : r?.method === "eth_blockNumber" ? "0x1" : "0x",
  });
  return Array.isArray(req) ? req.map(one) : one((req ?? {}) as { id?: number; method?: string });
}

async function setup(page: Page) {
  const approved: string[] = [];
  const unapproved: string[] = [];
  const sockets: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  await page.routeWebSocket(/^wss:\/\/relay\.walletconnect\.(org|com)\//, (ws) => {
    sockets.push(new URL(ws.url()).host);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) {
      if (url.origin === new URL(UNAPPROVED).origin) unapproved.push(url.href);
      if (!REOWN_HTTP.test(url.origin)) return route.abort();
      approved.push(`${url.host}${url.pathname}`);
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.host.startsWith("fonts.")) return route.fulfill({ status: 404, headers: cors, body: "" });
      if (url.host.startsWith("api.web3modal.")) return route.fulfill({ headers: cors, json: { data: [], count: 0 } });
      return route.fulfill({ headers: cors, json: rpcAnswer(request.postData()) });
    }
    if (url.pathname === "/assets/js/app/lib/deposit/access.js") {
      const src = readFileSync(join(PUB, url.pathname), "utf8").replace("export const GATE_ON = true;", "export const GATE_ON = false;");
      return route.fulfill({ contentType: "text/javascript", body: src });
    }
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "0.5.0" } });
    if (url.pathname === "/version.json") return route.fulfill({ json: { version: "0.1.0", apiRange: "^0.5.0" } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: goldens[url.pathname] ?? {} });
    if (request.isNavigationRequest()) {
      return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": WEBSITE_CSP }, body: shell });
    }
    const file = VENDORS[url.pathname] ? join(ROOT, VENDORS[url.pathname]) : join(PUB, url.pathname);
    if (existsSync(file)) return route.fulfill({ path: file, contentType: extname(file) === ".js" ? "text/javascript" : undefined });
    return route.fulfill({ status: 404, body: "not found" });
  });
  return { approved, unapproved, sockets };
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test("the deposit page opens the wallet kit under the production CSP", async ({ page }) => {
  const s = await setup(page);
  await page.goto(`${ORIGIN}/deposit`);
  await expect(page.locator(".dp__title")).toContainText("Robot Money Vault");

  await page.locator(".dp__panel .btn-primary:visible", { hasText: "Connect wallet" }).click();
  // The kit's modal is a web component; open, it shows its connect view.
  await expect(page.locator("w3m-modal")).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => !!document.querySelector("w3m-modal")?.shadowRoot?.querySelector("wui-flex, w3m-router")), { timeout: 15_000 }).toBe(true);

  // The kit reached the approved Reown services, and the policy blocked none of them.
  await expect.poll(() => s.approved.some((u) => u.startsWith("api.web3modal.org/")), { timeout: 15_000 }).toBe(true);
  expect(s.approved.some((u) => u.startsWith("rpc.walletconnect.org/"))).toBe(true);
  // Nothing the kit tried was refused: an origin missing from the policy would show here.
  expect(await violations(page)).toEqual([]);
});

test("an unapproved origin is blocked by the production CSP before it reaches the network", async ({ page }) => {
  const s = await setup(page);
  await page.goto(`${ORIGIN}/deposit`);
  await expect(page.locator(".dp__title")).toContainText("Robot Money Vault");

  const outcome = await page.evaluate(async (u) => {
    try { await fetch(u); return "fetched"; } catch { return "refused"; }
  }, UNAPPROVED);
  expect(outcome).toBe("refused");
  await expect.poll(() => violations(page)).toContain(`connect-src ${UNAPPROVED}`);
  // The CSP refused it in the page: the route never saw the request.
  expect(s.unapproved).toEqual([]);
});

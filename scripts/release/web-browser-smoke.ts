#!/usr/bin/env bun
// scripts/release/web-browser-smoke.ts — W11's browser smoke of a live site
// (D81 amendment, release-runbooks.md §12, ./web-release-lib.ts liveProblems).
//
// A headless Chromium from the repository's own @playwright/test loads each
// route from the control machine against the public origin, the way a visitor
// does, and records what went wrong on the page: an uncaught page error, a
// console.error, a same-origin request that failed or answered 4xx/5xx, a page
// that never reached the router's ready signal, and a route the router
// rendered as the not-found view. ./web-release-lib.ts pageProblems turns a
// report into the reasons W11 fails; this file only drives the browser.
//
// THE READY SIGNAL is the router's own: router.js render() sets
// `data-routed` on <html> once the route's view is in the DOM (the same
// signal frontend/test/browser/navigation.ts waits on). After it, the page is
// given until network idle (capped) for the view's data reads to land, so a
// failing api read the view makes is seen.
//
// READ ONLY. The smoke submits no form and clicks nothing. Every request the
// page itself makes with a method other than GET, HEAD or OPTIONS (an
// analytics beacon, a Turnstile post) is answered 204 inside the browser and
// listed as blocked, so a smoke never writes to production. (Answered, not
// aborted: an aborted request logs a console.error of its own.)
//
// CLOUDFLARE'S EDGE SCRIPTS ARE STUBBED. Cloudflare injects /cdn-cgi/ scripts
// (Zaraz analytics, the RUM beacon) at the edge; the release tree holds none of
// them. Measured against production on 2026-11-11, Zaraz's Google Analytics
// tool calls stats.g.doubleclick.net and www.google.com/ads, which the site's
// own CSP (connect-src) refuses, and each refusal is a console.error on every
// page. Every /cdn-cgi/ request is answered empty inside the browser instead,
// so a smoke neither fails on the edge's noise nor sends production analytics
// a page view.
//
//   bun scripts/release/web-browser-smoke.ts --origin https://robotmoney.network [--route /path]... [--budget-seconds 180] [--json]
//
// In a release it runs on the stage host, never on the control machine:
// ./stage-browser.ts copies it there as a bundle and runs it with --json.
//
// With no --route it visits the default routes (BROWSER_BASE_ROUTES and one
// swarm member page discovered from the public API) and prints each page's
// report and the problems found; it exits 1 when there is any.

/** A request that failed or answered >= 400; resourceType is Playwright's (document, script, fetch, media, ...). */
export interface FailedRequest {
  readonly url: string;
  readonly method: string;
  readonly status?: number;
  readonly failure?: string;
  readonly resourceType?: string;
}

/**
 * How W01 and W11 launch Chromium: headless, with Chromium's own sandbox ON.
 * Playwright passes --no-sandbox unless chromiumSandbox is true, and the
 * control machine holds the operator's production ssh access and a gh token
 * with admin rights, while the pages load third-party scripts and member
 * content. A host that cannot start the sandbox (Ubuntu 24.04's
 * kernel.apparmor_restrict_unprivileged_userns=1 with no AppArmor profile
 * granting the Playwright Chromium binary `userns`) fails the launch, and W01
 * refuses with that reason. The sandbox is never turned off to get past it.
 */
export const LAUNCH_OPTIONS = Object.freeze({ headless: true, chromiumSandbox: true });

/** One page's raw record. ./web-release-lib.ts pageProblems classifies it. */
export interface PageReport {
  readonly route: string;
  /** Where the browser ended up (the router may rewrite the address bar). */
  readonly finalUrl: string;
  /** Whether <html data-routed> appeared before the page's deadline. */
  readonly ready: boolean;
  /** Why the page did not get ready (a navigation error or the timeout), when it did not. */
  readonly readyDetail?: string;
  /** Whether the page reached network idle after it was ready (informational). */
  readonly idle: boolean;
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly string[];
  /** Same-origin and cross-origin requests that failed or answered >= 400. */
  readonly failedRequests: readonly FailedRequest[];
  /** Non-GET requests the page made, answered 204 inside the browser. */
  readonly blocked: readonly string[];
  /** Cloudflare edge (/cdn-cgi/) requests, answered empty inside the browser. */
  readonly stubbed: readonly string[];
  /** Whether the router fetched views/not-found.html for this route. */
  readonly notFoundView: boolean;
  readonly ms: number;
}

/** The browser half of W11: load each route, or (with no routes) only prove the browser launches. */
export type BrowserSmoke = (origin: string, routes: readonly string[], budgetMs: number) => Promise<PageReport[]>;

/** One page's ceiling inside the overall budget. */
const PAGE_MS = 45_000;
/** How long a ready page is given to reach network idle. */
const IDLE_MS = 15_000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** PURE. A Cloudflare edge script or beacon on the site's own host (/cdn-cgi/...), which the release does not ship. */
export function isEdgeScript(url: string, host: string): boolean {
  try {
    const u = new URL(url);
    return u.host === host && u.pathname.startsWith("/cdn-cgi/");
  } catch {
    return false;
  }
}

/**
 * The real browser smoke: one headless Chromium, a fresh context per route.
 * Throws when the browser cannot launch (W01 calls it with no routes to prove
 * that before anything is pushed). Routes the budget does not reach are
 * reported not ready, with the reason.
 */
export const runBrowserSmoke: BrowserSmoke = async (origin, routes, budgetMs) => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ ...LAUNCH_OPTIONS });
  const reports: PageReport[] = [];
  const start = Date.now();
  const host = new URL(origin).host;
  try {
    for (const route of routes) {
      const left = budgetMs - (Date.now() - start);
      if (left <= 1_000) {
        reports.push({ route, finalUrl: "", ready: false, readyDetail: `not visited: the ${Math.round(budgetMs / 1000)} s budget ran out`, idle: false, pageErrors: [], consoleErrors: [], failedRequests: [], blocked: [], stubbed: [], notFoundView: false, ms: 0 });
        continue;
      }
      const pageMs = Math.min(PAGE_MS, left);
      const t0 = Date.now();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const failedRequests: FailedRequest[] = [];
      const blocked: string[] = [];
      const stubbed: string[] = [];
      let notFoundView = false;
      await page.route("**/*", (r) => {
        const req = r.request();
        if (isEdgeScript(req.url(), host)) {
          stubbed.push(`${req.method()} ${new URL(req.url()).pathname}`);
          // An empty script for a GET; 204 for a beacon (a 200 answer to a POST is reported as net::ERR_ABORTED).
          return READ_METHODS.has(req.method()) ? r.fulfill({ status: 200, contentType: "text/javascript", body: "" }) : r.fulfill({ status: 204, body: "" });
        }
        if (READ_METHODS.has(req.method())) return r.continue();
        blocked.push(`${req.method()} ${req.url()}`);
        return r.fulfill({ status: 204, body: "" });
      });
      page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const at = m.location();
        consoleErrors.push(at.url ? `${m.text()} (${at.url}:${at.lineNumber})` : m.text());
      });
      page.on("request", (req) => {
        try {
          if (new URL(req.url()).host === host && new URL(req.url()).pathname === "/views/not-found.html") notFoundView = true;
        } catch { /* a data: or blob: url */ }
      });
      page.on("requestfailed", (req) => {
        failedRequests.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText ?? "failed", resourceType: req.resourceType() });
      });
      page.on("response", (res) => {
        if (res.status() >= 400) failedRequests.push({ url: res.url(), method: res.request().method(), status: res.status(), resourceType: res.request().resourceType() });
      });
      let ready = false;
      let readyDetail: string | undefined;
      let idle = false;
      try {
        await page.goto(`${origin}${route}`, { waitUntil: "load", timeout: pageMs });
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-routed"), null, { timeout: Math.max(1_000, pageMs - (Date.now() - t0)) });
        ready = true;
      } catch (e) {
        readyDetail = (e as Error).message.split("\n")[0];
      }
      if (ready) {
        try {
          await page.waitForLoadState("networkidle", { timeout: Math.max(1_000, Math.min(IDLE_MS, pageMs - (Date.now() - t0))) });
          idle = true;
        } catch { /* informational: a page that keeps polling never idles */ }
      }
      const finalUrl = page.url();
      await context.close();
      reports.push({ route, finalUrl, ready, readyDetail, idle, pageErrors, consoleErrors, failedRequests, blocked, stubbed, notFoundView, ms: Date.now() - t0 });
    }
  } finally {
    await browser.close();
  }
  return reports;
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let origin = "";
  let budgetMs = 180_000;
  let json = false;
  const routes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--origin") origin = argv[++i] ?? "";
    else if (a === "--route") routes.push(argv[++i] ?? "/");
    else if (a === "--budget-seconds") budgetMs = Number(argv[++i]) * 1000;
    else { console.error(`unknown argument ${a}`); return 2; }
  }
  if (!/^https?:\/\//.test(origin)) { console.error("usage: bun scripts/release/web-browser-smoke.ts --origin <url> [--route /path]... [--budget-seconds 180]"); return 2; }
  origin = origin.replace(/\/+$/, "");
  // --json: the stage host's half of W01, W06 and W11 (./stage-browser.ts runs it there over ssh). It loads exactly the
  // routes given (none: only launch, W01's probe) and prints the reports as one JSON line; the control machine judges them.
  if (json) {
    try {
      process.stdout.write(`${JSON.stringify(await runBrowserSmoke(origin, routes, budgetMs))}\n`);
      return 0;
    } catch (e) {
      const m = (e as Error).message;
      const { NOT_INSTALLED } = await import("./stage-browser-lib.ts");
      console.error(/Cannot find (package|module) '?@playwright\/test|Executable doesn't exist/.test(m) ? `${NOT_INSTALLED}: ${m.split("\n")[0]}` : m);
      return 1;
    }
  }
  const { BROWSER_BASE_ROUTES, discoverMemberRoute, pageProblems, smokePages } = await import("./web-release-lib.ts");
  const http = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.text() };
  };
  const notes: string[] = [];
  if (routes.length === 0) {
    routes.push(...BROWSER_BASE_ROUTES);
    const member = await discoverMemberRoute(origin, http);
    if ("route" in member) routes.splice(2, 0, member.route);
    else notes.push("note" in member ? member.note : `member discovery failed: ${member.error}`);
  }
  // Run by hand, every route is held to the changed-view rule: a route never judged (an /api/ 503 on every load) fails.
  const smoke = await smokePages(origin, routes, routes, runBrowserSmoke, () => Date.now(), budgetMs);
  for (const r of smoke.reports) {
    const p = pageProblems(origin, r);
    console.log(`${p.length === 0 ? "ok  " : "FAIL"} ${r.route} -> ${r.finalUrl || "(none)"} ${r.ms} ms${r.idle ? "" : " (no network idle)"}` +
      `${r.stubbed.length ? `; stubbed ${r.stubbed.length} edge request(s): ${[...new Set(r.stubbed)].join(", ")}` : ""}` +
      `${r.blocked.length ? `; answered ${r.blocked.length} non-GET in the browser: ${r.blocked.join(", ")}` : ""}`);
    const crossOrigin = r.failedRequests.filter((f) => { try { return new URL(f.url).origin !== origin; } catch { return true; } });
    for (const f of crossOrigin) console.log(`     (cross-origin, not counted) ${f.method} ${f.url} ${f.status ?? f.failure}`);
    for (const l of p) console.log(`     ${l}`);
  }
  for (const l of smoke.retried) console.log(`retried: ${l}`);
  for (const w of smoke.warnings) console.log(`WARNING ${w}`);
  for (const n of notes) console.log(`note: ${n}`);
  const problems = smoke.problems;
  console.log(problems.length === 0 ? `browser smoke passed: ${smoke.reports.length} pages on ${origin}` : `browser smoke FAILED: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();

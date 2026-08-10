import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { mockVendorScripts } from "./vendor-scripts.ts";

const ADMIN_PASSWORD = "demo-password";
const WEBAUTHN_BROWSER_URL = "https://esm.sh/@simplewebauthn/browser@13.3.0";

// The production surface imports SimpleWebAuthn directly from esm.sh. Browser
// coverage must drive that adapter boundary (rather than calling component
// methods directly), while a deterministic browser-side authenticator keeps
// this UI contract test independent of physical security hardware.
async function mockWebAuthnBrowser(page: Page): Promise<void> {
  await page.route(WEBAUTHN_BROWSER_URL, (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      const calls = window.__rmWebAuthnCalls ||= [];
      export async function startRegistration({ optionsJSON }) {
        calls.push({ kind: "registration", options: optionsJSON });
        return {
          id: "browser-registration-credential",
          rawId: "browser-registration-credential",
          type: "public-key",
          response: { clientDataJSON: "registration-client-data", attestationObject: "browser-attestation" },
        };
      }
      export async function startAuthentication({ optionsJSON }) {
        calls.push({ kind: "authentication", options: optionsJSON });
        return {
          id: "browser-authentication-credential",
          rawId: "browser-authentication-credential",
          type: "public-key",
          response: {
            clientDataJSON: "authentication-client-data",
            authenticatorData: "browser-authenticator-data",
            signature: "browser-signature",
            userHandle: null,
          },
        };
      }
    `,
  }));
}

// ── Fixture payloads for the mocked admin API (issue #157 / docs/plan-admin-
// surface.md §6.3). The real backend routes are delivered by issue #155; these
// browser tests exercise the frontend contract entirely against page.route
// mocks per the issue's own test-plan instruction, never a live backend. ──────

const OVERVIEW_FIXTURE = {
  queueCounts: { pending: 2, running: 1, succeeded: 40, failed: 1, dead: 1, cancelled: 0 },
  alerts: [
    { level: "dead", source: "queue", message: "1 job is dead and needs a manual retry." },
    { level: "stale", source: "research:late-cycle-signals", message: "late-cycle-signals is 3 days stale." },
  ],
  enabledAnalyticsSchedules: [
    { id: 1, kind: "regime.classify", cron: "30 22 * * *", nextRunAt: "2026-07-16T22:30:00.000Z" },
    { id: 2, kind: "research.refresh", cron: "0 23 * * *", nextRunAt: "2026-07-16T23:00:00.000Z" },
  ],
};

const EMPTY_OVERVIEW = { queueCounts: {}, alerts: [], enabledAnalyticsSchedules: [] };

// vendorScripts CDN interception is shared with admin-live.spec.ts (issue
// #185) via ./vendor-scripts.ts — mockAdminApi (issue #157) below re-lists
// the same URL→file pairs inline for its own single
// page.route("**/api/admin/**") catch-all matcher.
const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

// ── Queue dashboard fixtures (unchanged surface — /admin) ───────────────────

const JOBS_FIXTURE = {
  jobs: [
    { id: 42, kind: "research.refresh", status: "succeeded", priority: 0, attempts: 1, max_attempts: 5,
      run_after: "2026-07-13T20:00:00.000Z", locked_at: null, locked_by: null, last_error: null,
      created_at: "2026-07-13T19:59:00.000Z", updated_at: "2026-07-13T20:01:00.000Z" },
    { id: 41, kind: "regime.classify", status: "dead", priority: 0, attempts: 5, max_attempts: 5,
      run_after: "2026-07-13T19:50:00.000Z", locked_at: null, locked_by: null, last_error: "boom: upstream 500",
      created_at: "2026-07-13T19:40:00.000Z", updated_at: "2026-07-13T19:55:00.000Z" },
  ],
  schedules: [
    { id: 1, kind: "research.refresh", cron: "0 23 * * *", timezone: "UTC", enabled: true,
      last_enqueued_at: "2026-07-13T23:00:00.000Z", next_run_at: "2026-07-14T23:00:00.000Z" },
  ],
  summary: { byStatus: { succeeded: 1, dead: 1 }, byKind: { "research.refresh": 1, "regime.classify": 1 } },
};

const JOB_DETAIL_42 = {
  job: JOBS_FIXTURE.jobs[0],
  runs: [
    { id: 900, job_id: 42, kind: "research.refresh", started_at: "2026-07-13T20:00:00.000Z",
      finished_at: "2026-07-13T20:01:00.000Z", status: "succeeded", error: null,
      output: { ran: true, note: "analytics ok", signals: 7 } },
  ],
};

// A "dead" job — the only status the Retry control may act on. Its last_error
// text embeds markup that must never be interpreted as HTML by the view.
const JOB_DETAIL_41 = {
  job: JOBS_FIXTURE.jobs[1],
  runs: [
    { id: 899, job_id: 41, kind: "regime.classify", started_at: "2026-07-13T19:50:00.000Z",
      finished_at: "2026-07-13T19:52:00.000Z", status: "failed",
      error: "upstream 500: <img src=x onerror=alert(1)>", output: null },
  ],
};

const RUNS_FIXTURE = { runs: [...JOB_DETAIL_42.runs, ...JOB_DETAIL_41.runs] };

const RESEARCH_RUNS_FIXTURE = {
  items: [
    { id: "run-1", jobId: 42, jobKind: "research.refresh", attempt: 1, sourceMode: "live",
      asof: "2026-07-13", tools: ["channel-divergence", "late-cycle-signals"], currentStage: "report",
      status: "warning", warningCount: 1, startedAt: "2026-07-13T23:00:00.000Z", finishedAt: "2026-07-13T23:02:00.000Z" },
    { id: "run-2", jobId: 39, jobKind: "regime.classify", attempt: 1, sourceMode: "live",
      asof: "2026-07-13", tools: ["regime"], currentStage: "report",
      status: "succeeded", warningCount: 0, startedAt: "2026-07-13T22:30:00.000Z", finishedAt: "2026-07-13T22:31:00.000Z" },
  ],
  nextCursor: null,
};

const RESEARCH_RUN_DETAIL = {
  run: RESEARCH_RUNS_FIXTURE.items[1], // the regime run → publicReportHref = /regime
  stages: [
    { id: 1, toolId: "regime", stage: "access", sequence: 1, status: "succeeded",
      startedAt: "2026-07-13T22:30:00.000Z", summary: { sourceMode: "live", floorRows: 120 } },
    { id: 2, toolId: "regime", stage: "extract", sequence: 2, status: "succeeded",
      startedAt: "2026-07-13T22:30:05.000Z", summary: { fetched: 12, firstDate: "2020-01-01", lastDate: "2026-07-13" } },
    { id: 3, toolId: "regime", stage: "transform", sequence: 3, status: "warning",
      startedAt: "2026-07-13T22:30:10.000Z",
      // Embedded markup-shaped text — must render as inert text, never as a
      // real <script> element (issue #157 AC6).
      summary: { note: "<script>alert(1)</script> forward-filled 2 points" } },
    { id: 4, toolId: "regime", stage: "analyze", sequence: 4, status: "succeeded",
      startedAt: "2026-07-13T22:30:15.000Z", summary: { methodology: "v3", checksum: "abc123" } },
    { id: 5, toolId: "regime", stage: "store", sequence: 5, status: "succeeded",
      startedAt: "2026-07-13T22:30:20.000Z", summary: { table: "regime_snapshots", upserted: 1 } },
    { id: 6, toolId: "regime", stage: "report", sequence: 6, status: "failed",
      startedAt: "2026-07-13T22:30:25.000Z", error: "public route mismatch: checksum drift" },
  ],
  artifacts: [
    { id: 10, toolId: "regime", kind: "raw-series", artifactKey: "ism-pmi", checksum: "chk1",
      rowCount: 12, firstDate: "2026-06-01", lastDate: "2026-07-13", preview: [{ date: "2026-07-13", value: 48.7 }] },
  ],
};

function jsonReply(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

/** Records every X-Admin-Token header seen and every request path hit, and
 * answers the mocked admin API from the fixtures above. A single catch-all
 * matcher (rather than several overlapping page.route patterns) avoids the
 * registration-order footgun the old single-table test had to work around. */
function mockAdminApi(page: Page, overrides: { overview?: unknown; jobRetryStatus?: number } = {}) {
  const seenTokens: string[] = [];
  const requestedPaths: string[] = [];

  for (const [url, file] of Object.entries(vendorScripts)) {
    page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }

  page.route("**/api/admin/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    // The claim probe is unauthenticated; do not assert its X-Admin-Token presence.
    if (p !== "/api/admin/is-claimed") {
      seenTokens.push(req.headers()["x-admin-token"] ?? "");
    }
    requestedPaths.push(`${method} ${p}${url.search}`);

    if (method === "GET" && p === "/api/admin/is-claimed") return route.fulfill(jsonReply({ claimed: true }));
    if (method === "POST" && p === "/api/admin/auth") return route.fulfill(jsonReply({ ok: true }));
    if (method === "GET" && p === "/api/admin/overview") {
      return route.fulfill(jsonReply(overrides.overview ?? OVERVIEW_FIXTURE));
    }
    if (method === "GET" && p === "/api/admin/jobs") return route.fulfill(jsonReply(JOBS_FIXTURE));
    if (method === "POST" && /^\/api\/admin\/jobs\/\d+\/retry$/.test(p)) {
      return route.fulfill(jsonReply({ jobId: 777, auditRequestId: "aud-retry-1", existing: false }, overrides.jobRetryStatus ?? 202));
    }
    if (method === "GET" && /^\/api\/admin\/jobs\/\d+$/.test(p)) {
      const id = p.split("/").pop();
      return route.fulfill(jsonReply(id === "41" ? JOB_DETAIL_41 : JOB_DETAIL_42));
    }
    if (method === "GET" && p === "/api/admin/runs") return route.fulfill(jsonReply(RUNS_FIXTURE));
    if (method === "POST" && p === "/api/admin/research/rerun") {
      return route.fulfill(jsonReply({ jobId: 888, auditRequestId: "aud-rerun-1", existing: false }, 202));
    }
    if (method === "GET" && p === "/api/admin/research/runs") return route.fulfill(jsonReply(RESEARCH_RUNS_FIXTURE));
    if (method === "GET" && /^\/api\/admin\/research\/runs\/[^/]+$/.test(p)) {
      return route.fulfill(jsonReply(RESEARCH_RUN_DETAIL));
    }
    // Audit (issue #155) is exercised by admin-surface.spec.ts's dedicated
    // tests; mocked here too so a stray loadAudit() (e.g. via goSection)
    // never 403s and logs this suite's dashboard back out mid-test.
    if (method === "GET" && p === "/api/admin/audit") return route.fulfill(jsonReply({ items: [], nextCursor: null }));
    return route.fulfill(jsonReply({ error: `no mock for ${method} ${p}` }, 404));
  });

  return { seenTokens, requestedPaths };
}

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("table.adm-table").first()).not.toBeVisible();

  // Submit a password → POST /api/admin/auth (mocked ok) → dashboard loads.
  // Target by accessible name, not the shared .adm-input class — issue #155
  // added several more .adm-input filter fields (queue/audit) to the dashboard.
  await page.getByLabel("Admin password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".adm-nav")).toBeVisible();
}

test("admin view: login persists rm_admin_token and sends X-Admin-Token on every request", async ({ page }) => {
  const { seenTokens } = mockAdminApi(page);
  await login(page);

  const stored = await page.evaluate(() => sessionStorage.getItem("rm_admin_token"));
  expect(stored).toBe(ADMIN_PASSWORD);
  expect(seenTokens.length).toBeGreaterThan(0);
  for (const token of seenTokens) expect(token).toBe(ADMIN_PASSWORD);

  // The literal password/token value never appears in rendered page content.
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain(ADMIN_PASSWORD);
});

test("admin view: Security registers a passkey through the browser WebAuthn adapter", async ({ page }) => {
  await mockWebAuthnBrowser(page);
  mockAdminApi(page);

  const registrationOptions = {
    challenge: "register-browser-challenge",
    rp: { id: "localhost", name: "Robot Money" },
    user: { id: "admin", name: "admin", displayName: "Admin" },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  };
  let optionRequest: { method: string; token?: string } | null = null;
  let verificationRequest: { token?: string; body: unknown } | null = null;

  await page.route("**/api/admin/webauthn/register/options", (route) => {
    optionRequest = { method: route.request().method(), token: route.request().headers()["x-admin-token"] };
    return route.fulfill(jsonReply(registrationOptions));
  });
  await page.route("**/api/admin/webauthn/register/verify", (route) => {
    verificationRequest = {
      token: route.request().headers()["x-admin-token"],
      body: route.request().postDataJSON(),
    };
    return route.fulfill(jsonReply({ verified: true }));
  });

  await login(page);
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Register new Passkey", exact: true }).click();

  await expect(page.getByText("Passkey registered successfully.", { exact: true })).toBeVisible();
  expect(optionRequest).toEqual({ method: "GET", token: ADMIN_PASSWORD });
  expect(verificationRequest).toEqual({
    token: ADMIN_PASSWORD,
    body: {
      id: "browser-registration-credential",
      rawId: "browser-registration-credential",
      type: "public-key",
      response: { clientDataJSON: "registration-client-data", attestationObject: "browser-attestation" },
    },
  });
  await expect.poll(() => page.evaluate(() => (window as any).__rmWebAuthnCalls)).toEqual([
    { kind: "registration", options: registrationOptions },
  ]);
});

test("admin view: logged-out passkey sign-in stores its session and enters the protected surface", async ({ page }) => {
  await mockWebAuthnBrowser(page);
  const { seenTokens } = mockAdminApi(page);

  const authenticationOptions = {
    challenge: "authenticate-browser-challenge",
    rpId: "localhost",
    allowCredentials: [{ id: "browser-authentication-credential", type: "public-key" }],
  };
  let optionRequest: { method: string; token?: string } | null = null;
  let verificationRequest: { token?: string; body: unknown } | null = null;

  await page.route("**/api/admin/webauthn/auth/options", (route) => {
    optionRequest = { method: route.request().method(), token: route.request().headers()["x-admin-token"] };
    return route.fulfill(jsonReply(authenticationOptions));
  });
  await page.route("**/api/admin/webauthn/auth/verify", (route) => {
    verificationRequest = {
      token: route.request().headers()["x-admin-token"],
      body: route.request().postDataJSON(),
    };
    return route.fulfill(jsonReply({ verified: true, token: "passkey-session-token" }));
  });

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).click();

  await expect(page.locator(".adm-nav")).toBeVisible();
  await expect(page.getByRole("button", { name: "Security", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("rm_admin_token"))).toBe("passkey-session-token");
  // The existing admin helper always materializes its optional token header;
  // the unauthenticated ceremony routes must nevertheless accept this browser
  // request before the verified session exists.
  expect(optionRequest).toEqual({ method: "GET", token: "undefined" });
  expect(verificationRequest).toEqual({
    token: "null",
    body: {
      id: "browser-authentication-credential",
      rawId: "browser-authentication-credential",
      type: "public-key",
      response: {
        clientDataJSON: "authentication-client-data",
        authenticatorData: "browser-authenticator-data",
        signature: "browser-signature",
        userHandle: null,
      },
    },
  });
  await expect.poll(() => page.evaluate(() => (window as any).__rmWebAuthnCalls)).toEqual([
    { kind: "authentication", options: authenticationOptions },
  ]);
  expect(seenTokens).toContain("passkey-session-token");
});

test("admin view: overview alerts, tiles, and next-schedule table render from mocked data", async ({ page }) => {
  mockAdminApi(page);
  await login(page);

  // Overview is the default landing section after login.
  await expect(page.locator(".adm-nav__link--active")).toHaveText("Overview");
  await expect(page.getByText("1 job is dead and needs a manual retry.")).toBeVisible();
  await expect(page.getByText("late-cycle-signals is 3 days stale.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "regime.classify" }).first()).toBeVisible();

  const deadTile = page.locator(".adm-tile", { hasText: "dead" });
  await expect(deadTile.locator(".adm-tile__count")).toHaveText("1");

  // Nav reaches the swarm operations surface (issue #159); Audit is an
  // in-shell section here (issue #155), not a separate route — see
  // admin-surface.spec.ts for its dedicated coverage.
  await expect(page.locator(".adm-nav__link", { hasText: "Swarm" })).toHaveAttribute("href", "/admin/swarm");
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toBeVisible();
});

test("admin view: overview empty state renders visible copy, no alerts", async ({ page }) => {
  mockAdminApi(page, { overview: EMPTY_OVERVIEW });
  await login(page);
  await expect(page.getByText("No active alerts — everything healthy.")).toBeVisible();
  await expect(page.getByText("No enabled schedules.")).toBeVisible();
});

test("admin view: queue filters, dead-job retry, and job detail render from mocked data", async ({ page }) => {
  const { requestedPaths } = mockAdminApi(page);
  await login(page);

  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByRole("cell", { name: "research.refresh" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "regime.classify" }).first()).toBeVisible();

  // Filters re-issue the jobs/runs request with query params.
  requestedPaths.length = 0;
  await page.locator(".adm-filters select").first().selectOption("dead");
  await page.getByRole("button", { name: "Apply", exact: true }).first().click();
  await expect.poll(() => requestedPaths.some((p) => p.includes("status=dead"))).toBe(true);

  // Open the succeeded job first — no Retry control (only dead jobs get one).
  await page.locator("table.adm-table tbody tr.adm-row").filter({ hasText: "research.refresh" }).first().click();
  await expect(page.locator(".adm-log").filter({ hasText: "analytics ok" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry as new job" })).toBeHidden();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Open the dead job — its error text (with embedded markup) renders as inert
  // text, and Retry is available.
  await page.locator("table.adm-table tbody tr.adm-row").filter({ hasText: "regime.classify" }).first().click();
  await expect(page.getByRole("button", { name: "Retry as new job" })).toBeVisible();
  await expect(page.locator("img[onerror]")).toHaveCount(0);
  await expect(page.locator(".adm-log--err")).toContainText("<img src=x onerror=alert(1)>");

  page.once("dialog", (dialog) => dialog.accept("operator-confirmed manual retry after upstream fix"));
  await page.getByRole("button", { name: "Retry as new job" }).click();
  await expect(page.getByText("Retried as job")).toBeVisible();
  await expect(page.getByRole("link", { name: "777" })).toBeVisible();
});

test("admin view: research run list, stage timeline, artifact preview, and links render from mocked data", async ({ page }) => {
  mockAdminApi(page);
  await login(page);

  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByRole("cell", { name: "regime.classify" }).first()).toBeVisible();

  await page.locator("table.adm-table tbody tr.adm-row").filter({ hasText: "regime.classify" }).first().click();
  await expect(page.getByText("Stages")).toBeVisible();

  // All six stages render with their distinct statuses.
  const stageNames = ["access", "extract", "transform", "analyze", "store", "report"];
  for (const name of stageNames) {
    await expect(page.locator(".adm-stage", { hasText: name })).toBeVisible();
  }
  await expect(page.locator(".adm-stage", { hasText: "report" })).toContainText("failed");
  await expect(page.locator(".adm-stage", { hasText: "transform" })).toContainText("warning");

  // Embedded <script>-shaped fixture text renders as text, never executes.
  await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(0);
  await expect(page.locator(".adm-stage", { hasText: "transform" })).toContainText("<script>alert(1)</script>");

  // Bounded artifact preview + raw-series and public-report links.
  await expect(page.getByText("ism-pmi")).toBeVisible();
  const rawSeriesLink = page.getByRole("link", { name: "Raw series ↗" });
  await expect(rawSeriesLink).toHaveAttribute("href", "/research/ism-pmi");
  await expect(rawSeriesLink).toHaveAttribute("target", "_blank");
  const reportLink = page.getByRole("link", { name: "Open public report ↗" });
  await expect(reportLink).toHaveAttribute("href", "/regime");
  await expect(reportLink).toHaveAttribute("target", "_blank");
});

test("admin view: rerun requires kind/as-of/reason and links to the returned job", async ({ page }) => {
  mockAdminApi(page);
  await login(page);
  await page.getByRole("button", { name: "Research", exact: true }).click();

  const submit = page.getByRole("button", { name: "Request rerun", exact: true });
  await expect(submit).toBeDisabled(); // no as-of / reason yet

  await page.locator("#rerun-asof").fill("2026-07-15");
  await expect(submit).toBeDisabled(); // reason still missing

  await page.locator("#rerun-reason").fill("too short");
  await expect(submit).toBeDisabled(); // < 10 chars

  await page.locator("#rerun-reason").fill("Rerun after upstream data provider recovered from an outage.");
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(page.getByText("Queued as job")).toBeVisible();
  await expect(page.getByRole("link", { name: "888" })).toBeVisible();
});

test("admin view: polling can be paused and stops issuing refresh requests", async ({ page }) => {
  await page.clock.install();
  const { requestedPaths } = mockAdminApi(page);
  await login(page);

  requestedPaths.length = 0;
  await page.clock.runFor(5_000);
  await expect.poll(() => requestedPaths.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Pause polling", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume polling", exact: true })).toBeVisible();
  requestedPaths.length = 0;
  await page.clock.runFor(20_000);
  expect(requestedPaths.length).toBe(0);
});

test("admin view: a mocked 403 clears the token, stops polling, and shows session-expired", async ({ page }) => {
  await page.clock.install();
  const { requestedPaths } = mockAdminApi(page);
  await login(page);

  // Reroute every subsequent admin call to 403 (token revoked server-side).
  await page.route("**/api/admin/**", (route) => route.fulfill(jsonReply({ error: "admin authorization required" }, 403)));

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Session expired — sign in again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();

  const stored = await page.evaluate(() => sessionStorage.getItem("rm_admin_token"));
  expect(stored).toBeNull();

  // Polling must be dead too — advancing the clock issues no further request.
  requestedPaths.length = 0;
  await page.clock.runFor(20_000);
  expect(requestedPaths.length).toBe(0);
});

// ── Swarm operations surface fixtures (issue #159) ──────────────────────
// Reconciled to the REAL backend (issue #152/PR #169) per PR #172 review:
// these mocks now serve the actual, already-shipped URL prefix
// (/api/swarm/admin/*, backend/src/api/routes/swarm-admin.ts) with
// its real verbs, action names, and response envelopes — not the invented
// /api/admin/swarm/* contract that no backend route ever implemented.

const TOPIC_FIXTURE = {
  id: "woon-vault", status: "active", name: "Woon Vault", operator: "Woon Labs",
  homepage: null, xHandle: null, thesisBlurb: "A vault strategy thesis.",
  wallets: [{ address: "0xabc0000000000000000000000000000000dead", chain: "base", label: "main" }],
  nftContracts: [], source: { type: "rpc" }, recommendationType: "position_actions",
  linkedMemberId: null, structuralNotes: [], lastReviewed: null,
  version: 3, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-07-15T10:00:00.000Z",
};

// toMemberAdmin()'s exact shape — no applicationStatus/activeKeyId/participation
// (none of those exist on the real backend's member projection or any route).
const MEMBER_APPLIED = {
  id: "nova", status: "applied", version: 1, name: "Nova", tagline: null, lens: "risk",
  mandate: null, contactEmail: "nova@example.com",
  appliedAt: "2026-07-10T00:00:00.000Z", activatedAt: null, updatedAt: "2026-07-10T00:00:00.000Z",
};
// listApplicationsAdmin() row — raw snake_case, cross-referenced by member_id
// to derive "applied + reviewable" (there is no applicationStatus field on
// the member itself).
const NOVA_APPLICATION = { id: 1, member_id: "nova", status: "pending", created_at: "2026-07-10T00:00:00.000Z", reviewed_at: null };

// Carries the fields #567 added to toMemberAdmin (biases/voiceMd/mode/
// operator/avatar) — the edit form cannot prefill what the projection omits.
// This is toMemberAdmin()'s shipped key set exactly: NO `slug`. swarm_members
// has no slug column, so the projection cannot return one and the admin patch
// validator answers `unknown field: slug`. Inventing one here would let the
// form's slug affordance test green against a backend that has neither the
// column nor the key.
const MEMBER_ACTIVE = {
  id: "athena", status: "active", version: 2, name: "Athena", tagline: "macro lens", lens: "macro",
  mandate: null, biases: ["pro-diversification", "anti-reflexivity"], voiceMd: null, mode: null,
  operator: null, avatar: null, contactEmail: "athena@example.com",
  appliedAt: "2026-06-01T00:00:00.000Z", activatedAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z",
  // Stray field a buggy backend must never send — proves the client's own
  // defense-in-depth redaction (never trust the wire alone for secrets).
  token_hash: "should-never-render-raw",
};

// Third member state (inactive) — exercises the "Inactive" filter tab and the
// reactivate action, neither of which the applied/active fixtures above cover.
const MEMBER_INACTIVE = {
  id: "cleo", status: "inactive", version: 1, name: "Cleo", tagline: null, lens: "yield",
  mandate: null, contactEmail: "cleo@example.com",
  appliedAt: "2026-05-01T00:00:00.000Z", activatedAt: "2026-05-02T00:00:00.000Z", updatedAt: "2026-06-15T00:00:00.000Z",
};

// GET .../sessions/:id/roster rows — getSessionRoster()'s raw, unprojected
// (snake_case) shape. All three start `expected`; a 4th `excused` row is
// layered on top only by the roster test that needs it.
interface RosterRowFixture {
  member_id: string; member_name: string; member_lens: string | null; status: "expected" | "excused";
  included_at: string | null; excused_at: string | null; reason: string | null;
}

function baseRosterRows(): RosterRowFixture[] {
  return [
    { member_id: "athena", member_name: "Athena", member_lens: "macro", status: "expected",
      included_at: "2026-07-19T00:00:00.000Z", excused_at: null, reason: null },
    { member_id: "nova", member_name: "Nova", member_lens: "risk", status: "expected",
      included_at: "2026-07-19T00:00:00.000Z", excused_at: null, reason: null },
    { member_id: "robotmoney", member_name: "Robotmoney", member_lens: "protocol", status: "expected",
      included_at: "2026-07-19T00:00:00.000Z", excused_at: null, reason: null },
  ];
}

// Public per-member submission content (swarm/projections.ts toTake(), via
// GET /api/swarm/sessions/:date/:subject). Only Athena has submitted —
// Nova/Robotmoney stay "expected" (rendered as "absent" until they submit).
// No nonce/signature/canonicalPayload field exists on any read route.
function baseTakes() {
  return [
    { id: 1, memberId: "athena", memberName: "Athena", stance: "bullish", confidence: 0.8,
      body: "Rotate into WOON.", memoUrl: null, verified: true, receivedAt: "2026-07-20T15:00:00.000Z" },
  ];
}

// Public session summary (swarm/projections.ts toSession()) — the ONLY
// session read surface. No version/briefOpensAt/publishAt field exists here
// (those are only ever returned transiently by the create-session response).
function sessionSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-1", date: "2026-07-20", subjectId: "woon-vault", subjectName: "Woon Vault",
    state: "collecting", windowClosesAt: "2026-07-20T20:00:00.000Z", publishedAt: null,
    regimeSummary: null, subjectSnapshotTotalValueUsd: null, synthesis: null,
    swarmRecommendation: null, socialDraftId: null, generatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

async function mockSwarmApi(
  page: Page,
  opts: { session?: ReturnType<typeof sessionSummary>; rosterRows?: ReturnType<typeof baseRosterRows>; takes?: ReturnType<typeof baseTakes> } = {},
): Promise<void> {
  await mockVendorScripts(page);
  await page.route("**/api/admin/auth", (route) => route.fulfill(jsonReply({ ok: true })));

  const session = opts.session || sessionSummary();
  const rosterRows = opts.rosterRows || baseRosterRows();
  const takes = opts.takes || baseTakes();

  // ── Topics ──────────────────────────────────────────────────────────────
  await page.route(/\/api\/swarm\/admin\/subjects$/, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill(jsonReply({ ok: true, status: 201, subject: { ...TOPIC_FIXTURE, id: "new-topic" } }, 201));
    }
    return route.fulfill(jsonReply({ subjects: [TOPIC_FIXTURE] }));
  });
  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/update$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, subject: { ...TOPIC_FIXTURE, version: 4 } })));
  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/deactivate$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, subject: { ...TOPIC_FIXTURE, status: "inactive", version: 4 } })));

  // ── Members ─────────────────────────────────────────────────────────────
  await page.route(/\/api\/swarm\/admin\/members$/, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill(jsonReply({ ok: true, status: 201, member: { ...MEMBER_APPLIED, id: "new-member" }, token: "member-bearer-token-abc123" }, 201));
    }
    return route.fulfill(jsonReply({ members: [MEMBER_APPLIED, MEMBER_ACTIVE, MEMBER_INACTIVE] }));
  });
  await page.route(/\/api\/swarm\/admin\/applications(\?.*)?$/, (route) =>
    route.fulfill(jsonReply({ applications: [NOVA_APPLICATION] })));
  // activate/reject are the SAME endpoint (POST .../review, body {decision}).
  await page.route(/\/api\/swarm\/admin\/members\/nova\/review$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, memberId: "nova", memberStatus: "active", token: "activated-bearer-token-xyz789" })));
  // reactivate mints a fresh credential WITHOUT taking a new public key.
  await page.route(/\/api\/swarm\/admin\/members\/cleo\/reactivate$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, member: { ...MEMBER_INACTIVE, status: "active" }, token: "reactivated-bearer-token-def456" })));
  await page.route(/\/api\/swarm\/admin\/members\/athena\/rotate-key$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, memberId: "athena", token: "rotated-bearer-token-ghi789" })));
  // #567's versioned profile edit.
  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, member: { ...MEMBER_ACTIVE, version: 3 } })));

  // ── Sessions ────────────────────────────────────────────────────────────
  await page.route(/\/api\/swarm\/admin\/sessions$/, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill(jsonReply({
        ok: true, status: 201,
        session: { id: "sess-1", date: "2026-07-20", subjectId: "woon-vault", subjectName: "Woon Vault", state: "scheduled", version: 1 },
        rosterSize: 3, jobIds: [501, 502, 503, 504],
      }, 201));
    }
    return route.fulfill(jsonReply({ error: "no admin session-list route exists" }, 404));
  });
  // No admin session-list route exists — the overview's Sessions tab and the
  // session detail page both read the PUBLIC list/detail routes instead.
  // (?.*)? tolerates the ?full=1 swarm-session.js now sends (issue #243).
  await page.route(/\/api\/swarm\/sessions(\?.*)?$/, (route) => route.fulfill(jsonReply({ sessions: [session] })));
  await page.route(/\/api\/swarm\/sessions\/2026-07-20\/woon-vault$/, (route) =>
    route.fulfill(jsonReply({ session, takes })));
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/roster$/, (route) => route.fulfill(jsonReply({ roster: rosterRows })));
  // Three separate roster-mutation endpoints, never a single PATCH.
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/roster\/(add|excuse|restore)$/, (route) => {
    const memberId = route.request().postDataJSON()?.memberId;
    return route.fulfill(jsonReply({ ok: true, status: 200, sessionId: "sess-1", memberId }));
  });
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/close$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, session: { id: "sess-1", state: "window_closed", version: 3 } })));
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/aggregate$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, idempotent: true, session: { id: "sess-1", state: "aggregated", version: 3 } })));
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/cancel$/, (route) =>
    route.fulfill(jsonReply({ ok: false, status: 409, error: "illegal_transition:published->cancelled" }, 409)));
}

async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // Scoped to the login card specifically — every admin page also carries
  // several (initially hidden) .adm-input form fields of its own, which would
  // otherwise make this a strict-mode-ambiguous locator.
  await page.locator(".adm-login .adm-input").fill("demo-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// AC: route map + direct navigation + back/forward.
test("swarm admin: direct navigation and back/forward across nested routes", async ({ page }) => {
  await mockSwarmApi(page);

  await signIn(page, "/admin/swarm");
  await expect(page.getByRole("heading", { name: "Swarm Operations" })).toBeVisible();

  await page.getByRole("cell", { name: "Woon Vault" }).click();
  await expect(page).toHaveURL(/\/admin\/swarm\/subjects\/woon-vault$/);
  await expect(page.getByRole("heading", { name: /Topic woon-vault/ })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/swarm$/);
  await expect(page.getByRole("heading", { name: "Swarm Operations" })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/swarm\/subjects\/woon-vault$/);

  // Direct navigation (full document load) to a nested :id route also resolves,
  // using the token already persisted in this tab's sessionStorage.
  await page.goto("/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();
});

// AC: 403 clears token, stops polling, clears sensitive state, session-expired message.
test("swarm admin: a mocked 403 logs out and shows session-expired", async ({ page }) => {
  await mockVendorScripts(page);
  await page.route("**/api/admin/auth", (route) => route.fulfill(jsonReply({ ok: true })));
  await page.route(/\/api\/swarm\/admin\/subjects$/, (route) => route.fulfill(jsonReply({ error: "forbidden" }, 403)));
  await page.route(/\/api\/swarm\/admin\/members$/, (route) => route.fulfill(jsonReply({ error: "forbidden" }, 403)));
  // (?.*)? tolerates the ?full=1 swarm-overview.js now sends (issue #243).
  await page.route(/\/api\/swarm\/sessions(\?.*)?$/, (route) => route.fulfill(jsonReply({ error: "forbidden" }, 403)));

  await signIn(page, "/admin/swarm");
  await expect(page.getByText("Session expired — sign in again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();

  const token = await page.evaluate(() => sessionStorage.getItem("rm_admin_token"));
  expect(token).toBeNull();
});

// AC: topic form validation + successful create asserts endpoint/body.
test("swarm admin: topic form rejects invalid input and create posts the exact body", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm");

  await page.getByTestId("new-topic-toggle").click();
  await page.getByTestId("topic-submit").click();
  await expect(page.getByTestId("topic-form").getByText(/Topic id must match/)).toBeVisible();
  await expect(page.getByTestId("topic-form").getByText("Name is required.")).toBeVisible();

  // Invalid id (uppercase) is rejected client-side before any request fires.
  await page.getByTestId("topic-id").fill("Not_Valid_ID!");
  await page.getByTestId("topic-name").fill("New Topic");
  await page.getByTestId("topic-operator").fill("Op Co");
  await page.getByTestId("topic-thesis").fill("Thesis text.");
  await page.getByTestId("topic-reason").fill("Adding this topic for coverage.");
  await page.getByTestId("topic-submit").click();
  await expect(page.getByTestId("topic-form").getByText(/Topic id must match/)).toBeVisible();

  // rpc source requires at least one wallet.
  await page.getByTestId("topic-id").fill("new-topic");
  await page.getByTestId("topic-source-type").selectOption("rpc");
  await page.getByTestId("topic-submit").click();
  await expect(page.getByTestId("topic-form").getByText(/rpc topics require/)).toBeVisible();

  let captured: unknown = null;
  await page.route(/\/api\/swarm\/admin\/subjects$/, async (route) => {
    if (route.request().method() === "POST") {
      captured = route.request().postDataJSON();
      return route.fulfill(jsonReply({ ok: true, status: 201, subject: { ...TOPIC_FIXTURE, id: "new-topic" } }, 201));
    }
    return route.fulfill(jsonReply({ subjects: [TOPIC_FIXTURE] }));
  });
  await page.getByTestId("topic-add-wallet").click();
  await page.locator(".adm-wallet-row input").first().fill("0x00000000000000000000000000000000000001");
  await page.locator(".adm-wallet-row input").nth(1).fill("base");
  await page.getByTestId("topic-submit").click();

  await expect(page.getByTestId("topic-form")).not.toBeVisible();
  expect(captured).toMatchObject({
    id: "new-topic", name: "New Topic", operator: "Op Co", thesisBlurb: "Thesis text.",
    source: { type: "rpc" }, reason: "Adding this topic for coverage.",
  });
});

// AC: server-side rejection of an unrecognized field / stale version surfaces inline.
test("swarm admin: topic edit surfaces a 400 (unknown field) and a 409 (stale version)", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/subjects/woon-vault");
  await expect(page.getByRole("heading", { name: /Topic woon-vault/ })).toBeVisible();

  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/update$/, (route) =>
    route.fulfill(jsonReply({ error: "unknown field: bogus" }, 400)));
  await page.getByTestId("topic-edit-toggle").click();
  await page.getByTestId("edit-reason").fill("Editing for coverage purposes.");
  await page.getByTestId("edit-submit").click();
  await expect(page.getByText("unknown field: bogus")).toBeVisible();

  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/update$/, (route) =>
    route.fulfill(jsonReply({ ok: false, status: 409, error: "stale_version" }, 409)));
  await page.getByTestId("edit-submit").click();
  await expect(page.getByText(/stale version/)).toBeVisible();
});

// AC: a successful topic edit POSTs the dedicated `.../update` endpoint (not
// PATCH) and asserts the exact request body, keyed `expectedVersion` (not
// `version` — the field the real backend's parseExpectedVersion reads).
test("swarm admin: topic edit succeeds and posts the exact update body", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/subjects/woon-vault");
  await expect(page.getByRole("heading", { name: /Topic woon-vault/ })).toBeVisible();

  let captured: unknown = null;
  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/update$/, async (route) => {
    captured = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, subject: { ...TOPIC_FIXTURE, name: "Woon Vault Renamed", version: 4 } }));
  });

  await page.getByTestId("topic-edit-toggle").click();
  await page.getByTestId("edit-name").fill("Woon Vault Renamed");
  await page.getByTestId("edit-reason").fill("Renaming for accuracy and coverage.");
  await page.getByTestId("edit-submit").click();

  await expect(page.getByTestId("topic-edit-form")).not.toBeVisible();
  expect(captured).toMatchObject({
    expectedVersion: 3, name: "Woon Vault Renamed", operator: "Woon Labs",
    thesisBlurb: "A vault strategy thesis.", source: { type: "rpc" },
    reason: "Renaming for accuracy and coverage.",
  });
});

// AC (RM-47): the linked-member picker. `linkedMemberId` has always been in
// swarm-subject.js's update payload and accepted by the route; it had no input,
// so a topic could only ever be linked by a database write. The picker lists
// real members because a funnel member's id is a server-minted UUID.
test("swarm admin: topic edit links a member by picker and names it in the detail view", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/subjects/woon-vault");
  await expect(page.getByRole("heading", { name: /Topic woon-vault/ })).toBeVisible();
  await expect(page.getByTestId("topic-linked-member")).toHaveText("—");

  let captured: unknown = null;
  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/update$/, async (route) => {
    captured = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, subject: { ...TOPIC_FIXTURE, linkedMemberId: "athena", version: 4 } }));
  });
  await page.route(/\/api\/swarm\/admin\/subjects$/, (route) =>
    route.fulfill(jsonReply({ subjects: [{ ...TOPIC_FIXTURE, linkedMemberId: "athena", version: 4 }] })));

  await page.getByTestId("topic-edit-toggle").click();
  await page.getByTestId("edit-linked-member").selectOption("athena");
  await page.getByTestId("edit-reason").fill("Linking the topic to its own member.");
  await page.getByTestId("edit-submit").click();

  await expect(page.getByTestId("topic-edit-form")).not.toBeVisible();
  expect(captured).toMatchObject({ expectedVersion: 3, linkedMemberId: "athena" });
  // Reads as a name, not a UUID, and resolves through the member list.
  await expect(page.getByTestId("topic-linked-member")).toHaveText("Athena (athena)");
});

// AC (RM-47): clearing a link is refused client-side rather than reported as a
// success the database did not perform. updateSubjectAdmin merges with
// `patch.linkedMemberId ?? row.linked_member_id`, so a null reads as "absent"
// and the old value survives a 200. Delete this guard when that merge switches
// to `!== undefined`.
test("swarm admin: topic edit refuses to unlink a member and sends no request", async ({ page }) => {
  await mockSwarmApi(page);
  await page.route(/\/api\/swarm\/admin\/subjects$/, (route) =>
    route.fulfill(jsonReply({ subjects: [{ ...TOPIC_FIXTURE, linkedMemberId: "athena" }] })));
  await signIn(page, "/admin/swarm/subjects/woon-vault");
  await expect(page.getByTestId("topic-linked-member")).toHaveText("Athena (athena)");

  let posted = false;
  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/update$/, async (route) => {
    posted = true;
    return route.fulfill(jsonReply({ ok: true, status: 200, subject: TOPIC_FIXTURE }));
  });

  await page.getByTestId("topic-edit-toggle").click();
  await page.getByTestId("edit-linked-member").selectOption("");
  await page.getByTestId("edit-reason").fill("Trying to unlink for coverage.");
  await page.getByTestId("edit-submit").click();

  await expect(page.getByText(/Unlinking is not supported yet/)).toBeVisible();
  await expect(page.getByTestId("topic-edit-form")).toBeVisible();
  expect(posted).toBe(false);
});

// AC: the deactivate flow (toggle → reason → confirm) POSTs the dedicated
// deactivate endpoint and asserts expectedVersion/reason in the request body.
test("swarm admin: topic deactivate flow posts to the dedicated endpoint with expectedVersion and reason", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/subjects/woon-vault");
  await expect(page.getByRole("heading", { name: /Topic woon-vault/ })).toBeVisible();

  let captured: unknown = null;
  await page.route(/\/api\/swarm\/admin\/subjects\/woon-vault\/deactivate$/, async (route) => {
    captured = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, subject: { ...TOPIC_FIXTURE, status: "inactive", version: 4 } }));
  });

  await page.getByTestId("topic-deactivate-toggle").click();
  await expect(page.getByTestId("deactivate-confirm")).toBeVisible();
  await page.getByTestId("deactivate-reason").fill("Deactivating this topic for coverage.");
  await page.getByTestId("deactivate-confirm-submit").click();

  await expect(page.getByTestId("deactivate-confirm")).not.toBeVisible();
  expect(captured).toMatchObject({ expectedVersion: 3, reason: "Deactivating this topic for coverage." });
});

// AC: applied/active/inactive filtering + one-time credential reveal + no
// token_hash/bearer token rendered in detail JSON.
// AC (#567, RM-47): a profile edit sends ONLY the fields that changed. Posting
// the whole row would re-send stale values for fields the operator never
// touched, which the version guard cannot catch because we would be the writer.
test("swarm admin: member profile edit posts only the changed fields, with the reason", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();
  await expect(page.getByTestId("member-biases")).toHaveText("pro-diversification, anti-reflexivity");

  let captured: unknown = null;
  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, async (route) => {
    captured = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, member: { ...MEMBER_ACTIVE, version: 3 } }));
  });

  await page.getByTestId("member-edit-toggle").click();
  await page.getByTestId("edit-member-lens").fill("machine economy, first person");
  await page.getByTestId("edit-member-biases").fill("never-sells-agent-tokens\nopenly-conflicted");
  await page.getByTestId("edit-member-reason").fill("Operator correction requested by peaq.");
  await page.getByTestId("edit-member-submit").click();

  await expect(page.getByTestId("member-edit-form")).not.toBeVisible();
  expect(captured).toEqual({
    expectedVersion: 2,
    lens: "machine economy, first person",
    biases: ["never-sells-agent-tokens", "openly-conflicted"],
    reason: "Operator correction requested by peaq.",
  });
});

// AC (#567): an emptied field is a CLEAR, sent as an explicit null, and a form
// with no change at all never reaches the network.
test("swarm admin: member profile edit clears with null and refuses an empty save", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();

  let captured: unknown = null;
  let posts = 0;
  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, async (route) => {
    posts += 1;
    captured = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, member: { ...MEMBER_ACTIVE, version: 3 } }));
  });

  await page.getByTestId("member-edit-toggle").click();
  await page.getByTestId("edit-member-submit").click();
  await expect(page.getByText("Nothing changed.")).toBeVisible();
  expect(posts).toBe(0);

  await page.getByTestId("edit-member-tagline").fill("");
  await page.getByTestId("edit-member-submit").click();
  await expect(page.getByTestId("member-edit-form")).not.toBeVisible();
  expect(captured).toEqual({ expectedVersion: 2, tagline: null });
  expect(posts).toBe(1);
});

// AC (#567): `stale_version` is the only 409 updateMemberAdmin() emits, and the
// only one whose fix is "reload and retry". Every other 409 is rendered
// verbatim — the client must not attach reload advice to a conflict a reload
// cannot clear. The second leg here exercises the client's own passthrough
// branch (and apiErrorText() unwrapping the envelope), NOT a backend error
// shape: the synthetic body stands in for any unrecognised 409.
test("swarm admin: member profile edit gives only stale_version the reload advice", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();

  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, (route) =>
    route.fulfill(jsonReply({ ok: false, status: 409, error: "member is locked by another operation" }, 409)));
  await page.getByTestId("member-edit-toggle").click();
  await page.getByTestId("edit-member-name").fill("Athena Renamed");
  await page.getByTestId("edit-member-submit").click();
  await expect(page.getByText(/member is locked by another operation/)).toBeVisible();
  await expect(page.getByText(/reload and try again/)).not.toBeVisible();

  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, (route) =>
    route.fulfill(jsonReply({ ok: false, status: 409, error: "stale_version" }, 409)));
  await page.getByTestId("edit-member-submit").click();
  await expect(page.getByText(/stale version.*reload and try again/)).toBeVisible();
});

// AC (#567): client-side validation mirrors the server's shapes so an operator
// is corrected before the round-trip, and a bad value never leaves the page.
// Both bounds are the backend's own: CONTACT_EMAIL_RE and optionalBiases()'s
// 200-char entry limit in api/validation.ts.
test("swarm admin: member profile edit rejects a malformed email and an oversized bias locally", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();

  let posts = 0;
  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, async (route) => {
    posts += 1;
    return route.fulfill(jsonReply({ ok: true, status: 200, member: MEMBER_ACTIVE }));
  });

  await page.getByTestId("member-edit-toggle").click();
  await page.getByTestId("edit-member-contact").fill("not-an-email");
  await page.getByTestId("edit-member-biases").fill("x".repeat(201));
  await page.getByTestId("edit-member-submit").click();

  await expect(page.getByText(/Enter a valid email address/)).toBeVisible();
  await expect(page.getByText(/Each bias must be 200 characters or fewer/)).toBeVisible();
  expect(posts).toBe(0);
});

// swarm_members has no slug column: validateMemberAdminPatch()'s
// MEMBER_ADMIN_KEYS omits `slug` and the route answers `unknown field: slug`.
// The form must therefore offer no slug affordance at all — this is the guard
// that a later change cannot reintroduce one without the column.
test("swarm admin: member profile edit offers no slug field the backend would reject", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();

  await page.getByTestId("member-edit-toggle").click();
  await expect(page.getByTestId("member-edit-form")).toBeVisible();
  await expect(page.getByTestId("edit-member-slug")).toHaveCount(0);

  let captured: unknown = null;
  await page.route(/\/api\/swarm\/admin\/members\/athena\/update$/, async (route) => {
    captured = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, member: { ...MEMBER_ACTIVE, version: 3 } }));
  });
  await page.getByTestId("edit-member-name").fill("Athena Renamed");
  await page.getByTestId("edit-member-submit").click();
  await expect(page.getByTestId("member-edit-form")).not.toBeVisible();
  expect(captured).toEqual({ expectedVersion: 2, name: "Athena Renamed" });
});

test("swarm admin: member filters, one-time credential reveal, and redacted detail JSON", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm");
  await page.getByRole("button", { name: "Members" }).click();

  await page.getByTestId("member-filter-applied").click();
  await expect(page.getByRole("cell", { name: "Nova", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Athena", exact: true })).toHaveCount(0);

  await page.getByTestId("member-filter-active").click();
  await expect(page.getByRole("cell", { name: "Athena", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Nova", exact: true })).toHaveCount(0);

  await page.getByTestId("member-filter-applied").click();
  await page.getByRole("cell", { name: "Nova", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Member nova/ })).toBeVisible();

  await page.getByTestId("member-activate").click();
  // Approve is the one action with NO reason field (RM-45): the backend never
  // persisted it, so requiring it on the common path was a mandatory field that
  // went nowhere. Asserted hidden rather than merely not filled, so re-adding it
  // silently fails here. `x-show` hides without unmounting, hence toBeHidden
  // rather than toHaveCount(0) — same pattern as the public-key field below.
  await expect(page.getByTestId("member-action-reason")).toBeHidden();
  await page.getByTestId("member-action-submit").click();

  const tokenEl = page.getByTestId("credential-token");
  await expect(tokenEl).toBeVisible();
  await expect(tokenEl).toHaveText("activated-bearer-token-xyz789");
  await page.getByTestId("credential-dismiss").click();
  await expect(page.getByTestId("credential-modal")).not.toBeVisible();

  // Navigate to a member whose fixture carries a stray token_hash — the
  // rendered detail JSON must never show it raw.
  await page.goto("/admin/swarm/members/athena");
  const detailJson = page.getByTestId("member-json");
  await expect(detailJson).toBeVisible();
  await expect(detailJson).not.toContainText("should-never-render-raw");
  await expect(detailJson).toContainText("[redacted]");
});

// AC: the "Inactive" filter renders the inactive set; manual-add, reactivate,
// and rotate-key each mint and reveal their own one-time credential exactly once.
test("swarm admin: inactive filter, manual-add credential reveal, and reactivate/rotate-key credentials", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm");
  await page.getByRole("button", { name: "Members" }).click();

  await page.getByTestId("member-filter-inactive").click();
  await expect(page.getByRole("cell", { name: "Cleo", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Athena", exact: true })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "Nova", exact: true })).toHaveCount(0);

  // Manual-add: drive the form to completion and assert the one-time reveal.
  await page.getByTestId("new-member-toggle").click();
  await page.getByTestId("member-id").fill("newmember");
  await page.getByTestId("member-name").fill("New Member");
  await page.getByTestId("member-public-key").fill("pubkey-abc");
  await page.getByTestId("member-reason").fill("Manually adding this member for coverage.");
  await page.getByTestId("member-submit").click();

  const addToken = page.getByTestId("credential-token");
  await expect(addToken).toBeVisible();
  await expect(addToken).toHaveText("member-bearer-token-abc123");
  await page.getByTestId("credential-dismiss").click();
  await expect(page.getByTestId("credential-modal")).not.toBeVisible();

  // Reactivate: Cleo is inactive, so `member-reactivate` is the offered
  // action. Unlike rotate-key, reactivate does NOT take a new public key (it
  // reuses the member's last on-file key) — the public-key field stays
  // hidden for this action.
  await page.getByTestId("member-filter-inactive").click();
  await page.getByRole("cell", { name: "Cleo", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Member cleo/ })).toBeVisible();

  await page.getByTestId("member-reactivate").click();
  await expect(page.getByTestId("member-action-public-key")).toBeHidden();
  await page.getByTestId("member-action-reason").fill("Reactivating after cooldown period.");
  await page.getByTestId("member-action-submit").click();

  const reactivateToken = page.getByTestId("credential-token");
  await expect(reactivateToken).toBeVisible();
  await expect(reactivateToken).toHaveText("reactivated-bearer-token-def456");
  await page.getByTestId("credential-dismiss").click();
  await expect(page.getByTestId("credential-modal")).not.toBeVisible();

  // Rotate key: Athena is active, so `member-rotate-key` is offered; its
  // response mints a distinct fresh credential, shown exactly once.
  await page.goto("/admin/swarm/members/athena");
  await expect(page.getByRole("heading", { name: /Member athena/ })).toBeVisible();

  await page.getByTestId("member-rotate-key").click();
  await page.getByTestId("member-action-public-key").fill("new-pubkey-2");
  await page.getByTestId("member-action-reason").fill("Rotating key due to suspected exposure.");
  await page.getByTestId("member-action-submit").click();

  const rotateToken = page.getByTestId("credential-token");
  await expect(rotateToken).toBeVisible();
  await expect(rotateToken).toHaveText("rotated-bearer-token-ghi789");
  await expect(rotateToken).not.toHaveText("reactivated-bearer-token-def456");
});

// AC: session scheduling reason/ISO-ordering validation + UTC/local rendering
// + roster snapshot + disabled illegal-transition controls. "Linked jobs" is
// gone (no session-scoped job read exists on the real backend — see
// mockSwarmApi's header comment), and legal actions are now the 5 real
// action names, computed client-side from the session's `state`.
test("swarm admin: session create validation, UTC/local timeline, roster, and disabled illegal actions", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm");
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.getByTestId("new-session-toggle").click();

  await page.getByTestId("session-submit").click();
  await expect(page.getByTestId("session-form").getByText("Select an active topic.")).toBeVisible();

  await page.getByTestId("session-subject").selectOption("woon-vault");
  await page.getByTestId("session-date").fill("2026-07-20");
  await page.getByTestId("session-brief-opens").fill("2026-07-20T20:00:00Z");
  await page.getByTestId("session-window-closes").fill("2026-07-20T14:00:00Z"); // before brief-opens: illegal order
  await page.getByTestId("session-publish-at").fill("2026-07-20T21:00:00Z");
  await page.getByTestId("session-reason").fill("Scheduling this session for coverage.");
  await page.getByTestId("session-submit").click();
  await expect(page.getByText(/briefOpensAt < windowClosesAt < publishAt/)).toBeVisible();

  await page.goto("/admin/swarm/sessions/sess-1");
  // Timeline now only has Window closes / Published (no version/briefOpensAt/
  // publishAt — no GET route exposes them).
  await expect(page.locator(".adm-meta-grid").getByText("2026-07-20 20:00:00 UTC")).toBeVisible();
  await expect(page.getByText(/local\)/)).toHaveCount(1);

  await expect(page.getByRole("cell", { name: "Athena", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Nova", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Robotmoney", exact: true })).toBeVisible();

  // Default fixture state is "collecting" → only close/cancel are legal
  // (backend/src/swarm/admin.ts TRANSITIONS, restricted to the 5 real
  // HTTP actions).
  await expect(page.getByTestId("session-action-close")).toBeEnabled();
  await expect(page.getByTestId("session-action-cancel")).toBeEnabled();
  await expect(page.getByTestId("session-action-publish")).toBeDisabled();
  await expect(page.getByTestId("session-action-aggregate")).toBeDisabled();
  await expect(page.getByTestId("session-action-reopen")).toBeDisabled();
});

// AC: roster/recommendation matrix — one row per roster snapshot, distinct
// derived states, read-only recommendation detail, collapsed disclosure.
// The disclosure no longer shows a signature/canonicalPayload/nonce — no
// route anywhere returns them; it shows verified/body/memoUrl instead (see
// swarm-session.js's header comment for the full route composition).
test("swarm admin: roster matrix states, filter, and collapsed recommendation disclosure", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/sessions/sess-1");

  const rows = page.getByTestId("roster-table").locator("tbody tr");
  // 3 roster rows + 3 (initially hidden) disclosure rows + 1 (hidden) empty-state row.
  await expect(rows).toHaveCount(7);

  await expect(page.getByTestId("disclosure-row-athena")).toBeHidden();
  await expect(page.getByTestId("disclosure-toggle-athena")).toBeVisible();
  await page.getByTestId("disclosure-toggle-athena").click();
  const disclosure = page.getByTestId("disclosure-row-athena");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText("Verified: yes");
  await expect(disclosure).toContainText("Rotate into WOON.");

  await page.getByTestId("roster-filter").selectOption("submitted");
  await expect(page.getByRole("cell", { name: "Athena", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Nova", exact: true })).toHaveCount(0);

  // Nova/Robotmoney are on the frozen `expected` roster but never submitted —
  // derived as "absent" (rowStatus()), since the backend roster row itself
  // only ever says expected/excused.
  await page.getByTestId("roster-filter").selectOption("absent");
  await expect(page.getByRole("cell", { name: "Robotmoney", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Nova", exact: true })).toBeVisible();

  // No admin control can edit or delete the accepted recommendation itself —
  // the only per-row controls are the disclosure toggle and roster
  // add/excuse/restore, never an edit/delete on the recommendation.
  await expect(page.getByText("Edit recommendation")).toHaveCount(0);
  await expect(page.getByText("Delete recommendation")).toHaveCount(0);
});

// AC: an `excused` roster row renders distinctly, is isolated by the
// "excused" filter, and the excuse/restore controls each hit their OWN POST
// endpoint (never a single PATCH with an `operation` field), body `{memberId}`
// only — no `version` (roster rows aren't optimistic-locked on the real backend).
test("swarm admin: excused roster row renders distinctly and excuse/restore submit roster mutations", async ({ page }) => {
  const excusedRosterRows: RosterRowFixture[] = [
    ...baseRosterRows(),
    { member_id: "ren", member_name: "Ren", member_lens: "growth", status: "excused",
      included_at: "2026-07-19T00:00:00.000Z", excused_at: "2026-07-19T01:00:00.000Z",
      reason: "Conflict of interest disclosed." },
  ];
  await mockSwarmApi(page, { rosterRows: excusedRosterRows });
  await signIn(page, "/admin/swarm/sessions/sess-1");

  // The excused row renders distinctly (its own state cell) alongside the
  // submitted/expected/absent rows already covered by the matrix test above.
  const renRow = page.getByRole("row", { name: /Ren/ });
  await expect(renRow).toBeVisible();
  await expect(renRow).toContainText("excused");

  await page.getByTestId("roster-filter").selectOption("excused");
  await expect(page.getByRole("cell", { name: "Ren", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Athena", exact: true })).toHaveCount(0);
  await page.getByTestId("roster-filter").selectOption("all");

  // Restore Ren (excused → expected) — its own endpoint, body {memberId, reason}.
  let capturedRestore: unknown = null;
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/roster\/restore$/, async (route) => {
    capturedRestore = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, sessionId: "sess-1", memberId: "ren" }));
  });
  await page.getByTestId("roster-restore-ren").click();
  await expect(page.getByTestId("roster-form")).toBeVisible();
  await page.getByTestId("roster-reason").fill("Restoring Ren to the roster ahead of window close.");
  await page.getByTestId("roster-submit").click();
  await expect(page.getByTestId("roster-form")).not.toBeVisible();
  expect(capturedRestore).toMatchObject({
    memberId: "ren", reason: "Restoring Ren to the roster ahead of window close.",
  });
  expect(capturedRestore).not.toHaveProperty("operation");
  expect(capturedRestore).not.toHaveProperty("version");

  // Excuse Nova (expected → excused) — its own endpoint, body {memberId, reason}.
  let capturedExcuse: unknown = null;
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/roster\/excuse$/, async (route) => {
    capturedExcuse = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, sessionId: "sess-1", memberId: "nova" }));
  });
  await page.getByTestId("roster-excuse-nova").click();
  await expect(page.getByTestId("roster-form")).toBeVisible();
  await page.getByTestId("roster-reason").fill("Excusing Nova due to a scheduling conflict.");
  await page.getByTestId("roster-submit").click();
  await expect(page.getByTestId("roster-form")).not.toBeVisible();
  expect(capturedExcuse).toMatchObject({
    memberId: "nova", reason: "Excusing Nova due to a scheduling conflict.",
  });
});

// AC: aggregate fields render from a read-only aggregated session. Unlike the
// original invented AdminSessionAggregate DTO, this data is the REAL
// persisted shape (swarm/domain.ts aggregateSession() writes
// swarmRecommendation + synthesis onto the session row itself; toSession()
// reads them straight back — no sourceRecommendationIds field exists).
test("swarm admin: aggregate view renders quorum, stance counts, synthesis, and consensus", async ({ page }) => {
  await mockSwarmApi(page, {
    session: sessionSummary({
      state: "aggregated",
      synthesis: "The swarm reads a bullish tilt across the panel.",
      swarmRecommendation: {
        quorum: { active: 3, submitted: 1, absent: ["nova", "robotmoney"], participation: 0.33 },
        stances: { bullish: 1, neutral: 0 }, meanConfidence: 0.8,
        consensus: ["Rotate into WOON"], disagreements: [],
      },
    }),
  });
  await signIn(page, "/admin/swarm/sessions/sess-1");

  await expect(page.getByRole("heading", { name: "Aggregate" })).toBeVisible();
  await expect(page.getByText("bullish: 1")).toBeVisible();
  await expect(page.locator(".adm-bullet-list").getByText("Rotate into WOON", { exact: true })).toBeVisible();
  await expect(page.getByText("The swarm reads a bullish tilt across the panel.")).toBeVisible();
});

// AC: lifecycle actions — confirm+reason required, synchronous state-change
// response (never a 202 job envelope — no jobId/existing field exists on this
// backend), idempotent no-op handling, and a visible 409 error.
test("swarm admin: lifecycle action requires confirm+reason, shows the new state, idempotent reuse, and 409", async ({ page }) => {
  await mockSwarmApi(page);
  await signIn(page, "/admin/swarm/sessions/sess-1");

  let capturedBody: unknown = null;
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/close$/, async (route) => {
    capturedBody = route.request().postDataJSON();
    return route.fulfill(jsonReply({ ok: true, status: 200, session: { id: "sess-1", state: "window_closed", version: 3 } }));
  });

  await page.getByTestId("session-action-close").click();
  await page.getByTestId("action-confirm-submit").click();
  await expect(page.getByText("Reason must be 10–500 characters.")).toBeVisible();

  await page.getByTestId("action-reason").fill("Closing the window ahead of schedule.");
  await page.getByTestId("action-confirm-submit").click();
  await expect(page.getByTestId("action-result")).toContainText("window_closed");
  // No `expectedVersion` — the backend never exposes a session's current
  // version over any GET route, and the field is optional when omitted.
  expect(capturedBody).toMatchObject({ reason: "Closing the window ahead of schedule." });
  expect(capturedBody).not.toHaveProperty("expectedVersion");
  expect(capturedBody).not.toHaveProperty("version");

  // Re-open the session detail in `window_closed` (aggregate/reopen/cancel are
  // legal from there) to exercise the idempotent no-op branch on aggregate.
  await mockSwarmApi(page, { session: sessionSummary({ state: "window_closed" }) });
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/aggregate$/, (route) =>
    route.fulfill(jsonReply({ ok: true, status: 200, idempotent: true, session: { id: "sess-1", state: "window_closed", version: 3 } })));
  await page.goto("/admin/swarm/sessions/sess-1");
  await page.getByTestId("session-action-aggregate").click();
  await page.getByTestId("action-reason").fill("Aggregating after window close.");
  await page.getByTestId("action-confirm-submit").click();
  await expect(page.getByTestId("action-result")).toContainText("idempotent");

  // A concurrent state change surfaces the server's 409 clearly.
  await page.route(/\/api\/swarm\/admin\/sessions\/sess-1\/cancel$/, (route) =>
    route.fulfill(jsonReply({ ok: false, status: 409, error: "terminal_state:published" }, 409)));
  await page.getByTestId("session-action-cancel").click();
  await page.getByTestId("action-reason").fill("Cancelling due to topic deprecation.");
  await page.getByTestId("action-confirm-submit").click();
  await expect(page.getByTestId("action-error")).toContainText("409");
});

// Audit filters/rendering/redaction coverage moved: issue #159 originally
// shipped its own standalone /admin/audit page + fictional camelCase
// AdminAuditEntry contract, but #155/PR #170's real, backend-backed audit
// feed (snake_case AdminAuditRow, GET /api/admin/audit) landed as an
// in-shell /admin section first — see admin-surface.spec.ts for its
// dedicated, real-shape coverage. The standalone page was a duplicate and
// was removed (PR #172).

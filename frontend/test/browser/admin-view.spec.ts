import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

// Same vendor-script interception as spa.spec.ts: serve Alpine (+ chart/p5) from
// node_modules so the SPA boots without reaching a CDN. The admin view only needs
// Alpine, but we mock all three to match the shared boot.
const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

const ADMIN_PASSWORD = "demo-password";

// ── Fixture payloads for the mocked admin API (issue #157 / docs/plan-admin-
// surface.md §6.3). The real backend routes are delivered by issue #155; these
// browser tests exercise the frontend contract entirely against page.route
// mocks per the issue's own test-plan instruction, never a live backend. ──────

const OVERVIEW_FIXTURE = {
  queueCounts: { pending: 2, running: 1, succeeded: 40, failed: 1, dead: 1, cancelled: 0 },
  alerts: [
    { id: "a1", level: "dead", kind: "queue", message: "1 job is dead and needs a manual retry." },
    { id: "a2", level: "stale", kind: "research", message: "late-cycle-signals is 3 days stale." },
  ],
  nextSchedules: [
    { kind: "regime.classify", enabled: true, nextRunAt: "2026-07-16T22:30:00.000Z" },
    { kind: "research.refresh", enabled: true, nextRunAt: "2026-07-16T23:00:00.000Z" },
  ],
};

const EMPTY_OVERVIEW = { queueCounts: {}, alerts: [], nextSchedules: [] };

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
    seenTokens.push(req.headers()["x-admin-token"] ?? "");
    requestedPaths.push(`${method} ${p}${url.search}`);

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

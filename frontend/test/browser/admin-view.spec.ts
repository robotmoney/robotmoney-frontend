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

// Fixture payloads for the read-only admin API. job_runs.output/error ARE the logs.
const JOBS_FIXTURE = {
  jobs: [
    { id: 42, kind: "analytics.run", status: "succeeded", priority: 0, attempts: 1, max_attempts: 5,
      run_after: "2026-07-13T20:00:00.000Z", locked_at: null, locked_by: null, last_error: null,
      created_at: "2026-07-13T19:59:00.000Z", updated_at: "2026-07-13T20:01:00.000Z" },
    { id: 41, kind: "regime.classify", status: "failed", priority: 0, attempts: 5, max_attempts: 5,
      run_after: "2026-07-13T19:50:00.000Z", locked_at: null, locked_by: null, last_error: "boom: upstream 500",
      created_at: "2026-07-13T19:40:00.000Z", updated_at: "2026-07-13T19:55:00.000Z" },
  ],
  schedules: [
    { id: 1, kind: "analytics.run", cron: "*/1 * * * *", timezone: "UTC", enabled: true,
      last_enqueued_at: "2026-07-13T20:00:00.000Z", next_run_at: "2026-07-13T20:02:00.000Z" },
  ],
  summary: { byStatus: { succeeded: 1, failed: 1 }, byKind: { "analytics.run": 1, "regime.classify": 1 } },
};

const JOB_DETAIL = {
  job: JOBS_FIXTURE.jobs[0],
  runs: [
    { id: 900, job_id: 42, kind: "analytics.run", started_at: "2026-07-13T20:00:00.000Z",
      finished_at: "2026-07-13T20:01:00.000Z", status: "succeeded", error: null,
      output: { ran: true, note: "analytics ok", signals: 7 } },
  ],
};

const RUNS_FIXTURE = { runs: JOB_DETAIL.runs };

async function mockAdminApi(page: Page): Promise<void> {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  const jsonReply = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  // Register the LIST route first and the DETAIL route second so the more specific
  // detail matcher (checked first) wins for /api/admin/jobs/<id>.
  await page.route("**/api/admin/auth", (route) => route.fulfill(jsonReply({ ok: true })));
  await page.route("**/api/admin/runs**", (route) => route.fulfill(jsonReply(RUNS_FIXTURE)));
  await page.route(/\/api\/admin\/jobs(\?|$)/, (route) => route.fulfill(jsonReply(JOBS_FIXTURE)));
  await page.route(/\/api\/admin\/jobs\/\d+/, (route) => route.fulfill(jsonReply(JOB_DETAIL)));
}

test("admin view: login gate → jobs table → per-run log <pre>", async ({ page }) => {
  await mockAdminApi(page);

  await page.goto("/admin");

  // The login gate shows first (no stored token). The dashboard tables exist in
  // the DOM but are hidden by the parent x-show until authenticated.
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("table.adm-table").first()).not.toBeVisible();

  // Submit a password → POST /api/admin/auth (mocked ok) → dashboard loads.
  await page.locator(".adm-input").fill("demo-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // Jobs table renders the fixture rows.
  await expect(page.getByRole("cell", { name: "analytics.run" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "regime.classify" }).first()).toBeVisible();

  // Open a job → its run's output renders as a pretty-printed JSON log <pre>.
  // (The error <pre> is present but hidden since error is null, so target the
  // output log by its content.)
  await page.locator("table.adm-table tbody tr.adm-row").first().click();
  const log = page.locator(".adm-log").filter({ hasText: "analytics ok" });
  await expect(log).toBeVisible();
  await expect(log).toContainText("\"note\": \"analytics ok\"");
});

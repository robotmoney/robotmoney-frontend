import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

// Covers the schedule-toggle and audit-log controls added by issue #155
// (docs/architecture.md US-Q1 schedule-toggle acceptance / US-A3) on top of the #157 sectioned admin
// shell (adminSurfaceView / alpine/views/admin-surface.js). Overview-alert
// rendering, dead-job retry, and login/polling/403 behavior are already
// covered by admin-view.spec.ts — this file only exercises the NEW routes:
// PATCH /api/admin/schedules/:id and GET /api/admin/audit.
const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

const ADMIN_PASSWORD = "demo-password";

const OVERVIEW_FIXTURE = {
  serverDate: "2026-07-16",
  queueCounts: { pending: 1, running: 0, succeeded: 10, failed: 0, dead: 1, cancelled: 0 },
  alerts: [{ id: "a1", level: "dead", kind: "queue", message: "1 job is dead and needs a manual retry." }],
  enabledAnalyticsSchedules: [],
  nextSwarmEvent: null,
};

const JOBS_FIXTURE = {
  jobs: [
    { id: 41, kind: "regime.classify", status: "dead", priority: 0, attempts: 5, max_attempts: 5,
      run_after: "2026-07-15T22:30:00.000Z", locked_at: null, locked_by: null, last_error: "boom",
      created_at: "2026-07-15T22:20:00.000Z", updated_at: "2026-07-15T22:31:00.000Z" },
  ],
  schedules: [
    { id: 1, kind: "regime.classify", cron: "30 22 * * *", timezone: "UTC", enabled: true,
      last_enqueued_at: "2026-07-15T22:30:00.000Z", next_run_at: "2026-07-16T22:30:00.000Z" },
    { id: 6, kind: "swarm.open_session", cron: "0 6 * * *", timezone: "UTC", enabled: false,
      last_enqueued_at: null, next_run_at: null },
  ],
  summary: { byStatus: { dead: 1 }, byKind: { "regime.classify": 1 } },
};

const AUDIT_FIXTURE = {
  items: [
    { id: 1, request_id: "r1", actor: "admin", action: "retry_job", target_type: "job", target_id: "42",
      reason: "recovering", outcome: "succeeded", at: "2026-07-16T00:00:00.000Z" },
  ],
  nextCursor: null,
};

function jsonReply(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

function mockAdminApi(page: Page): void {
  for (const [url, file] of Object.entries(vendorScripts)) {
    page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  page.route("**/api/admin/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();

    if (method === "POST" && p === "/api/admin/auth") return route.fulfill(jsonReply({ ok: true }));
    if (method === "GET" && p === "/api/admin/overview") return route.fulfill(jsonReply(OVERVIEW_FIXTURE));
    if (method === "GET" && p === "/api/admin/jobs") return route.fulfill(jsonReply(JOBS_FIXTURE));
    if (method === "GET" && p === "/api/admin/runs") return route.fulfill(jsonReply({ runs: [] }));
    if (method === "GET" && p === "/api/admin/audit") return route.fulfill(jsonReply(AUDIT_FIXTURE));
    if (method === "PATCH" && /^\/api\/admin\/schedules\/\d+$/.test(p)) {
      return route.fulfill(jsonReply({ item: { id: 1, kind: "regime.classify", cron: "30 22 * * *", enabled: false }, auditRequestId: "r2" }));
    }
    return route.fulfill(jsonReply({ error: `no mock for ${method} ${p}` }));
  });
}

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Admin password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".adm-nav")).toBeVisible();
}

test("admin schedules: toggle button is hidden for swarm demo rows and PATCHes for analytics rows", async ({ page }) => {
  mockAdminApi(page);
  await login(page);

  await page.getByRole("button", { name: "Queue", exact: true }).click();
  page.once("dialog", (d) => d.accept("operational toggle for the browser test"));

  const analyticsRow = page.locator("tr").filter({ hasText: "regime.classify" }).first();
  const swarmRow = page.locator("tr").filter({ hasText: "swarm.open_session" }).first();
  await expect(swarmRow.getByText("legacy/demo")).toBeVisible();
  await expect(swarmRow.getByRole("button")).toHaveCount(0);

  const [patchRequest] = await Promise.all([
    page.waitForRequest(/\/api\/admin\/schedules\/1$/),
    analyticsRow.getByRole("button", { name: /Disable|Enable/ }).click(),
  ]);
  expect(patchRequest.method()).toBe("PATCH");
  const body = patchRequest.postDataJSON() as { enabled: boolean; reason: string };
  expect(body.enabled).toBe(false);
  expect(body.reason).toBe("operational toggle for the browser test");
});

test("admin audit: renders redacted rows from the audit feed", async ({ page }) => {
  mockAdminApi(page);
  await login(page);

  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.locator(".adm-nav__link--active")).toHaveText("Audit");
  await expect(page.getByText("retry_job")).toBeVisible();
  await expect(page.getByText("job:42")).toBeVisible();
});

test("admin audit: actor/action/target filters re-issue the audit request with query params", async ({ page }) => {
  mockAdminApi(page);
  await login(page);
  await page.getByRole("button", { name: "Audit", exact: true }).click();

  const [auditRequest] = await Promise.all([
    page.waitForRequest((req) => req.url().includes("/api/admin/audit") && req.url().includes("actor=admin")),
    page.getByLabel("Filter by actor").fill("admin").then(() =>
      page.getByRole("button", { name: "Apply", exact: true }).click()),
  ]);
  expect(auditRequest.method()).toBe("GET");
});

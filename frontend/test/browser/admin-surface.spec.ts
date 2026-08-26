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

const ADMIN_PASSWORD = "smoke-password";

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
  page.route("**/config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.RM_CONFIG = { API_BASE_URL: '' };",
  }));
  page.route("**/api/admin/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();

    if (method === "GET" && p === "/api/admin/is-claimed") return route.fulfill(jsonReply({ claimed: true }));
    if (method === "POST" && p === "/api/admin/claim") return route.fulfill(jsonReply({ recoveryCode: "claim-recovery-code" }));
    if (method === "POST" && p === "/api/admin/auth") return route.fulfill(jsonReply({ ok: true }));
    if (method === "POST" && p === "/api/admin/password-change") return route.fulfill(jsonReply({ ok: true, recoveryCode: "changed-recovery-code" }));
    if (method === "POST" && p === "/api/admin/password-recover") return route.fulfill(jsonReply({ recoveryCode: "replacement-recovery-code" }));
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

test("admin auth: claim displays the one-time recovery code before continuing to sign in", async ({ page }) => {
  mockAdminApi(page);
  await page.route("**/api/admin/is-claimed", (route) => route.fulfill(jsonReply({ claimed: false })));

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Claim Admin", exact: true })).toBeVisible();
  await page.getByLabel("Setup token").fill("my-setup-token");
  await page.getByLabel("New durable password").fill("my-new-password");

  const [claimRequest] = await Promise.all([
    page.waitForRequest("**/api/admin/claim"),
    page.getByRole("button", { name: "Claim", exact: true }).click(),
  ]);
  expect(claimRequest.method()).toBe("POST");
  expect(claimRequest.postDataJSON()).toEqual({ password: "my-new-password" });
  expect(claimRequest.headers()["x-admin-token"]).toBe("my-setup-token");

  const recoveryNotice = page.getByTestId("claim-recovery-code");
  await expect(recoveryNotice).toContainText("claim-recovery-code");
  await expect(recoveryNotice).toContainText("It will not be shown again.");
  await page.getByRole("button", { name: "Continue to sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("admin password change posts the new credential, confirms success, and surfaces an error", async ({ page }) => {
  mockAdminApi(page);
  await login(page);

  await page.getByLabel("Current Password").fill(ADMIN_PASSWORD);
  await page.getByLabel("New Password").fill("a durable replacement password");
  const [changeRequest] = await Promise.all([
    page.waitForRequest("**/api/admin/password-change"),
    page.getByRole("button", { name: "Change Password", exact: true }).click(),
  ]);
  expect(changeRequest.headers()["x-admin-token"]).toBe(ADMIN_PASSWORD);
  expect(changeRequest.postDataJSON()).toEqual({
    currentPassword: ADMIN_PASSWORD,
    newPassword: "a durable replacement password",
  });
  const changeNotice = page.getByTestId("change-recovery-code");
  await expect(changeNotice).toContainText("Password changed successfully.");
  await expect(changeNotice).toContainText("changed-recovery-code");
  await expect(changeNotice).toContainText("It will not be shown again.");
  expect(await page.evaluate(() => sessionStorage.getItem("rm_admin_token"))).toBe("a durable replacement password");

  await page.route("**/api/admin/password-change", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: "Current password is incorrect." }));
  await page.getByLabel("Current Password").fill("wrong password");
  await page.getByLabel("New Password").fill("another durable password");
  await page.getByRole("button", { name: "Change Password", exact: true }).click();
  await expect(page.getByText("API 403: Current password is incorrect.", { exact: true })).toBeVisible();
});

test("admin password recovery posts code and password, confirms success, and surfaces an error", async ({ page }) => {
  mockAdminApi(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Lost password? Use recovery code", exact: true }).click();
  await page.getByLabel("Recovery code").fill("initial-recovery-code");
  await page.getByLabel("New password").fill("a recovered durable password");
  const [recoveryRequest] = await Promise.all([
    page.waitForRequest("**/api/admin/password-recover"),
    page.getByRole("button", { name: "Reset password", exact: true }).click(),
  ]);
  expect(recoveryRequest.headers()["x-admin-token"]).toBeUndefined();
  expect(recoveryRequest.postDataJSON()).toEqual({
    recoveryCode: "initial-recovery-code",
    newPassword: "a recovered durable password",
  });
  await expect(page.getByText("replacement-recovery-code", { exact: true })).toBeVisible();
  await expect(page.getByText("Save this code immediately. It will not be shown again.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await page.getByRole("button", { name: "Lost password? Use recovery code", exact: true }).click();
  await page.route("**/api/admin/password-recover", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: "Recovery code is invalid." }));
  await page.getByLabel("Recovery code").fill("invalid-recovery-code");
  await page.getByLabel("New password").fill("another recovered password");
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByText("API 400: Recovery code is invalid.", { exact: true })).toBeVisible();
});

test("admin schedules: toggle button is hidden for swarm smoke rows and PATCHes for analytics rows", async ({ page }) => {
  mockAdminApi(page);
  await login(page);

  await page.getByRole("button", { name: "Queue", exact: true }).click();
  page.once("dialog", (d) => d.accept("operational toggle for the browser test"));

  const analyticsRow = page.locator("tr").filter({ hasText: "regime.classify" }).first();
  const swarmRow = page.locator("tr").filter({ hasText: "swarm.open_session" }).first();
  await expect(swarmRow.getByText("legacy/smoke")).toBeVisible();
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

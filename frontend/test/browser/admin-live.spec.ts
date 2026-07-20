import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";

// ── Live-backend admin contract check (issue #185) ──────────────────────────
//
// Closes the #159 knowledge-capture gap: admin-view.spec.ts and
// admin-surface.spec.ts mock 100% of admin network calls (page.route), so a
// backend contract change (path/verb/field rename) can ship undetected — this
// is exactly the class of bug #159 shipped and caught only by manual review
// (see backend/src/api/routes/committee-admin.ts + committee-overview.js's
// own header comment: "topics/members list envelopes are keyed `subjects`/
// `members` (not `items`)"). This spec drives the real admin UI against the
// LIVE demo backend the required e2e job already boots (scripts/lib/
// demo-main.ts), with ZERO page.route mocking of any admin endpoint — only
// the vendor CDN scripts (Alpine/Chart/p5) are intercepted, via the
// mockVendorScripts() helper shared with admin-view.spec.ts (./vendor-
// scripts.ts), which is unrelated to backend contract fidelity. It lives in
// its own plain module (not a *.spec.ts file) because Playwright refuses to
// let one discovered test file import another.
//
// It intentionally does NOT modify, replace, or duplicate the existing mocked
// admin-view.spec.ts / admin-surface.spec.ts suites (those stay the fast,
// deterministic, page.route-driven UI-behavior coverage); this file is
// narrowly scoped to proving the live wire contract the frontend actually
// reads matches what the live backend actually sends.

// ── Loud-skip guard (test-coverage-policy.md invariant 1) ──────────────────
// scripts/lib/demo-main.ts always exports BACKEND_URL + ADMIN_TOKEN into the
// environment before invoking `bun run test:browser` (the required e2e job's
// "browser checks" step) — see lines ~111 (process.env.ADMIN_TOKEN = …) and
// ~951-952 (run(["bun","run","test:browser"], …, { ...process.env,
// BACKEND_URL: backendUrl }, …)). If either is missing here, this spec must
// fail loudly at module load — never silently skip every test in this file
// (which would print a false "0 failed" green while asserting nothing).
const BACKEND_URL = process.env.BACKEND_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!BACKEND_URL || !ADMIN_TOKEN) {
  throw new Error(
    "admin-live.spec.ts requires BACKEND_URL and ADMIN_TOKEN in the environment " +
      "to exercise the live admin backend (test-coverage-policy.md invariant 1: " +
      "loud-skip, never silent-skip) — refusing an all-skip false-green run. " +
      "Run via `bun run scripts/demo.ts` (or set both env vars manually before " +
      "`bunx playwright test frontend/test/browser/admin-live.spec.ts`).",
  );
}

const ADMIN_PASSWORD = ADMIN_TOKEN;

/** Sign into the real /admin shell with the real ADMIN_TOKEN. Only vendor CDN
 * scripts are intercepted — every admin request reaches the live backend. */
async function login(page: Page): Promise<void> {
  await mockVendorScripts(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Admin password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".adm-nav")).toBeVisible();
}

test("admin-live: overview loads the real GET /api/admin/overview envelope (queueCounts/alerts/enabledAnalyticsSchedules)", async ({ page }) => {
  const overviewResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/admin/overview" && res.request().method() === "GET",
  );

  await login(page);

  const res = await overviewResponsePromise;
  expect(res.ok()).toBe(true);
  const body = await res.json();

  // The real response envelope keys the frontend reads (admin-surface.js
  // loadOverview(): overview.queueCounts / overview.alerts /
  // overview.enabledAnalyticsSchedules) — a future rename of any of these in
  // backend/src/admin/overview.ts fails this assertion against live data,
  // not just a fixture that was hand-updated to match. This assertion itself
  // caught a real bug during #185's development: admin.html previously read
  // the never-shipped `overview.nextSchedules` key, so the "Next scheduled
  // runs" table silently rendered empty in production — fixed alongside this
  // test (contract/src/admin.d.ts's AdminOverview.enabledAnalyticsSchedules
  // is, and always was, the real key).
  expect(body).toHaveProperty("queueCounts");
  expect(body).toHaveProperty("alerts");
  expect(body).toHaveProperty("enabledAnalyticsSchedules");
  expect(Array.isArray(body.alerts)).toBe(true);
  expect(Array.isArray(body.enabledAnalyticsSchedules)).toBe(true);

  // Overview is the default landing section — assert the real payload
  // actually reached the DOM (proves the frontend parsed these exact keys,
  // not that a request merely round-tripped).
  await expect(page.locator(".adm-nav__link--active")).toHaveText("Overview");
  // The overview section only renders once `overview` is truthy
  // (admin.html: `<template x-if="overview">`) — its presence proves
  // loadOverview() resolved without throwing.
  await expect(page.locator(".adm-tiles")).toBeVisible();

  // admin.html's schedule table keeps an x-show="...length === 0" fallback
  // <tr> ("No enabled schedules.") in the DOM at all times (just hidden),
  // alongside the x-for rows — an unscoped locator overcounts by one when
  // the list is non-empty. Scope to :visible, same fix as the committee
  // tab-row locators below.
  const scheduleRows = page.locator(".rm-table.adm-table tbody tr:visible");
  if (body.enabledAnalyticsSchedules.length === 0) {
    await expect(page.getByText("No enabled schedules.")).toBeVisible();
  } else {
    await expect(scheduleRows).toHaveCount(body.enabledAnalyticsSchedules.length);
    await expect(
      page.getByRole("cell", { name: body.enabledAnalyticsSchedules[0].kind, exact: true }).first(),
    ).toBeVisible();
  }

  if (body.alerts.length === 0) {
    await expect(page.getByText("No active alerts — everything healthy.")).toBeVisible();
  } else {
    await expect(page.getByText(body.alerts[0].message)).toBeVisible();
  }
});

test("admin-live: committee subjects/members lists load the real 'subjects'/'members' envelopes (not 'items')", async ({ page }) => {
  await login(page);

  // loadAll() (committee-overview.js) fires subjects + members (+ sessions)
  // concurrently the moment /admin/committee initializes — register both
  // listeners BEFORE navigating so neither request races past us.
  const subjectsResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/committee/admin/subjects" && res.request().method() === "GET",
  );
  const membersResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/committee/admin/members" && res.request().method() === "GET",
  );

  await page.goto("/admin/committee");
  await expect(page.getByRole("heading", { name: "Committee Operations" })).toBeVisible();

  const [subjectsRes, membersRes] = await Promise.all([subjectsResponsePromise, membersResponsePromise]);
  expect(subjectsRes.ok()).toBe(true);
  expect(membersRes.ok()).toBe(true);

  const subjectsBody = await subjectsRes.json();
  const membersBody = await membersRes.json();

  // The exact envelope keys the frontend reads (committee-overview.js
  // loadAll(): topicsRes.subjects / membersRes.members) — asserted against
  // the LIVE backend/src/api/routes/committee-admin.ts response, not a
  // hand-maintained fixture. `items` is the invented, never-shipped key an
  // earlier draft of this surface assumed (issue #159's post-merge notes);
  // asserting its absence pins the real contract, not the wrong one.
  expect(Array.isArray(subjectsBody.subjects)).toBe(true);
  expect(subjectsBody).not.toHaveProperty("items");
  expect(Array.isArray(membersBody.members)).toBe(true);
  expect(membersBody).not.toHaveProperty("items");

  // committee-overview.js's loadAll() throws — surfacing `error` in the
  // toolbar — if either response is missing its expected array key ("admin
  // subjects response missing 'subjects' array" / "... 'members' array").
  // No error banner here proves the frontend actually parsed these exact
  // keys from the live response, not merely that a request round-tripped.
  await expect(page.locator(".adm-toolbar .rm-error")).toBeHidden();

  // committee.html's Topics/Members/Sessions tabs are toggled with x-show,
  // not x-if — the other two tabs' <table class="adm-table"> rows stay in
  // the DOM (just display:none) while Topics is active, so an unscoped
  // "table.adm-table tbody tr.adm-row" locator overcounts by summing every
  // tab's rows. Playwright's :visible pseudo-class excludes elements hidden
  // by any ancestor's display:none, scoping the count to the active tab.
  const topicRows = page.locator("table.adm-table tbody tr.adm-row:visible");
  if (subjectsBody.subjects.length === 0) {
    await expect(page.getByText("No topics yet.")).toBeVisible();
  } else {
    await expect(topicRows).toHaveCount(subjectsBody.subjects.length);
    await expect(page.getByRole("cell", { name: subjectsBody.subjects[0].id, exact: true }).first()).toBeVisible();
  }

  await page.getByRole("button", { name: "Members", exact: true }).click();

  // memberFilter defaults to "active" (committee-overview.js) — apply the
  // same filter to the live payload before asserting the rendered row count.
  const activeMembers = (membersBody.members as Array<{ status?: string }>).filter(
    (m) => (m.status || "applied") === "active",
  );
  const memberRows = page.locator("table.adm-table tbody tr.adm-row:visible");
  if (activeMembers.length === 0) {
    await expect(page.getByText("No members in this state.")).toBeVisible();
  } else {
    await expect(memberRows).toHaveCount(activeMembers.length);
  }
});

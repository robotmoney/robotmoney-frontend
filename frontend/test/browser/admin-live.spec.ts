import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";

// ── Live-backend admin contract check (issue #185) ──────────────────────────
//
// Closes the #159 knowledge-capture gap: admin-view.spec.ts and
// admin-surface.spec.ts mock 100% of admin network calls (page.route), so a
// backend contract change (path/verb/field rename) can ship undetected — this
// is exactly the class of bug #159 shipped and caught only by manual review
// (see backend/src/api/routes/swarm-admin.ts + swarm-overview.js's
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
// spawn env of `bun run test:browser` (the required e2e job's "browser
// checks" step) — see its `run(["bun","run","test:browser"], …,
// { ...process.env, BACKEND_URL: backendUrl, ADMIN_TOKEN: adminPassword }, …)`
// call. If either is missing here, this spec must fail loudly at module load
// — never silently skip every test in this file (which would print a false
// "0 failed" green while asserting nothing).
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

// The demo starts unclaimed so the test itself performs its one-time setup
// claim. Keep the durable credential distinct from the ephemeral setup token:
// that is the real lifecycle this spec is meant to exercise, and it means the
// subsequent live UI requests prove the claimed-password path rather than the
// legacy per-boot token fallback.
const ADMIN_PASSWORD = "admin-live-durable-password";

test.beforeAll(async ({ request }) => {
  const status = await request.get("/api/admin/is-claimed");
  expect(status.ok()).toBe(true);
  const { claimed } = await status.json();

  if (!claimed) {
    const claim = await request.post("/api/admin/claim", {
      headers: { "X-Admin-Token": ADMIN_TOKEN },
      data: { password: ADMIN_PASSWORD },
    });
    expect(claim.ok()).toBe(true);
  }

  // `beforeAll` also runs on a Playwright retry. The claim is deliberately
  // idempotent at the test-fixture level: once the first attempt claimed the
  // demo, retries authenticate with the known durable password instead of
  // trying to spend the one-time setup token again.
  const auth = await request.post("/api/admin/auth", {
    headers: { "X-Admin-Token": ADMIN_PASSWORD },
  });
  expect(auth.ok()).toBe(true);
});

/** Sign into the real /admin shell with the claimed durable password. Only vendor CDN
 * scripts are intercepted — every admin request reaches the live backend. */
async function login(page: Page): Promise<void> {
  await mockVendorScripts(page);
  await page.goto("/admin");

  // A live demo backend boots unclaimed; the first test to run must claim it,
  // and subsequent tests (or a manually claimed backend) just sign in.
  const claimHeading = page.getByRole("heading", { name: "Claim Admin", exact: true });
  const signInHeading = page.getByRole("heading", { name: "Sign in", exact: true });
  await expect.poll(async () => (
    await claimHeading.isVisible() || await signInHeading.isVisible()
  )).toBe(true);

  if (await claimHeading.isVisible()) {
    await page.getByLabel("Setup token").fill(ADMIN_PASSWORD);
    await page.getByLabel("New durable password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Claim", exact: true }).click();
  } else {
    await page.getByLabel("Admin password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }

  await expect(page.locator(".adm-nav")).toBeVisible();

  // admin-surface.js's startPolling() begins re-fetching the active section
  // every 5s the instant sign-in resolves. Against the LIVE backend this spec
  // deliberately does not mock, that data changes between polls (alert
  // levels, schedule counts, job progress) — so a test that captures one
  // response and, a few `await expect(...)` calls later, still expects the
  // DOM to match it can lose a genuine race if a poll tick lands in between
  // (observed in CI: an alert message and a schedule-row count each
  // mismatched on separate runs). Immediately clicking the app's own real
  // "Pause polling" control (not a network mock — admin endpoints stay 100%
  // live and unmocked) freezes the shell before the 5s interval can fire
  // again, so every assertion in this file compares against the same single
  // response it captured.
  await page.getByRole("button", { name: "Pause polling", exact: true }).click();
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

  // From here on, build DOM-comparison expectations from Alpine's LIVE
  // reactive state, not the `body` captured above from a single network
  // response — `body` can go stale by the time later assertions run against
  // this spec's deliberately-unmocked, still-changing live backend. Reading
  // `overview` back out of the live Alpine component is the same object
  // admin.html's x-text bindings render from.
  //
  // Critically, `readLiveOverview()` is called freshly IMMEDIATELY BEFORE
  // EACH comparison below, never captured once and reused: holding a single
  // snapshot across two temporally-separated assertions just moves the same
  // stale-vs-live race up one level (CI hit exactly this — a snapshot taken
  // before the schedule check still matched, then went stale by the time
  // the alert check ran several `await expect(...)` calls later, e.g. an
  // async error-retry path or a background reload touching `overview`
  // in between). Re-reading right before each use means every individual
  // comparison is internally consistent with the DOM at that instant, even
  // if `overview` changes between the two checks.
  async function readLiveOverview() {
    const overview = await page.evaluate(() => {
      const el = document.querySelector('[x-data="adminSurfaceView"]');
      // @ts-expect-error -- Alpine is a global from the vendor CDN script, not a module import
      return window.Alpine.$data(el).overview;
    });
    expect(overview).not.toBeNull();
    return overview;
  }

  // admin.html's schedule table keeps an x-show="...length === 0" fallback
  // <tr> ("No enabled schedules.") in the DOM at all times (just hidden),
  // alongside the x-for rows — an unscoped locator overcounts by one when
  // the list is non-empty. Scope to :visible, same fix as the swarm
  // tab-row locators below.
  const scheduleOverview = await readLiveOverview();
  const scheduleRows = page.locator(".rm-table.adm-table tbody tr:visible");
  if (scheduleOverview.enabledAnalyticsSchedules.length === 0) {
    await expect(page.getByText("No enabled schedules.")).toBeVisible();
  } else {
    await expect(scheduleRows).toHaveCount(scheduleOverview.enabledAnalyticsSchedules.length);
    await expect(
      page.getByRole("cell", { name: scheduleOverview.enabledAnalyticsSchedules[0].kind, exact: true }).first(),
    ).toBeVisible();
  }

  const alertOverview = await readLiveOverview();
  if (alertOverview.alerts.length === 0) {
    await expect(page.getByText("No active alerts — everything healthy.")).toBeVisible();
  } else {
    // Deliberately NOT asserting an exact alert message string here.
    // backend/src/admin/overview.ts derives each alert's level/message from
    // regime.classify / research.refresh's live run status, and this demo
    // environment's schedules fire on a ~2min cron — so "regime.classify
    // last run: not_run" can flip to a real timestamp/result mid-test, on a
    // different alert each run. The alert *count* is structurally stable
    // (one row per production kind + regime + research signal, a fixed set
    // independent of their live status), so assert that instead of any
    // live-changing text.
    const alertRows = page.locator(".adm-alerts > div");
    await expect(alertRows).toHaveCount(alertOverview.alerts.length);
    await expect(alertRows.first()).toBeVisible();
  }
});

test("admin-live: swarm subjects/members lists load the real 'subjects'/'members' envelopes (not 'items')", async ({ page }) => {
  await login(page);

  // loadAll() (swarm-overview.js) fires subjects + members (+ sessions)
  // concurrently the moment /admin/swarm initializes — register both
  // listeners BEFORE navigating so neither request races past us.
  const subjectsResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/swarm/admin/subjects" && res.request().method() === "GET",
  );
  const membersResponsePromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/swarm/admin/members" && res.request().method() === "GET",
  );

  await page.goto("/admin/swarm");
  await expect(page.getByRole("heading", { name: "Swarm Operations" })).toBeVisible();

  const [subjectsRes, membersRes] = await Promise.all([subjectsResponsePromise, membersResponsePromise]);
  expect(subjectsRes.ok()).toBe(true);
  expect(membersRes.ok()).toBe(true);

  const subjectsBody = await subjectsRes.json();
  const membersBody = await membersRes.json();

  // The exact envelope keys the frontend reads (swarm-overview.js
  // loadAll(): topicsRes.subjects / membersRes.members) — asserted against
  // the LIVE backend/src/api/routes/swarm-admin.ts response, not a
  // hand-maintained fixture. `items` is the invented, never-shipped key an
  // earlier draft of this surface assumed (issue #159's post-merge notes);
  // asserting its absence pins the real contract, not the wrong one.
  expect(Array.isArray(subjectsBody.subjects)).toBe(true);
  expect(subjectsBody).not.toHaveProperty("items");
  expect(Array.isArray(membersBody.members)).toBe(true);
  expect(membersBody).not.toHaveProperty("items");

  // swarm-overview.js's loadAll() throws — surfacing `error` in the
  // toolbar — if either response is missing its expected array key ("admin
  // subjects response missing 'subjects' array" / "... 'members' array").
  // No error banner here proves the frontend actually parsed these exact
  // keys from the live response, not merely that a request round-tripped.
  await expect(page.locator(".adm-toolbar .rm-error")).toBeHidden();

  // swarm.html's Topics/Members/Sessions tabs are toggled with x-show,
  // not x-if — the other two tabs' <table class="adm-table"> rows stay in
  // the DOM (just display:none) while Topics is active, so an unscoped
  // "table.adm-table tbody tr.adm-row" locator overcounts by summing every
  // tab's rows. Playwright's :visible pseudo-class excludes elements hidden
  // by any ancestor's display:none, scoping the count to the active tab.
  //
  // The row-count expectations below are built from Alpine's LIVE reactive
  // state (this.topics / this.members), not the subjectsBody/membersBody
  // captured above — same defensive pattern as the overview test's
  // liveOverview read: comparing against the exact object swarm.html's
  // x-for bindings render from can never diverge from the DOM, whereas two
  // independent reads of a live, unmocked backend legitimately can (this is
  // the same class of race that hit the overview test's assertions in CI).
  const topicRows = page.locator("table.adm-table tbody tr.adm-row:visible");
  const liveTopics: Array<{ id: string }> = await page.evaluate(() => {
    const el = document.querySelector('[x-data="adminSwarmOverview"]');
    // @ts-expect-error -- Alpine is a global from the vendor CDN script, not a module import
    return window.Alpine.$data(el).topics;
  });
  if (liveTopics.length === 0) {
    await expect(page.getByText("No topics yet.")).toBeVisible();
  } else {
    await expect(topicRows).toHaveCount(liveTopics.length);
    await expect(page.getByRole("cell", { name: liveTopics[0].id, exact: true }).first()).toBeVisible();
  }

  await page.getByRole("button", { name: "Members", exact: true }).click();

  // memberFilter defaults to "active" (swarm-overview.js) — apply the
  // same filter to the live payload before asserting the rendered row count.
  const liveMembers: Array<{ status?: string }> = await page.evaluate(() => {
    const el = document.querySelector('[x-data="adminSwarmOverview"]');
    // @ts-expect-error -- Alpine is a global from the vendor CDN script, not a module import
    return window.Alpine.$data(el).members;
  });
  const activeMembers = liveMembers.filter((m) => (m.status || "applied") === "active");
  const memberRows = page.locator("table.adm-table tbody tr.adm-row:visible");
  if (activeMembers.length === 0) {
    await expect(page.getByText("No members in this state.")).toBeVisible();
  } else {
    await expect(memberRows).toHaveCount(activeMembers.length);
  }
});

// Functional + visual coverage for the analytics dashboard's router layout
// composition, sidebar/topbar shell, and session-token gate hook (issue
// #380, P0.3/P0.4 — docs/bot-analytics-ui-port-plan.md §5.0's own
// acceptance list). Builds directly on #379's dash.css/dash-ui.js/dash-
// icons.svg (dash-styleguide.spec.ts already covers those primitives) — this
// spec only exercises the NEW router.js layout extension, views/dash/
// _layout.html + alpine/views/dash-shell.js (sidebar/topbar), and alpine/
// views/dash-gate.js (the gate), all of which are new in this issue.
//
// The gate reuses the EXISTING POST /api/admin/auth (§5.0, §8 D2) —
// mocked here via page.route exactly like admin-surface.spec.ts's
// mockAdminApi(), rather than a live-backend spec: that endpoint's live wire
// contract is already proven end to end by admin-live.spec.ts, so re-driving
// it live again from a second surface would be redundant coverage, not new
// signal.
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

function mockDashGateApi(page: Page): void {
  page.route("**/api/admin/auth", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fulfill({ status: 405, body: "" });
    // adminPost() (lib/api.js) sends no request body for this call — the
    // whole "which token" question is answered by the X-Admin-Token header.
    const token = req.headers()["x-admin-token"];
    if (token === ACCESS_KEY) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "bad token" }) });
  });
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockDashGateApi(page);
});

test("home has no .a3-shell element — the dash layout never leaks onto marketing pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-dash-shell]")).toHaveCount(0);
});

test("unauthenticated /list shows the gate; wrong key errors; the right key reveals the shell", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/list");

  await expect(page.locator("[data-dash-gate]")).toBeVisible();
  await expect(page.locator("[data-dash-sidebar]")).not.toBeVisible();

  await page.locator("[data-dash-password-input]").fill("wrong-key");
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-login-error]")).toBeVisible();
  await expect(page.locator("[data-dash-login-error]")).toHaveText("Incorrect access key.");
  await expect(page.locator("[data-dash-gate]")).toBeVisible();

  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-dash-sidebar]")).toBeVisible();
  await expect(page.locator("[data-outlet]")).toBeVisible();
});

test("the eye toggle reveals the typed access key", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/list");

  const input = page.locator("[data-dash-password-input]");
  await input.fill(ACCESS_KEY);
  await expect(input).toHaveAttribute("type", "password");
  await page.locator("[data-dash-toggle-password]").click();
  await expect(input).toHaveAttribute("type", "text");
});

test("submit button is disabled until an access key is typed", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/list");

  const submit = page.locator("[data-dash-submit]");
  await expect(submit).toBeDisabled();
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await expect(submit).toBeEnabled();
});

test("the gate links to /submit for a pre-auth community commit", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/list");
  await expect(page.locator("[data-dash-submit-link]")).toHaveAttribute("href", "/submit");
});

test("/submit is reachable without authenticating, even though it shares the dash layout", async ({ page }) => {
  // /submit ships real content as of issue #393 (P4.4) — its own
  // submit-view.spec.ts covers the CommitForm in depth; this spec only
  // re-proves the shell-level contract (ungated, under the dash layout).
  await page.route("**/api/dashboards/entities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entities: [] }) }));
  await page.goto("/");
  await navigate(page, "/submit");
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-dash-sidebar]")).toBeVisible();
  await expect(page.locator("[data-outlet] [data-submit-view]")).toBeVisible();
});

async function login(page: Page): Promise<void> {
  await navigate(page, "/list");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-sidebar]")).toBeVisible();
}

test("sidebar marks the active nav link per route and updates the topbar title", async ({ page }) => {
  await page.goto("/");
  await login(page);

  await expect(page.locator("[data-dash-nav-link][href='/list']")).toHaveClass(/is-active/);
  await expect(page.locator("[data-dash-topbar-title]")).toHaveText("List");

  await page.locator("[data-dash-nav-link][href='/about']").click();
  await expect(page.locator("[data-dash-nav-link][href='/about']")).toHaveClass(/is-active/);
  await expect(page.locator("[data-dash-nav-link][href='/list']")).not.toHaveClass(/is-active/);
  await expect(page.locator("[data-dash-topbar-title]")).toHaveText("About");
});

test('title falls back to "Dashboard" on a non-nav dashboard route', async ({ page }) => {
  await page.goto("/");
  await login(page);

  await navigate(page, "/agents/clawd");
  await expect(page.locator("[data-dash-topbar-title]")).toHaveText("Dashboard");
});

test("collapsing the sidebar switches it to the icon rail and back", async ({ page }) => {
  await page.goto("/");
  await login(page);

  await expect(page.locator("[data-dash-shell]")).not.toHaveClass(/a3-shell--collapsed/);
  await expect(page.locator("[data-dash-nav-link] .a3-shell__nav-label").first()).toBeVisible();

  await page.locator("[data-dash-collapse-toggle]").click();
  await expect(page.locator("[data-dash-shell]")).toHaveClass(/a3-shell--collapsed/);
  await expect(page.locator("[data-dash-nav-link] .a3-shell__nav-label").first()).toBeHidden();

  await page.locator("[data-dash-collapse-toggle]").click();
  await expect(page.locator("[data-dash-shell]")).not.toHaveClass(/a3-shell--collapsed/);
});

test("navigating between two dashboard routes reuses the mounted layout and keeps sidebar-collapse state", async ({ page }) => {
  await page.goto("/");
  await login(page);

  // Collapse, then navigate to a second dashboard route sharing the same
  // layout — a torn-down-and-rebuilt layout would lose this Alpine state.
  await page.locator("[data-dash-collapse-toggle]").click();
  await expect(page.locator("[data-dash-shell]")).toHaveClass(/a3-shell--collapsed/);

  await page.locator("[data-dash-nav-link][href='/list2']").click();
  await expect(page.locator("[data-dash-topbar-title]")).toHaveText("List v2 (WIP)");
  await expect(page.locator("[data-dash-shell]")).toHaveClass(/a3-shell--collapsed/);
  // Exactly one shell root mounted — the layout was reused, not duplicated.
  await expect(page.locator("[data-dash-shell]")).toHaveCount(1);
});

test("Sign Out clears the session and returns to the gate on the same route", async ({ page }) => {
  await page.goto("/");
  await login(page);

  await page.locator("[data-dash-signout]").click();
  await expect(page.locator("[data-dash-gate]")).toBeVisible();
  await expect(page.locator("[data-dash-sidebar]")).not.toBeVisible();
  await expect(page).toHaveURL(/\/list$/);
});

test("a stored session token is re-verified on mount without a login-form flash", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => sessionStorage.setItem("rm_admin_token", key), ACCESS_KEY);
  await navigate(page, "/list");
  await expect(page.locator("[data-dash-sidebar]")).toBeVisible();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
});

test("an invalid stored token falls back to the gate", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("rm_admin_token", "stale-token"));
  await navigate(page, "/list");
  await expect(page.locator("[data-dash-gate]")).toBeVisible();
});

test("dash gate matches its visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await navigate(page, "/list");
  await expect(page.locator("[data-dash-gate]")).toBeVisible();
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("dash-gate-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

test("dash shell (sidebar + topbar) matches its visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await login(page);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("dash-shell-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

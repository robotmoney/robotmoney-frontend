// Render + interaction tests for /market + /dashboard — "Agent Activity Log"
// TerminalFeed (issue #392, docs/bot-analytics-ui-port-plan.md §5.6, P4.1).
// Same harness as list-view.spec.ts: vendor CDN scripts are served from
// node_modules, the gate's POST /api/admin/auth is mocked (its own wire
// contract is proven by admin-live.spec.ts), and GET /api/dashboards/activity
// is stubbed with a deterministic DTO so entry formatting, agent links, and
// status glyphs are all network-free and reproducible. Also captures the
// full-page visual golden (§7 pixel-QA method: Playwright's own committed
// baseline, 1% maxDiffPixelRatio from playwright.config.ts, NOT a diff
// against a foreign screenshot); the blinking cursor animation is frozen by
// playwright.config.ts's global `animations: "disabled"`.
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "demo-access-key";

const ENTRIES = {
  entries: [
    {
      id: "e1",
      occurredAt: "2026-07-31T14:32:00.000Z",
      agentId: "a1",
      agentName: "Agent One",
      agentHref: "/agents/a1",
      actionType: "submit_metrics",
      status: "success",
      commitSummary: "reported 30d revenue",
      submittedBy: "agent-one",
      approvedBy: "committee-bot",
    },
    {
      id: "e2",
      occurredAt: "2026-07-31T14:10:00.000Z",
      agentId: null,
      agentName: "Unknown",
      agentHref: null,
      actionType: "market_event",
      status: "pending",
      commitSummary: null,
      submittedBy: null,
      approvedBy: null,
    },
    {
      id: "e3",
      occurredAt: "2026-07-31T13:55:00.000Z",
      agentId: "a2",
      agentName: "Agent Two",
      agentHref: "/agents/a2",
      actionType: "register_agent",
      status: "rejected",
      commitSummary: "duplicate registration",
      submittedBy: "agent-two",
      approvedBy: null,
    },
  ],
};

function mockGateApi(page: Page): void {
  page.route("**/api/admin/auth", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fulfill({ status: 405, body: "" });
    const token = req.headers()["x-admin-token"];
    if (token === ACCESS_KEY) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "bad token" }) });
  });
}

function mockActivityApi(page: Page, body: unknown = ENTRIES): void {
  page.route("**/api/dashboards/activity", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

async function login(page: Page, path: "/market" | "/dashboard"): Promise<void> {
  await page.goto("/");
  await navigate(page, path);
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-activity-view]")).toBeVisible();
  await expect(page.locator("[data-activity-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

test("/dashboard renders the TerminalFeed with entries newest-first", async ({ page }) => {
  mockActivityApi(page);
  await login(page, "/dashboard");
  await expect(page.locator("[data-activity-terminal]")).toBeVisible();
  const entries = page.locator("[data-activity-entry]");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText("reported 30d revenue");
  await expect(entries.nth(1)).toContainText("market_event");
  await expect(entries.nth(2)).toContainText("duplicate registration");
});

test("/market aliases the exact same fragment as /dashboard", async ({ page }) => {
  mockActivityApi(page);
  await login(page, "/market");
  await expect(page.locator("[data-activity-terminal]")).toBeVisible();
  await expect(page.locator("[data-activity-entry]")).toHaveCount(3);
});

test("status glyphs map success/pending/rejected to their own color class", async ({ page }) => {
  mockActivityApi(page);
  await login(page, "/dashboard");
  const status = page.locator("[data-activity-status]");
  await expect(status.nth(0)).toHaveText("✓");
  await expect(status.nth(0)).toHaveClass(/a3-terminal__status--success/);
  await expect(status.nth(1)).toHaveText("⏳");
  await expect(status.nth(1)).toHaveClass(/a3-terminal__status--pending/);
  await expect(status.nth(2)).toHaveText("✗");
  await expect(status.nth(2)).toHaveClass(/a3-terminal__status--rejected/);
});

test("an entry with an agent renders a live link; one with no agent renders plain text", async ({ page }) => {
  mockActivityApi(page);
  await login(page, "/dashboard");
  await expect(page.locator("[data-activity-entry]").nth(0).locator("[data-activity-agent-link]")).toHaveAttribute("href", "/agents/a1");
  await expect(page.locator("[data-activity-entry]").nth(1).locator("[data-activity-agent-link]")).toHaveCount(0);
});

test("an empty feed renders an honest empty-terminal line, never a fabricated row", async ({ page }) => {
  mockActivityApi(page, { entries: [] });
  await login(page, "/dashboard");
  await expect(page.locator("[data-activity-empty]")).toBeVisible();
  await expect(page.locator("[data-activity-empty]")).toHaveText("No activity recorded yet.");
  await expect(page.locator("[data-activity-entry]")).toHaveCount(0);
});

test("full page visual golden at 1440x900", async ({ page }) => {
  mockActivityApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/dashboard");
  await expect(page).toHaveScreenshot("dashboard-activity-full.png", { fullPage: true });
});

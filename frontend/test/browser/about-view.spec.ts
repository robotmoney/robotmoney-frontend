// Render tests for /about (issue #395, docs/bot-analytics-ui-port-plan.md
// §5.16, P4.2). Same harness as dashboard-view.spec.ts: vendor CDN scripts
// are served from node_modules and the gate's POST /api/admin/auth is mocked
// (its own wire contract is proven by admin-live.spec.ts). /about is fully
// static content (§6: "static") — no API to stub.
//
// No visual golden here: /about is not one of the 7 pixel-QA pages
// designated in §7 — see the note on issue #395's acceptance criteria.
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "demo-access-key";

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

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await navigate(page, "/about");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-about-view]")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

test("renders the intro section", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-about-intro]")).toContainText("RobotMoney Analytics");
});

test("renders all four entity types with their distinct border-color classes", async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-about-entity="agent"]')).toHaveClass(/a3-about__entity--agent/);
  await expect(page.locator('[data-about-entity="coin"]')).toHaveClass(/a3-about__entity--coin/);
  await expect(page.locator('[data-about-entity="vault"]')).toHaveClass(/a3-about__entity--vault/);
  await expect(page.locator('[data-about-entity="wallet"]')).toHaveClass(/a3-about__entity--wallet/);
  await expect(page.locator("[data-about-entities] .metric-card")).toHaveCount(4);
});

test("renders the discovery section reworded to this repo's curated-roster reality", async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-about-discovery-row="roster"]')).toContainText("Curated roster");
  await expect(page.locator('[data-about-discovery-row="snapshots"]')).toContainText("Daily snapshots");
  await expect(page.locator('[data-about-discovery-row="submissions"]')).toContainText("Community submissions");
});

test("renders inclusion criteria with a link to /list", async ({ page }) => {
  await login(page);
  const criteria = page.locator("[data-about-criteria]");
  await expect(criteria).toContainText("Inclusion Criteria");
  await expect(criteria.locator('a[href="/list"]')).toBeVisible();
});

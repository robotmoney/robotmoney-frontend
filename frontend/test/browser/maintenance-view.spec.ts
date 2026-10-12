// The site shows a banner for a scheduled maintenance window and a maintenance
// view for an active one (issue 1220 (c)). /api/** is stubbed by the spec, so
// it needs no live backend.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The document the site serves at "/" (also what the preview server wraps in a
// frame), so the page runs top-level on every origin this spec meets.
const SHELL = join(process.cwd(), "frontend/public/index.html");

async function stubMaintenance(page: Page, body: unknown): Promise<void> {
  await page.route(/\/$/, (route) =>
    route.request().resourceType() === "document"
      ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readFileSync(SHELL, "utf8") })
      : route.continue(),
  );
  await page.route("**/api/status/maintenance", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
  // Everything else under /api answers an empty object so the page can settle.
  await page.route(/\/api\/(?!status\/maintenance)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

test("a scheduled window shows a banner with the start and expected end", async ({ page }) => {
  await stubMaintenance(page, {
    state: "scheduled",
    startsAt: "2030-01-01T10:00:00.000Z",
    expectedEnd: "2030-01-01T11:00:00.000Z",
    message: "Database upgrade.",
  });
  await page.goto("/");
  const banner = page.locator("[data-maintenance=scheduled]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Scheduled maintenance starts");
  await expect(banner).toContainText("Expected back");
  await expect(banner).toContainText("Database upgrade.");
});

test("an active window shows the maintenance view with the expected end", async ({ page }) => {
  await stubMaintenance(page, {
    state: "active",
    startsAt: "2030-01-01T10:00:00.000Z",
    expectedEnd: "2030-01-01T11:00:00.000Z",
    message: null,
  });
  await page.goto("/");
  const view = page.locator("[data-maintenance=active]");
  await expect(view).toBeVisible();
  await expect(view).toContainText("undergoing scheduled maintenance");
  await expect(view).toContainText("Expected back");
});

test("no window shows nothing", async ({ page }) => {
  await stubMaintenance(page, { state: "none", startsAt: null, expectedEnd: null, message: null });
  await page.goto("/");
  await expect(page.locator("[data-maintenance]")).toHaveCount(0);
});

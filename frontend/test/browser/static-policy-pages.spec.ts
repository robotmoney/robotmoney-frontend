// Render tests for /terms and /privacy (issue #395) — new static site policy
// pages, not part of the bot-analytics UI port (docs/bot-analytics-ui-port-
// plan.md's 20 routes are all analytics-dashboard pages). Same convention as
// views/disclaimer.html: plain public marketing fragment, no gate, no API.
// (/disclaimer itself ships with zero dedicated Playwright coverage today —
// this file gives its two new siblings real coverage rather than following
// that precedent.)
import { expect, test } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
});

test("/terms renders the Terms of Service page and links back home", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/terms");
  await expect(page.locator("h1.tos__h1")).toContainText("Terms of");
  await expect(page.locator("a.tos__back-link")).toHaveAttribute("href", "/");
  await expect(page).toHaveTitle("Terms of Service — Robot Money");
});

test("/privacy renders the Privacy Policy page and links back home", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/privacy");
  await expect(page.locator("h1.pp__h1")).toContainText("Privacy");
  await expect(page.locator("a.pp__back-link")).toHaveAttribute("href", "/");
  await expect(page).toHaveTitle("Privacy Policy — Robot Money");
});

test("both pages are indexable (no noindex override, unlike the gated dashboard routes)", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/terms");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index, follow/);
  await navigate(page, "/privacy");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index, follow/);
});

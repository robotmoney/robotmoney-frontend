// Shared gate-mocking helper for gated dash-list specs (issue #386). Same
// POST /api/admin/auth mock + login flow dash-shell.spec.ts hand-rolls for
// its own gate coverage — three sibling specs in THIS issue
// (dash-lobster/dash-vaults/dash-wallets.spec.ts) need the identical setup,
// so it is factored out here rather than tripled. Deliberately NOT
// *.spec.ts (see vendor-scripts.ts's own comment on why: Playwright refuses
// to let a discovered test file import another).
import { expect, type Page } from "@playwright/test";
import { navigate } from "./navigation.ts";

export const DASH_ACCESS_KEY = "smoke-access-key";

export function mockDashGateApi(page: Page): void {
  page.route("**/api/admin/auth", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fulfill({ status: 405, body: "" });
    const token = req.headers()["x-admin-token"];
    if (token === DASH_ACCESS_KEY) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "bad token" }) });
  });
}

export async function loginToDash(page: Page, path: string): Promise<void> {
  await navigate(page, path);
  await page.locator("[data-dash-password-input]").fill(DASH_ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-sidebar]")).toBeVisible();
}

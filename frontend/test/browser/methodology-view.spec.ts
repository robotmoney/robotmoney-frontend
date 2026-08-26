// Render tests for /methodology — "Scoring Methodology" (issue #395,
// docs/bot-analytics-ui-port-plan.md §5.15, P4.3). Same harness as
// dashboard-view.spec.ts: vendor CDN scripts are served from node_modules and
// the gate's POST /api/admin/auth is mocked (its own wire contract is proven
// by admin-live.spec.ts). Unlike dashboard-view.spec.ts, there is no
// view-specific API to stub — /methodology is fully static content (§6: "n/a
// (static)"), including the Agent Consensus Voting table, which renders the
// original's own honest empty state directly (no `agent_score_votes` table
// exists yet — P1.6 has not landed, see methodology.html's header comment).
//
// No visual golden here: /methodology is not one of the 7 pixel-QA pages
// designated in §7 (gate screen, /list, /list3 drawer, /projects mid-scroll,
// /agents/:id dossier, /dashboard terminal, /wallets/:id drawer) — see the
// note on issue #395's acceptance criteria.
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

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
  await navigate(page, "/methodology");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-methodology-view]")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

test("renders the three weighted productivity factors with their exact weights", async ({ page }) => {
  await login(page);
  await expect(page.locator('[data-methodology-weight="40"]')).toContainText("40%");
  await expect(page.locator('[data-methodology-weight="30"]')).toHaveCount(2);
  await expect(page.locator('[data-methodology-progress="frequency"]')).toHaveCSS("width", /.*/);
});

test("progress bar widths match each factor's weight", async ({ page }) => {
  await login(page);
  const freq = page.locator('[data-methodology-progress="frequency"]');
  const success = page.locator('[data-methodology-progress="success"]');
  const recency = page.locator('[data-methodology-progress="recency"]');
  await expect(freq).toHaveAttribute("style", /width:\s*40%/);
  await expect(success).toHaveAttribute("style", /width:\s*30%/);
  await expect(recency).toHaveAttribute("style", /width:\s*30%/);
});

test("renders the worked example calculation", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-methodology-example-body]")).toContainText("Clawd");
  await expect(page.locator("[data-methodology-example-body]")).toContainText("90.1");
});

test("renders the Task Throughput data-source explanation", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-methodology-throughput]")).toContainText("30-day");
});

test("Agent Consensus Voting renders the Coming Soon badge and an honest empty table, never a fabricated row", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-methodology-coming-soon]")).toHaveText("Coming Soon");
  const rows = page.locator("[data-methodology-votes-table] tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(page.locator("[data-methodology-votes-empty]")).toContainText(
    "No votes cast yet — consensus voting is coming soon",
  );
});

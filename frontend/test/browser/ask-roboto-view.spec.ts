// Render + interaction tests for /ask-mr-roboto — "Ask Mr. Roboto" AI
// recommendation assistant + side-by-side comparison tool (issue #394,
// docs/bot-analytics-ui-port-plan.md §5.18, P5.1). Same harness as
// agents-view.spec.ts: vendor CDN scripts are served from node_modules, the
// gate's POST /api/admin/auth is mocked, and GET /api/dashboards/agents (the
// SAME endpoint /agents already reads) is stubbed with a deterministic DTO
// so the matcher, its explanations, and the comparison table are all
// network-free and reproducible. The matcher's own rule logic (matchAgents)
// has its own dedicated pure-function coverage in
// scripts/tests/unit/ask-roboto-matcher.test.ts — this file proves the real
// UI wires that logic up correctly end to end (input → matches rendered →
// compare toggle → comparison table), not the rule algebra itself.
//
// No dedicated visual golden here: docs/bot-analytics-ui-port-plan.md §7
// names exactly 7 designated pixel-QA visual-golden pages for cost control
// on the single Blacksmith runner (gate screen, /list, /list3 drawer,
// /projects mid-scroll, /agents/:id dossier, /dashboard terminal,
// /wallets/:id drawer) — /ask-mr-roboto is not one of them, same correction
// already recorded on issue #393 (/submit) and #382/#383.
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "demo-access-key";

const AGENTS_RESPONSE = {
  agents: [
    {
      id: "a1", name: "Alpha Trader", protocol: "x402", isFacilitator: false, active: true,
      score: 90, x402Txns: 40, x402VolumeUsd: 5000, balanceUsd: 8000, walletAddress: "0xaaaa000000000000000000000000000000aaaa",
      sparkline: { score: [], x402: [], balance: [] },
    },
    {
      id: "a2", name: "Beta Bot", protocol: "olas", isFacilitator: false, active: false,
      score: 40, x402Txns: 2, x402VolumeUsd: 100, balanceUsd: 500, walletAddress: null,
      sparkline: { score: [], x402: [], balance: [] },
    },
    {
      id: "f1", name: "Gamma Facilitator", protocol: "facilitator", isFacilitator: true, active: true,
      score: 60, x402Txns: 10, x402VolumeUsd: 900, balanceUsd: 1200, walletAddress: "0xffff000000000000000000000000000000ffff",
      sparkline: { score: [], x402: [], balance: [] },
    },
  ],
  summary: { active: 2, idle: 1, x402Txns: 52, x402VolumeUsd: 6000, totalBalanceUsd: 9700 },
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

function mockAgentsApi(page: Page, body: unknown = AGENTS_RESPONSE): void {
  page.route("**/api/dashboards/agents", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await navigate(page, "/ask-mr-roboto");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-ask-roboto-view]")).toBeVisible();
  await expect(page.locator("[data-ask-roboto-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

test("renders the suggestion pills before any question is asked, and no visual golden is claimed for this page", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);
  await expect(page.locator("[data-ask-roboto-pills] [data-ask-roboto-pill]")).toHaveCount(4);
  await expect(page.locator("[data-ask-roboto-log] [data-ask-roboto-message]")).toHaveCount(0);
});

test("clicking a suggestion asks the question and matches deterministically on protocol + active status", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  await page.locator('[data-ask-roboto-pill]', { hasText: "Find an active x402 agent" }).click();

  await expect(page.locator("[data-ask-roboto-message]")).toHaveCount(2); // user + roboto
  await expect(page.locator('[data-ask-roboto-message][data-role="user"] [data-ask-roboto-user-text]')).toHaveText("Find an active x402 agent");

  const response = page.locator('[data-ask-roboto-message][data-role="roboto"]');
  await expect(response.locator("[data-ask-roboto-response-text]")).toContainText("protocol: x402");
  await expect(response.locator("[data-ask-roboto-response-text]")).toContainText("active only");
  await expect(response.locator("[data-ask-roboto-match]")).toHaveCount(1);
  await expect(response.locator("[data-ask-roboto-match]")).toHaveAttribute("data-agent-id", "a1");
  await expect(response.locator("[data-ask-roboto-match-link]")).toHaveText("Alpha Trader");
});

test("a free-text query with no recognized keywords falls back to the full roster sorted by composite score", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  await page.locator("[data-ask-roboto-input]").fill("who should I use");
  await page.locator("[data-ask-roboto-send]").click();

  const response = page.locator('[data-ask-roboto-message][data-role="roboto"]');
  const ids = await response.locator("[data-ask-roboto-match]").evaluateAll((els) => els.map((el) => el.getAttribute("data-agent-id")));
  expect(ids).toEqual(["a1", "f1", "a2"]); // score 90, 60, 40
});

test("a protocol with no matching rows shows the honest fallback message instead of a dead-end empty result", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  await page.locator("[data-ask-roboto-input]").fill("acp agent please");
  await page.locator("[data-ask-roboto-send]").click();

  const response = page.locator('[data-ask-roboto-message][data-role="roboto"]');
  await expect(response.locator("[data-ask-roboto-response-text]")).toContainText("No agent matched those filters exactly");
  await expect(response.locator("[data-ask-roboto-match]")).toHaveCount(3);
});

test("toggling Compare on two matched agents renders a side-by-side table with their real metrics, and removing one hides it again", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  await page.locator("[data-ask-roboto-input]").fill("top agent");
  await page.locator("[data-ask-roboto-send]").click();

  await expect(page.locator("[data-ask-roboto-compare]")).toHaveCount(0);

  await page.locator('[data-ask-roboto-match][data-agent-id="a1"] [data-ask-roboto-compare-toggle]').click();
  await expect(page.locator("[data-ask-roboto-compare]")).toHaveCount(0); // still only 1 selected

  await page.locator('[data-ask-roboto-match][data-agent-id="f1"] [data-ask-roboto-compare-toggle]').click();
  await expect(page.locator("[data-ask-roboto-compare]")).toBeVisible();

  const table = page.locator("[data-ask-roboto-compare-table]");
  await expect(table.locator("[data-ask-roboto-compare-col]")).toHaveCount(2);
  await expect(table.locator("thead")).toContainText("Alpha Trader");
  await expect(table.locator("thead")).toContainText("Gamma Facilitator");

  const rows = table.locator("tbody tr");
  await expect(rows.nth(0)).toContainText("X402"); // protocol row for a1 (f1 shows "Facilitator")
  await expect(rows.nth(0)).toContainText("Facilitator");
  await expect(rows.nth(2)).toContainText("90.0"); // score row
  await expect(rows.nth(2)).toContainText("60.0");
  await expect(rows.nth(3)).toContainText("$5.0K"); // x402 volume row
  await expect(rows.nth(3)).toContainText("$900.00");

  await page.locator('[data-ask-roboto-compare-remove][data-agent-id="a1"]').click();
  await expect(page.locator("[data-ask-roboto-compare]")).toHaveCount(0); // back under 2 selected
});

test("empty agents list renders an honest empty state and an honest no-match response, never fabricated data", async ({ page }) => {
  mockAgentsApi(page, { agents: [], summary: { active: 0, idle: 0, x402Txns: 0, x402VolumeUsd: 0, totalBalanceUsd: 0 } });
  await login(page);

  await expect(page.locator("[data-ask-roboto-empty]")).toBeVisible();
  await expect(page.locator("[data-ask-roboto-empty]")).toContainText("No agents tracked yet");

  await page.locator("[data-ask-roboto-input]").fill("anything");
  await page.locator("[data-ask-roboto-send]").click();
  await expect(page.locator('[data-ask-roboto-message][data-role="roboto"] [data-ask-roboto-response-text]')).toHaveText("No agents tracked yet — nothing to match against.");
  await expect(page.locator("[data-ask-roboto-match]")).toHaveCount(0);
});

test("pressing Enter in the input submits the question, same as clicking Ask", async ({ page }) => {
  mockAgentsApi(page);
  await login(page);

  await page.locator("[data-ask-roboto-input]").fill("highest volume agent");
  await page.locator("[data-ask-roboto-input]").press("Enter");

  await expect(page.locator('[data-ask-roboto-message][data-role="user"] [data-ask-roboto-user-text]')).toHaveText("highest volume agent");
  const ids = await page
    .locator('[data-ask-roboto-message][data-role="roboto"] [data-ask-roboto-match]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-agent-id")));
  expect(ids).toEqual(["a1", "f1", "a2"]); // x402 volume 5000, 900, 100
  // The input clears after a successful ask.
  await expect(page.locator("[data-ask-roboto-input]")).toHaveValue("");
});

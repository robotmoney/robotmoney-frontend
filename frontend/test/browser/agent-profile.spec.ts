// Render + interaction tests for /agents/:id — the "Money-agent dossier"
// AgentProfile (issue #390, docs/bot-analytics-ui-port-plan.md §5.8, P3.2).
// Same harness as agents-view.spec.ts: vendor CDN scripts served from
// node_modules, the gate's POST /api/admin/auth mocked, and
// GET /api/dashboards/agents/:id stubbed with a deterministic DTO so the
// dossier header, money strip, evidence rail, chart, usage metrics, and
// linked-asset tables are all network-free and reproducible. Also captures
// the dossier-header visual golden (§7 pixel-QA method — AgentProfile is one
// of the plan's 7 designated highest-risk pages: "the app's one sans-serif
// negative-tracking design outlier").
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

const RICH_AGENT = {
  id: "a1",
  name: "Clawd",
  protocol: "x402",
  isFacilitator: false,
  active: true,
  description: "A dossier test project agent.",
  websiteUrl: "https://example.test",
  twitterHandle: "clawdbot",
  walletAddress: "0xabcdef0000000000000000000000000000beef",
  walletBalanceUsd: 4_200,
  createdAt: "2026-01-05T00:00:00.000Z",
  enrichedAt: new Date().toISOString(),
  confidence: "high",
  score: 61.5,
  x402Score: 61.5,
  x402Txns: 12,
  x402VolumeUsd: 500,
  x402Resources: 3,
  revenue30dUsd: 200,
  cumulativeRevenueUsd: 1_000,
  productivityScore: 40,
  x402Sparkline: [10, 20, 15, 25, 30, 28, 40],
  evidence: { wallet: "verified", moneyIn: "verified", x402: "verified", identity: "verified", freshness: "verified" },
  whyIncluded: [
    "Wallet balance verified against a tracked, matched address.",
    "Trailing-30d revenue recorded ($200.00).",
    "x402 usage recorded (12 txns).",
    "Website or social identity on file.",
    "Enrichment data is fresh (within 14 days).",
  ],
  openGaps: [],
  vaults: [{ id: "v1", name: "Clawd Vault", strategyType: "erc4626", tvlUsd: 50_000, apy: 4.5 }],
  wallets: [
    { id: "w1", label: "Clawd Wallet", address: "0xabcdef0000000000000000000000000000beef", chain: "base", balanceUsd: 4_200, isAgentWallet: true },
    { id: "w2", label: "Treasury", address: "0x2222222222222222222222222222222222bbbb", chain: "base", balanceUsd: 900, isAgentWallet: false },
  ],
};

const SPARSE_AGENT = {
  ...RICH_AGENT,
  id: "a2",
  name: "Sparse Agent",
  description: null,
  websiteUrl: null,
  twitterHandle: null,
  walletAddress: null,
  walletBalanceUsd: null,
  enrichedAt: null,
  confidence: null,
  score: 0,
  x402Score: null,
  x402Txns: 0,
  x402VolumeUsd: 0,
  x402Resources: 0,
  revenue30dUsd: 0,
  cumulativeRevenueUsd: null,
  productivityScore: null,
  x402Sparkline: [],
  evidence: { wallet: "missing", moneyIn: "missing", x402: "missing", identity: "missing", freshness: "missing" },
  whyIncluded: [],
  openGaps: [
    "No wallet address linked yet.",
    "No recorded revenue yet.",
    "No x402 transaction history recorded yet.",
    "No website or social link on file.",
    "Enrichment data is stale or missing.",
  ],
  vaults: [],
  wallets: [],
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

function mockAgentApi(page: Page, body: unknown, status = 200): void {
  page.route("**/api/dashboards/agents/*", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}

async function login(page: Page, path: string): Promise<void> {
  await page.goto("/");
  await navigate(page, path);
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-agent-profile-view]")).toBeVisible();
  await expect(page.locator("[data-agent-loading]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

test("renders the dossier header from GET /api/dashboards/agents/:id", async ({ page }) => {
  mockAgentApi(page, RICH_AGENT);
  await login(page, "/agents/a1");
  await expect(page.locator("[data-dossier-name]")).toHaveText("Clawd");
  await expect(page.locator("[data-dossier-status]")).toHaveText("Active");
  await expect(page.locator("[data-dossier-protocol]")).toHaveText("X402");
  await expect(page.locator("[data-dossier-confidence]")).toContainText("HIGH CONFIDENCE");
  await expect(page.locator("[data-dossier-desc]")).toHaveText(RICH_AGENT.description);
  await expect(page.locator("[data-dossier-website]")).toBeVisible();
  await expect(page.locator("[data-dossier-twitter]")).toContainText("@clawdbot");
});

test("MoneyStrip renders 30d revenue, wallet status, x402 flow, freshness, and evidence score", async ({ page }) => {
  mockAgentApi(page, RICH_AGENT);
  await login(page, "/agents/a1");
  await expect(page.locator("[data-money-revenue30d]")).toContainText("$200.00");
  await expect(page.locator("[data-money-wallet-status]")).toContainText("Verified liquid wallet balance");
  await expect(page.locator("[data-money-x402]")).toContainText("$500.00");
  await expect(page.locator("[data-money-score]")).toContainText("61.5");
});

test("evidence rail shows all 5 rows verified for a fully-evidenced agent", async ({ page }) => {
  mockAgentApi(page, RICH_AGENT);
  await login(page, "/agents/a1");
  const rows = page.locator("[data-evidence-row]");
  await expect(rows).toHaveCount(5);
  for (const key of ["wallet", "moneyIn", "x402", "identity", "freshness"]) {
    await expect(page.locator(`[data-evidence-row="${key}"] .a3-badge`)).toHaveText("Verified");
  }
  await expect(page.locator("[data-why-list] li")).toHaveCount(5);
  await expect(page.locator("[data-gap-list] li")).toHaveCount(1); // the "no open gaps" fallback line
  await expect(page.locator("[data-lever-panel]")).toHaveCount(0); // no gaps -> no rank-improvement levers
});

test("performance chart renders when x402 history is nonzero, copy-wallet button copies the address", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  mockAgentApi(page, RICH_AGENT);
  await login(page, "/agents/a1");
  await expect(page.locator("[data-perf-chart-card] canvas")).toBeVisible();
  await expect(page.locator("[data-perf-chart-placeholder]")).toHaveCount(0);

  await page.locator("[data-copy-wallet-btn]").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(RICH_AGENT.walletAddress);
});

test("linked-asset tables render managed vaults and tracked wallets, flagging the agent's own wallet", async ({ page }) => {
  mockAgentApi(page, RICH_AGENT);
  await login(page, "/agents/a1");
  await expect(page.locator("[data-vaults-table] tbody tr")).toHaveCount(1);
  await expect(page.locator("[data-vaults-table]")).toContainText("Clawd Vault");
  await expect(page.locator("[data-wallets-table] tbody tr")).toHaveCount(2);
  await expect(page.locator("[data-wallets-table] tr.is-sorted")).toContainText("Clawd Wallet");
});

test("sparse agent renders honest empty/missing states, not fabricated data", async ({ page }) => {
  mockAgentApi(page, SPARSE_AGENT);
  await login(page, "/agents/a2");
  await expect(page.locator("[data-money-wallet-status]")).toContainText("Wallet missing");
  await expect(page.locator("[data-perf-chart-placeholder]")).toContainText("No attributed x402 payment history yet.");
  await expect(page.locator("[data-vaults-empty]")).toContainText("No vaults linked yet.");
  await expect(page.locator("[data-wallets-empty]")).toContainText("No wallets linked yet.");
  await expect(page.locator("[data-lever-panel] .a3-lever-card")).toHaveCount(3); // 3 of the 5 gaps surfaced as levers
  for (const key of ["wallet", "moneyIn", "x402", "identity", "freshness"]) {
    await expect(page.locator(`[data-evidence-row="${key}"] .a3-badge`)).toHaveText("Missing");
  }
});

test("unknown agent id renders the honest not-found state, never a stub row", async ({ page }) => {
  mockAgentApi(page, { error: "not found" }, 404);
  await page.goto("/");
  await navigate(page, "/agents/does-not-exist");
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-agent-error]")).toContainText("Agent not found.");
  await expect(page.locator("[data-dossier-header]")).toHaveCount(0);
});

test("dossier header visual golden at 1440x900", async ({ page }) => {
  mockAgentApi(page, RICH_AGENT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/agents/a1");
  await expect(page.locator("[data-dossier-header]")).toHaveScreenshot("agent-profile-dossier-header.png");
});

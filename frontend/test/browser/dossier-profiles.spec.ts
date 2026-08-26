// Render + interaction tests for the coin/vault/wallet detail dossiers
// (issue #391, docs/bot-analytics-ui-port-plan.md §5.10/§5.12/§5.14,
// P3.3/P3.4/P3.5): /lobster/:id, /vaults/:id, /wallets/:id. Grouped in one
// spec file (cost control, §7: "per-view functional specs grouped ~3 views
// per spec file where routes share a phase" — these three share P3.x) rather
// than three near-identical files, same convention as list2-view.spec.ts
// grouping agents/coins/vaults/wallets. Same harness as
// agents-view.spec.ts/dash-shell.spec.ts: vendor CDN scripts served from
// node_modules, the gate's POST /api/admin/auth mocked, and each detail
// GET stubbed with a deterministic DTO so this suite is network-free and
// reproducible.
//
// Visual golden: none of these three pages is one of §7's 7 designated
// pixel-QA reference-fidelity shots (that list is gate screen/ /list/ /list3
// drawer/ /projects scroll/ /agents/:id dossier/ /dashboard terminal/
// /wallets/:id drawer — the LAST one specifically means the TokenDetails
// drawer, which this issue does not ship; see this file's wallet-profile
// section below and the issue body for why). No prior sibling PR in this
// phase has actually created the consolidated `dash-visual.spec.ts` §7
// describes either (grep the repo) — every shipped view instead captures its
// own self-regression `toHaveScreenshot` baseline in its OWN spec file
// (agents-view.spec.ts, list-view.spec.ts, list3-view.spec.ts, dashboard-
// view.spec.ts, dash-shell.spec.ts). This file follows that SAME established
// convention: one full-page golden per view, catching accidental CSS
// regressions, not "matches the original app's pixels" fidelity (out of
// scope for these three pages per §7).
import { expect, test, type Page } from "@playwright/test";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ACCESS_KEY = "smoke-access-key";

// Relative to "now" (not fixed calendar dates) so the default 30D chart
// window always has points regardless of when this suite runs.
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

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

function mockApi(page: Page, glob: string, body: unknown, status = 200): void {
  page.route(glob, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}

async function login(page: Page, path: string, viewSelector: string): Promise<void> {
  await page.goto("/");
  await navigate(page, path);
  await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
  await page.locator("[data-dash-submit]").click();
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator(viewSelector)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockGateApi(page);
});

// ── /lobster/:id — CoinProfile ────────────────────────────────────────────

const COIN_PROFILE = {
  id: "c1",
  name: "Test Coin",
  ticker: "TST",
  chain: "base",
  logoUrl: null,
  contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
  priceUsd: 2.5,
  percentChange24h: 3.2,
  marketCapUsd: 900_000,
  fdvUsd: 1_200_000,
  volume24hUsd: 15_000,
  stale: false,
  refreshedAt: new Date().toISOString(),
  priceHistory: [
    { date: daysAgoIso(20), priceUsd: 2.0, marketCapUsd: 800_000, volume24hUsd: 10_000 },
    { date: daysAgoIso(5), priceUsd: 2.5, marketCapUsd: 900_000, volume24hUsd: 15_000 },
  ],
  linkedAgents: [{ id: "a1", name: "Agent One", href: "/agents/a1" }],
};

test.describe("/lobster/:id CoinProfile", () => {
  test("renders identity, price, stats, and linked agents from GET /api/dashboards/coins/:id", async ({ page }) => {
    mockApi(page, "**/api/dashboards/coins/c1", COIN_PROFILE);
    await login(page, "/lobster/c1", "[data-coin-profile-view]");
    await expect(page.locator("[data-coin-profile-name]")).toContainText("Test Coin");
    await expect(page.locator("[data-coin-profile-ticker]")).toHaveText("TST");
    await expect(page.locator("[data-coin-profile-price]")).toHaveText("$2.5000");
    await expect(page.locator("[data-coin-profile-change]")).toHaveText("+3.20%");
    await expect(page.locator("[data-coin-profile-change]")).toHaveClass(/a3-dossier-price-change--up/);
    await expect(page.locator("[data-coin-profile-linked-agents] [data-linked-agent-chip]")).toHaveCount(1);
    await expect(page.locator("[data-coin-profile-linked-agents] [data-linked-agent-chip]")).toHaveText("Agent One");
    // P1.7 dependency notice honestly present (About/rank/ExtLinks not shipped).
    await expect(page.locator("[data-coin-profile-enrichment-notice]")).toContainText("aren't available yet");
  });

  test("period toggle switches the active button", async ({ page }) => {
    mockApi(page, "**/api/dashboards/coins/c1", COIN_PROFILE);
    await login(page, "/lobster/c1", "[data-coin-profile-view]");
    const thirtyD = page.locator('[data-coin-profile-period] [data-period="30d"]');
    await expect(thirtyD).toHaveClass(/is-active/);
    const ninetyD = page.locator('[data-coin-profile-period] [data-period="90d"]');
    await ninetyD.click();
    await expect(ninetyD).toHaveClass(/is-active/);
    await expect(thirtyD).not.toHaveClass(/is-active/);
  });

  test("not-found state renders on a 404", async ({ page }) => {
    mockApi(page, "**/api/dashboards/coins/missing", { error: "not found" }, 404);
    await page.goto("/");
    await navigate(page, "/lobster/missing");
    await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
    await page.locator("[data-dash-submit]").click();
    await expect(page.locator("[data-coin-profile-not-found]")).toBeVisible();
    await expect(page.locator("[data-coin-profile-not-found]")).toContainText("Coin not found");
  });

  test("full page visual golden at 1440x900 (self-regression baseline, not a §7 reference-fidelity shot)", async ({ page }) => {
    mockApi(page, "**/api/dashboards/coins/c1", COIN_PROFILE);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "/lobster/c1", "[data-coin-profile-view]");
    await expect(page).toHaveScreenshot("coin-profile-full.png", { fullPage: true });
  });
});

// ── /vaults/:id — VaultProfile ────────────────────────────────────────────

const VAULT_PROFILE = {
  id: "v1",
  name: "Test Vault",
  protocol: "aave",
  strategyType: "erc4626",
  chain: "base",
  vaultAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
  dataSource: "live",
  tvlUsd: 500_000,
  apy: 0.08,
  lastRebalanceAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  stale: false,
  refreshedAt: new Date().toISOString(),
  tvlHistory: [
    { date: daysAgoIso(20), tvlUsd: 400_000 },
    { date: daysAgoIso(5), tvlUsd: 500_000 },
  ],
  yieldHistory: [],
  linkedAgents: [{ id: "a1", name: "Managing Agent", href: "/agents/a1" }],
  linkedWallets: [{ id: "w1", label: "Vault Wallet", address: "0xw1", chain: "base", balanceUsd: 1_000, href: "/wallets/w1" }],
};

test.describe("/vaults/:id VaultProfile", () => {
  test("renders identity badges, TVL, honest-empty yield history, linked agent, and linked wallets table", async ({ page }) => {
    mockApi(page, "**/api/dashboards/vaults/v1", VAULT_PROFILE);
    await login(page, "/vaults/v1", "[data-vault-profile-view]");
    await expect(page.locator("[data-vault-profile-name]")).toContainText("Test Vault");
    await expect(page.locator("[data-vault-profile-source-badge]")).toHaveText("LIVE");
    await expect(page.locator("[data-vault-profile-tvl]")).toHaveText("$500.0K");
    // D11: never a fabricated yield series — the honest empty state.
    await expect(page.locator("[data-vault-profile-yield-empty]")).toHaveText("No yield history yet.");
    await expect(page.locator("[data-vault-profile-linked-agents] [data-linked-agent-chip]")).toHaveText("Managing Agent");
    await expect(page.locator("[data-vault-profile-wallets-table] tbody tr")).toHaveCount(1);
    await expect(page.locator("[data-vault-profile-wallets-table] tbody tr")).toContainText("Vault Wallet");
  });

  test("a non-live dataSource renders muted, not a fabricated LIVE badge", async ({ page }) => {
    mockApi(page, "**/api/dashboards/vaults/v1", { ...VAULT_PROFILE, dataSource: "static" });
    await login(page, "/vaults/v1", "[data-vault-profile-view]");
    await expect(page.locator("[data-vault-profile-source-badge]")).toHaveText("STATIC");
    await expect(page.locator("[data-vault-profile-source-badge]")).toHaveClass(/a3-badge--muted/);
  });

  test("not-found state renders on a 404", async ({ page }) => {
    mockApi(page, "**/api/dashboards/vaults/missing", { error: "not found" }, 404);
    await page.goto("/");
    await navigate(page, "/vaults/missing");
    await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
    await page.locator("[data-dash-submit]").click();
    await expect(page.locator("[data-vault-profile-not-found]")).toBeVisible();
  });

  test("full page visual golden at 1440x900 (self-regression baseline, not a §7 reference-fidelity shot)", async ({ page }) => {
    mockApi(page, "**/api/dashboards/vaults/v1", VAULT_PROFILE);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "/vaults/v1", "[data-vault-profile-view]");
    await expect(page).toHaveScreenshot("vault-profile-full.png", { fullPage: true });
  });
});

// ── /wallets/:id — WalletProfile ──────────────────────────────────────────

const WALLET_PROFILE = {
  id: "w1",
  label: "Test Wallet",
  category: "treasury",
  chain: "base",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  balanceUsd: 5_000,
  balance30dAgoUsd: 4_000,
  lastTxAt: new Date().toISOString(),
  refreshedAt: new Date().toISOString(),
  stale: false,
  balanceHistory: [
    { date: daysAgoIso(30), balanceUsd: 4_000 },
    { date: daysAgoIso(20), balanceUsd: 4_500 },
    { date: daysAgoIso(10), balanceUsd: 5_000 },
    { date: daysAgoIso(1), balanceUsd: 5_000 },
  ],
  linkedAgent: { id: "a1", name: "Owning Agent", href: "/agents/a1" },
};

test.describe("/wallets/:id WalletProfile", () => {
  test("renders identity, balance + 30d delta, linked agent, and the 800x120 balance sparkline", async ({ page }) => {
    mockApi(page, "**/api/dashboards/wallets/w1", WALLET_PROFILE);
    await login(page, "/wallets/w1", "[data-wallet-profile-view]");
    await expect(page.locator("[data-wallet-profile-label]")).toContainText("Test Wallet");
    await expect(page.locator("[data-wallet-profile-balance]")).toHaveText("$5.0K");
    await expect(page.locator("[data-wallet-profile-balance-delta]")).toContainText("+$1.0K");
    await expect(page.locator("[data-wallet-profile-linked-agent]")).toHaveText("Owning Agent");
    await expect(page.locator("[data-wallet-profile-sparkline] svg")).toHaveCount(1);
    // P1.6 dependency notice honestly present — the plan's OWN documented
    // caveat (§5.14): no wallet_holdings table, no fabricated holdings/tx rows.
    await expect(page.locator("[data-wallet-profile-holdings-notice]")).toContainText("aren't available yet");
  });

  test("stale notice renders per D14 (wallet refresh is unimplemented)", async ({ page }) => {
    mockApi(page, "**/api/dashboards/wallets/w1", { ...WALLET_PROFILE, stale: true });
    await login(page, "/wallets/w1", "[data-wallet-profile-view]");
    await expect(page.locator("[data-wallet-profile-stale-notice]")).toBeVisible();
  });

  test("empty snapshot history renders the honest empty state, not a fabricated line", async ({ page }) => {
    mockApi(page, "**/api/dashboards/wallets/w1", { ...WALLET_PROFILE, balanceHistory: [], balance30dAgoUsd: null, linkedAgent: null });
    await login(page, "/wallets/w1", "[data-wallet-profile-view]");
    await expect(page.locator("[data-wallet-profile-history-empty]")).toHaveText("No snapshot history yet.");
    await expect(page.locator("[data-wallet-profile-sparkline] svg")).toHaveCount(0);
  });

  test("not-found state renders on a 404", async ({ page }) => {
    mockApi(page, "**/api/dashboards/wallets/missing", { error: "not found" }, 404);
    await page.goto("/");
    await navigate(page, "/wallets/missing");
    await page.locator("[data-dash-password-input]").fill(ACCESS_KEY);
    await page.locator("[data-dash-submit]").click();
    await expect(page.locator("[data-wallet-profile-not-found]")).toBeVisible();
  });

  // §7 names "/wallets/:id drawer" as one of the 7 designated pixel-QA
  // reference-fidelity shots — specifically the TokenDetailsDrawer opened
  // over a holding row. This issue does not ship that drawer (P1.6:
  // wallet_holdings has no table, the plan's own §5.14 data caveat), so
  // there is no drawer content to capture yet. This full-page golden is the
  // self-regression baseline for what IS shipped (identity/balance/
  // sparkline/notice) — the drawer-open fidelity shot is a follow-up once
  // P1.6 lands; see the issue body's "Visual golden" AC note.
  test("full page visual golden at 1440x900 (self-regression baseline; the §7 drawer-open shot is a P1.6 follow-up)", async ({ page }) => {
    mockApi(page, "**/api/dashboards/wallets/w1", WALLET_PROFILE);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "/wallets/w1", "[data-wallet-profile-view]");
    await expect(page).toHaveScreenshot("wallet-profile-full.png", { fullPage: true });
  });
});

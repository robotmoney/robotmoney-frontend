// Render test for the LIVE vault-economics section of /allocation (issue #40),
// the RPC provenance (`source`) + per-adapter `configured` fields (issue #50),
// and the LIVE prop-wallet feed that replaced the baked WALLET_SNAPSHOT_TOTAL_USD
// scalar (issue #84). Same harness pattern as analytics-views.spec.ts: the SPA +
// view HTML are served by the backend at baseURL, vendor CDN scripts are
// fulfilled from node_modules, and both API surfaces are stubbed:
//   - GET /api/dashboards/vault-economics → the COMMITTED GOLDEN
//     (goldens/api-goldens.json), the single source of truth per
//     docs/preview-server-spec.md;
//   - GET /api/dashboards/wallet-balances → an inline stub payload (there is no
//     live prop-wallet capture — the addresses are owner data).
//
// Hero Total AUM = wallet.totalUsd (live prop-wallet feed) + vault tvlUsd (live
// vault-economics) — issue #84 retired the static $71,526 snapshot. This spec
// also asserts the served view no longer references WALLET_SNAPSHOT_TOTAL_USD.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

interface VaultEconomicsAdapter { name: string; address: string; configured?: boolean; balanceUsd: number | null }
interface VaultEconomics {
  asOf: string; stale: boolean; source?: "live" | "stub"; tvlUsd: number | null; sharePrice: number | null;
  totalShares: number | null; idleUsdc: number | null; apy7d: number | null;
  adapters: VaultEconomicsAdapter[];
}

interface WalletHolding { symbol: string; chain: string; group: string; color: string; amount: number | null; priceUsd: number | null; valueUsd: number | null; priceSource: string; provenance: "live" | "stub" | "stale" }
interface WalletBalances { asOf: string; totalUsd: number; source: "live" | "stub"; priceSource: "live" | "stub"; holdings: WalletHolding[]; history: { date: string; byAsset: Record<string, number>; totalUsd: number }[] }

function loadVaultEconomicsGolden(): VaultEconomics {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes["/api/dashboards/vault-economics"];
  if (!payload) throw new Error("no /api/dashboards/vault-economics golden — run `bun run goldens:update`");
  return payload as VaultEconomics;
}

// A live wallet-balances stub. `source`/`provenance` toggle the hero's provenance
// badge; `totalUsd` drives the Total AUM composition assertion.
function walletStub(overrides: Partial<WalletBalances> = {}): WalletBalances {
  const source = overrides.source ?? "live";
  const provenance = source === "stub" ? "stub" : "live";
  const symbols = ["USDC", "ZYFAI-SS1", "GIZA-SS1", "WETH", "ETH", "ROBOTMONEY", "BNKR", "SP500"];
  return {
    asOf: "2026-07-07T20:12:13.482Z",
    totalUsd: 55000,
    source,
    priceSource: source,
    holdings: symbols.map((s) => ({ symbol: s, chain: "base", group: "Stable", color: "#10b981", amount: 1, priceUsd: 1, valueUsd: 6875, priceSource: "pinned", provenance })),
    history: [{ date: "2026-03-18", byAsset: { WETH: 21519, ROBOTMONEY: 51300, BNKR: 12 }, totalUsd: 72831 }],
    ...overrides,
  };
}

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 1000 ? 2 : 0 });
}
function fmtPct(v: number | null): string {
  return v == null ? "—" : (v * 100).toFixed(2) + "%";
}
function adapterValue(a: VaultEconomicsAdapter): string {
  return a.configured === false ? "Not configured" : fmtUsd(a.balanceUsd);
}
// Hero Total AUM = live prop-wallet total + live vault tvlUsd; null (renders "—")
// whenever EITHER half is unknown.
function totalAum(walletTotal: number | null, tvlUsd: number | null): number | null {
  return walletTotal == null || tvlUsd == null ? null : walletTotal + tvlUsd;
}
function adapterBalance(a: VaultEconomicsAdapter): string {
  return a.configured !== false && a.balanceUsd != null
    ? a.balanceUsd.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : "—";
}
function adapterPrice(a: VaultEconomicsAdapter): string {
  return a.configured !== false && a.balanceUsd != null ? "$1.00" : "—";
}

async function stubEnvironment(page: Page, vault: VaultEconomics, wallet: WalletBalances = walletStub()) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  await page.route("**/api/dashboards/vault-economics", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(vault) }));
  await page.route("**/api/dashboards/wallet-balances", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wallet) }));
}

async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("allocation view binds vault economics to the golden payload, and Total AUM to the LIVE prop-wallet feed + vault tvl (issue #84)", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  const wallet = walletStub({ totalUsd: 55000, source: "live" });
  await stubEnvironment(page, golden, wallet);
  await page.goto("/");
  await navigate(page, "/allocation");

  // Hero Total AUM == live wallet total + live tvlUsd (never the vault-only
  // tvlUsd alone, nor the retired static $71,681 / $71,526 snapshot).
  await expect(page.locator(".alloc-aum__value")).toHaveText(fmtUsd(totalAum(wallet.totalUsd, golden.tvlUsd)));
  await expect(page.locator(".alloc-aum__value")).not.toHaveText(fmtUsd(golden.tvlUsd));
  await expect(page.locator(".alloc-aum__value")).not.toHaveText("$71,681");
  await expect(page.locator(".alloc-aum__value")).not.toHaveText("$71,526");

  // The served view must no longer reference the retired baked scalar.
  const viewSrc = await page.evaluate(async () => (await fetch("/assets/js/app/alpine/views.js")).text());
  expect(viewSrc).not.toContain("WALLET_SNAPSHOT_TOTAL_USD");

  // 7-Day APY chip == live apy7d (never the retired static 4.06%).
  await expect(page.locator(".alloc-chip__value")).toHaveText(fmtPct(golden.apy7d));
  await expect(page.locator(".alloc-chip__value")).not.toHaveText("4.06%");

  // Vault holdings table unchanged (issue #40/#50 assertions preserved).
  const headerCells = page.locator(".alloc-tablecard").first().locator("thead th");
  await expect(headerCells).toHaveText(["Protocol", "Balance", "Price", "Value"]);
  const rows = page.locator(".alloc-tablecard").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const a of golden.adapters) {
    const row = rows.filter({ hasText: a.name.toUpperCase() });
    await expect(row).toHaveCount(1);
    const cells = row.locator("td");
    await expect(cells.nth(1)).toHaveText(adapterBalance(a));
    await expect(cells.nth(2)).toHaveText(adapterPrice(a));
    await expect(row.locator(".alloc-val")).toHaveText(adapterValue(a));
    if (a.configured === false) {
      await expect(row.locator(".alloc-val")).not.toHaveText("$0");
      await expect(row.locator(".alloc-val")).toHaveClass(/alloc-val--unconfigured/);
      await expect(cells.nth(1)).toHaveText("—");
      await expect(cells.nth(2)).toHaveText("—");
    }
  }
  await expect(page.locator(".alloc-tablecard").first()).not.toContainText("51.5855");

  await expect(page.locator(".alloc-tfoot__value").first()).toHaveText(fmtUsd(golden.tvlUsd));

  // Wallet feed is source:'live' here → the wallet provenance badges stay hidden.
  await expect(page.locator(".alloc-wallet-nonlive")).toBeHidden();
  await expect(page.locator(".alloc-wallet-stale")).toBeHidden();
});

test("allocation hero flags a non-live wallet feed when wallet-balances reports source:'stub' (issue #84)", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  const wallet = walletStub({ totalUsd: 40000, source: "stub" });
  await stubEnvironment(page, golden, wallet);
  await page.goto("/");
  await navigate(page, "/allocation");

  // Stub wallet numbers must never be presented as live chain data.
  await expect(page.locator(".alloc-wallet-nonlive")).toBeVisible();
  await expect(page.locator(".alloc-wallet-nonlive")).toContainText("stub");
  // Total AUM still composes from the (stub) wallet total + live vault tvl.
  await expect(page.locator(".alloc-aum__value")).toHaveText(fmtUsd(totalAum(wallet.totalUsd, golden.tvlUsd)));
});

test("allocation hero flags a stale wallet feed and renders '—' when a wallet leg has degraded (issue #84)", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  // One leg degraded to 'stale'; the whole wallet total is still numeric, but the
  // stale badge must surface that the feed is not fully live.
  const wallet = walletStub({ source: "live" });
  wallet.holdings[3]!.provenance = "stale";
  await stubEnvironment(page, golden, wallet);
  await page.goto("/");
  await navigate(page, "/allocation");

  await expect(page.locator(".alloc-wallet-stale")).toBeVisible();
  await expect(page.locator(".alloc-wallet-stale")).toContainText("stale");
});

test("allocation view renders the vault non-live indicator when vault-economics reports source:'stub' (issue #50)", async ({ page }) => {
  const stubPayload: VaultEconomics = {
    asOf: "2026-07-07T20:12:13.482Z",
    stale: false,
    source: "stub",
    tvlUsd: 84320.12,
    sharePrice: 1.00259,
    totalShares: 84102.55,
    idleUsdc: 1.0,
    apy7d: 0.0412,
    adapters: [
      { name: "Morpho", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", configured: true, balanceUsd: 28000 },
      { name: "Aave", address: "0x2222222222222222222222222222222222222222", configured: false, balanceUsd: null },
      { name: "Compound", address: "0x3333333333333333333333333333333333333333", configured: false, balanceUsd: null },
    ],
  };
  await stubEnvironment(page, stubPayload, walletStub());
  await page.goto("/");
  await navigate(page, "/allocation");

  await expect(page.locator(".alloc-nonlive")).toBeVisible();
  await expect(page.locator(".alloc-nonlive")).toContainText("stub");
  const rows = page.locator(".alloc-tablecard").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "MORPHO" }).locator(".alloc-val")).toHaveText("$28,000");
  await expect(rows.filter({ hasText: "AAVE" }).locator(".alloc-val")).toHaveText("Not configured");
});

test("allocation view renders a stale badge and never fabricates numbers when vault-economics degrades", async ({ page }) => {
  const degraded: VaultEconomics = {
    asOf: "2026-07-01T00:00:00.000Z",
    stale: true,
    source: "live",
    tvlUsd: null,
    sharePrice: null,
    totalShares: null,
    idleUsdc: null,
    apy7d: null,
    adapters: [
      { name: "Morpho", address: "0x1111111111111111111111111111111111111111", configured: true, balanceUsd: null },
      { name: "Aave", address: "0x2222222222222222222222222222222222222222", configured: true, balanceUsd: null },
      { name: "Compound", address: "0x3333333333333333333333333333333333333333", configured: true, balanceUsd: null },
    ],
  };
  await stubEnvironment(page, degraded, walletStub());
  await page.goto("/");
  await navigate(page, "/allocation");

  await expect(page.locator(".alloc-stale")).toBeVisible();
  // Vault tvl is null → Total AUM is null regardless of the (valid) wallet total.
  await expect(page.locator(".alloc-aum__value")).toHaveText("—");
  await expect(page.locator(".alloc-chip__value")).toHaveText("—");
  const rows = page.locator(".alloc-tablecard").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row.locator(".alloc-val")).toHaveText("—");
    const cells = row.locator("td");
    await expect(cells.nth(1)).toHaveText("—");
    await expect(cells.nth(2)).toHaveText("—");
  }
});

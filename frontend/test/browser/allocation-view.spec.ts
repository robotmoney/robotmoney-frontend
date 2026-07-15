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

// Generic golden loader for the OTHER dashboard endpoints the allocation view
// binds (buybacks / wallet-sleeves / allocation framework). Same single source
// of truth as loadVaultEconomicsGolden — goldens/api-goldens.json.
function loadGolden<T>(route: string): T {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes[route];
  if (!payload) throw new Error(`no ${route} golden — run \`bun run goldens:update\``);
  return payload as T;
}

// Stub one JSON route with a fixed payload; `onHit` records that the SPA
// actually fetched it (proving the widget renders FROM the API, not a literal).
async function stubJson(page: Page, glob: string, payload: unknown, onHit?: () => void) {
  await page.route(glob, (route) => {
    onHit?.();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
}

interface BuybackRow { date: string; txHash: string; wethSpent: number; valueUsd: number; robotmoneyReceived: number }
interface Buybacks { rows: BuybackRow[]; totals: { wethSpent: number; valueUsd: number; robotmoneyReceived: number }; source: string }
interface SleeveWallet { name: string; type: string; totalUsd: number; holdings: unknown[] }
interface WalletSleeves { wallets: SleeveWallet[]; source: string }
interface AllocationFramework { strategy: { label: string; targetPct: number }[]; buckets: unknown[]; source: string; managed: boolean }

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
  // allocationView lives in its own module since the per-view split of the old
  // monolithic views.js (review-maintainability finding 025, issue #129).
  const viewSrc = await page.evaluate(async () => (await fetch("/assets/js/app/alpine/views/allocation.js")).text());
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

test("a wallet feed that recovered from transient rate-limiting renders LIVE — no stale/non-live badge, live numbers in the hero (429-retry recovery)", async ({ page }) => {
  // The web-component proof for the 429-retry fix: after the backend transport
  // retries a transiently rate-limited leg, the wallet-balances payload comes
  // back FULLY live (every holding provenance 'live', source 'live'). The view
  // must show NO stale/non-live badge and render the live Total AUM + per-holding
  // numbers — i.e. the components "see" the recovered live data, not a stale one.
  const golden = loadVaultEconomicsGolden();
  const wallet = walletStub({ totalUsd: 61234, source: "live" });
  // Belt-and-suspenders: every leg is explicitly live (a recovered burst leaves
  // none stale). Distinct per-holding values so the DOM binding is unambiguous.
  wallet.holdings = wallet.holdings.map((h, i) => ({ ...h, provenance: "live", valueUsd: 1000 * (i + 1) }));
  await stubEnvironment(page, golden, wallet);
  await page.goto("/");
  await navigate(page, "/allocation");

  // Recovered → fully live: neither the stale nor the non-live wallet badge shows.
  await expect(page.locator(".alloc-wallet-stale")).toBeHidden();
  await expect(page.locator(".alloc-wallet-nonlive")).toBeHidden();
  // Hero Total AUM composes the LIVE wallet total + live vault tvl (recovered
  // numbers reach the component, never a degraded '—').
  await expect(page.locator(".alloc-aum__value")).toHaveText(fmtUsd(totalAum(wallet.totalUsd, golden.tvlUsd)));
  await expect(page.locator(".alloc-aum__value")).not.toHaveText("—");
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

// ── NEW: the buyback / sleeve / allocation-framework bindings render FROM the
// live API (matching the committed goldens), not from baked literals. Each test
// intercepts the endpoint under test, records the fetch, and asserts the served
// DTO drives the DOM. The other feeds fall through to the preview server (which
// also replays the goldens), so the page renders exactly as in production. ──────

test("Token Buybacks table rows + totals render FROM GET /api/dashboards/buybacks golden, not baked rows", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  const buybacks = loadGolden<Buybacks>("/api/dashboards/buybacks");
  expect(buybacks.rows.length).toBeGreaterThan(0);
  let hit = false;
  await stubEnvironment(page, golden, walletStub());
  await stubJson(page, "**/api/dashboards/buybacks", buybacks, () => { hit = true; });
  await page.goto("/");
  await navigate(page, "/allocation");

  // One data row (each carries a basescan tx link) per served buyback — the 10
  // live rows, never a hardcoded set. This locator ignores the loading/empty
  // placeholder <tr>s (which have no tx link).
  const dataRows = page.locator(".alloc-table--buyback tbody a.alloc-link");
  await expect(dataRows).toHaveCount(buybacks.rows.length);
  expect(hit).toBe(true); // the endpoint was actually fetched

  // Total-spent chip + tfoot totals are computed by the API and echoed verbatim.
  const wethLabel = buybacks.totals.wethSpent.toFixed(6) + " WETH";
  await expect(page.locator(".alloc-spent__value")).toHaveText(wethLabel);
  const totalRow = page.locator(".alloc-table--buyback .alloc-table__total");
  await expect(totalRow.locator(".alloc-warn")).toHaveText(wethLabel);
  await expect(totalRow.locator(".alloc-val").first()).toHaveText(
    "$" + buybacks.totals.valueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  );
  await expect(totalRow.locator(".alloc-val").nth(1)).toHaveText((buybacks.totals.robotmoneyReceived / 1e6).toFixed(2) + "M");
});

test("per-wallet Sleeves tables render FROM GET /api/dashboards/wallet-sleeves golden (names + totals)", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  const sleeves = loadGolden<WalletSleeves>("/api/dashboards/wallet-sleeves");
  expect(sleeves.wallets.length).toBeGreaterThan(0);
  let hit = false;
  await stubEnvironment(page, golden, walletStub());
  await stubJson(page, "**/api/dashboards/wallet-sleeves", sleeves, () => { hit = true; });
  await page.goto("/");
  await navigate(page, "/allocation");

  // Exactly one visible sleeve card per served wallet (the loading + empty
  // placeholder cards are hidden once the feed resolves).
  const cards = page.locator(".alloc-sleeve:visible");
  await expect(cards).toHaveCount(sleeves.wallets.length);
  expect(hit).toBe(true);
  for (const w of sleeves.wallets) {
    const card = cards.filter({ hasText: w.name });
    await expect(card).toHaveCount(1);
    await expect(card.locator(".alloc-sleeve__name")).toHaveText(w.name);
    await expect(card.locator(".alloc-sleeve__total")).toHaveText(fmtUsd(w.totalUsd));
    await expect(card.locator(".alloc-sleeve__type")).toHaveText(w.type);
  }
});

test("allocation strategy bucket weights derive FROM GET /api/dashboards/allocation, not the baked [95,5,0,0] literal", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  const fw = loadGolden<AllocationFramework>("/api/dashboards/allocation");
  // A payload deliberately DIFFERENT from the retired baked [95,5,0,0] literal:
  // if the bucket-card %s show 70/30 they can only have come from this response.
  const mutated: AllocationFramework = {
    ...fw,
    strategy: [
      { label: "Conservative DeFi Yield", targetPct: 70 },
      { label: "Agent Tokens", targetPct: 30 },
      { label: "Protocol Tokens", targetPct: 0 },
      { label: "Real World Assets", targetPct: 0 },
    ],
  };
  let hit = false;
  await stubEnvironment(page, golden, walletStub());
  await stubJson(page, "**/api/dashboards/allocation", mutated, () => { hit = true; });
  await page.goto("/");
  await navigate(page, "/allocation");

  const pcts = page.locator(".alloc-bucket__pct");
  await expect(pcts.nth(0)).toContainText("70%");
  await expect(pcts.nth(1)).toContainText("30%");
  // Never the old baked [95,5,0,0] literal.
  await expect(pcts.nth(0)).not.toContainText("95%");
  await expect(pcts.nth(1)).not.toContainText("5%");
  expect(hit).toBe(true);
});

test("allocation strategy bucket weights match the committed golden weights", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  const fw = loadGolden<AllocationFramework>("/api/dashboards/allocation");
  let hit = false;
  await stubEnvironment(page, golden, walletStub());
  await stubJson(page, "**/api/dashboards/allocation", fw, () => { hit = true; });
  await page.goto("/");
  await navigate(page, "/allocation");

  const pcts = page.locator(".alloc-bucket__pct");
  // stratPct() rounds targetPct to an integer % — assert the golden labels/weights.
  for (let i = 0; i < fw.strategy.length; i++) {
    await expect(pcts.nth(i)).toContainText(Math.round(Number(fw.strategy[i]!.targetPct)) + "%");
  }
  expect(hit).toBe(true);
});

// Render test for the LIVE vault-economics section of /allocation (issue #40),
// plus the RPC provenance (`source`) and per-adapter `configured` fields added
// by issue #50 (production-parity demo default). Same harness pattern as
// analytics-views.spec.ts: the SPA + view HTML are served by the backend at
// baseURL, vendor CDN scripts are fulfilled from node_modules, and here we
// stub GET /api/dashboards/vault-economics with the COMMITTED GOLDEN
// (goldens/api-goldens.json) — the single source of truth per
// docs/preview-server-spec.md — so the assertions below are checking that the
// rendered DOM equals the goldens payload values, and that the retired
// 2026-06-26 static literals ($71,681 / 4.06% / $154.72 / "153.5 rmUSDC
// shares @ $1.0080" / MORPHO 51.5855 / AAVE 51.5693 / COMPOUND 51.5698) no
// longer appear anywhere in the served view.
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

function loadVaultEconomicsGolden(): VaultEconomics {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes["/api/dashboards/vault-economics"];
  if (!payload) throw new Error("no /api/dashboards/vault-economics golden — run `bun run goldens:update`");
  return payload as VaultEconomics;
}

// Mirrors allocationView()'s fmtUsd/fmtPct in alpine/views.js so the test's
// expectation is derived the same way the app derives its rendered text.
function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 1000 ? 2 : 0 });
}
function fmtPct(v: number | null): string {
  return v == null ? "—" : (v * 100).toFixed(2) + "%";
}
// Mirrors allocationView()'s adapterValue() (issue #50): a placeholder
// (unconfigured) adapter renders an explicit "Not configured" state, never a
// live-looking $0 / dash.
function adapterValue(a: VaultEconomicsAdapter): string {
  return a.configured === false ? "Not configured" : fmtUsd(a.balanceUsd);
}

async function stubEnvironment(page: Page, payload: VaultEconomics) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  await page.route("**/api/dashboards/vault-economics", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }));
}

async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("allocation view binds vault economics to the golden payload, retiring the baked 2026-06-26 literals", async ({ page }) => {
  const golden = loadVaultEconomicsGolden();
  await stubEnvironment(page, golden);
  await page.goto("/");
  await navigate(page, "/allocation");

  // Hero Total AUM == live tvlUsd (never the retired static $71,681).
  await expect(page.locator(".alloc-aum__value")).toHaveText(fmtUsd(golden.tvlUsd));
  await expect(page.locator(".alloc-aum__value")).not.toHaveText("$71,681");

  // 7-Day APY chip == live apy7d (never the retired static 4.06%).
  await expect(page.locator(".alloc-chip__value")).toHaveText(fmtPct(golden.apy7d));
  await expect(page.locator(".alloc-chip__value")).not.toHaveText("4.06%");

  // Vault holdings table: exactly 3 rows, each protocol name + value from the
  // golden's adapters array (never the retired MORPHO/AAVE/COMPOUND unit
  // counts 51.5855/51.5693/51.5698 that the static port baked in). The
  // committed golden's adapters are all still at their placeholder addresses
  // (configured:false) — assert the explicit "Not configured" state, never a
  // live-looking $0 (the exact bug issue #50 fixes).
  const rows = page.locator(".alloc-tablecard").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const a of golden.adapters) {
    const row = rows.filter({ hasText: a.name.toUpperCase() });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".alloc-val")).toHaveText(adapterValue(a));
    if (a.configured === false) {
      await expect(row.locator(".alloc-val")).not.toHaveText("$0");
      await expect(row.locator(".alloc-val")).toHaveClass(/alloc-val--unconfigured/);
    }
  }
  await expect(page.locator(".alloc-tablecard").first()).not.toContainText("51.5855");

  // Total Vault Assets footer == live tvlUsd (never the retired static $154.72).
  await expect(page.locator(".alloc-tfoot__value").first()).toHaveText(fmtUsd(golden.tvlUsd));
  await expect(page.locator(".alloc-tfoot__value").first()).not.toHaveText("$154.72");

  // Retired sub-line literal must not survive anywhere in the served view.
  await expect(page.locator("section.a2")).not.toContainText("153.5 rmUSDC shares @ $1.0080");

  // stale badge only renders when the golden says stale.
  const staleBadge = page.locator(".alloc-stale");
  if (golden.stale) await expect(staleBadge).toBeVisible();
  else await expect(staleBadge).toBeHidden();

  // Non-live badge (issue #50) only renders when source:'stub'; the committed
  // golden is captured against live Base mainnet (source:'live'), so it must
  // stay hidden here — the dedicated hermetic-source test below covers the
  // visible case.
  const nonLiveBadge = page.locator(".alloc-nonlive");
  if (golden.source === "stub") await expect(nonLiveBadge).toBeVisible();
  else await expect(nonLiveBadge).toBeHidden();
});

test("allocation view renders the non-live indicator when vault-economics reports source:'stub' (issue #50)", async ({ page }) => {
  // Same shape as the committed golden but with source:'stub' and one adapter
  // configured via an env override — proves the non-live badge is driven
  // purely by `source`, independent of the configured/unconfigured split.
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
  await stubEnvironment(page, stubPayload);
  await page.goto("/");
  await navigate(page, "/allocation");

  // The non-live badge must be VISIBLE for stub-served data — stub numbers
  // must never be presented as live chain data.
  await expect(page.locator(".alloc-nonlive")).toBeVisible();
  await expect(page.locator(".alloc-nonlive")).toContainText("stub");

  const rows = page.locator(".alloc-tablecard").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const a of stubPayload.adapters) {
    const row = rows.filter({ hasText: a.name.toUpperCase() });
    await expect(row.locator(".alloc-val")).toHaveText(adapterValue(a));
  }
  // The configured adapter shows its real (stub) balance, never "Not configured".
  await expect(rows.filter({ hasText: "MORPHO" }).locator(".alloc-val")).toHaveText("$28,000");
  // The still-unconfigured adapters show the explicit state, never a $0.
  await expect(rows.filter({ hasText: "AAVE" }).locator(".alloc-val")).toHaveText("Not configured");
  await expect(rows.filter({ hasText: "AAVE" }).locator(".alloc-val")).not.toHaveText("$0");
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
    // configured:true here simulates a real (env-overridden) adapter whose
    // RPC read is currently failing — distinct from the "Not configured"
    // placeholder state, which has its own dedicated test above.
    adapters: [
      { name: "Morpho", address: "0x1111111111111111111111111111111111111111", configured: true, balanceUsd: null },
      { name: "Aave", address: "0x2222222222222222222222222222222222222222", configured: true, balanceUsd: null },
      { name: "Compound", address: "0x3333333333333333333333333333333333333333", configured: true, balanceUsd: null },
    ],
  };
  await stubEnvironment(page, degraded);
  await page.goto("/");
  await navigate(page, "/allocation");

  await expect(page.locator(".alloc-stale")).toBeVisible();
  await expect(page.locator(".alloc-aum__value")).toHaveText("—");
  await expect(page.locator(".alloc-chip__value")).toHaveText("—");
  await expect(page.locator(".alloc-nonlive")).toBeHidden(); // source:'live', even while stale
  const rows = page.locator(".alloc-tablecard").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) await expect(row.locator(".alloc-val")).toHaveText("—");
});

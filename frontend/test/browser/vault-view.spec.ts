// Render test for /vault — the depositor-capital factsheet (RM-105, design
// RM-104).
//
// The load-bearing assertion in this file is the NEGATIVE one: the page must
// never request /api/dashboards/wallet-balances or /api/dashboards/wallet-
// sleeves. Those two endpoints are the three protocol-owned prop wallets (the
// house book) — a different pot of money, moving to the token page under
// RM-103. /allocation's Total AUM tile added them to vault TVL, which is how
// the vault came to be 0.4% of a figure printed under a heading about the
// vault. Separating the pots is the entire reason this page exists, so a
// request to either endpoint is a product regression, not a performance one.
//
// Same harness as allocation-view.spec.ts: the SPA and its view fragments are
// served at baseURL, and the two endpoints the page IS allowed to read are
// stubbed from the committed goldens (goldens/api-goldens.json), the single
// source of truth per docs/architecture.md's preview section.
import { expect, test, type Page, type Route } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { navigate } from "./navigation.ts";

interface VaultEconomicsAdapter {
  name: string;
  address: string;
  configured?: boolean;
  balanceUsd: number | null;
  balanceObservedAt?: string | null;
  provenance?: string;
}
interface VaultEconomics {
  asOf: string;
  stale: boolean;
  source: "live" | "stub";
  tvlUsd: number | null;
  sharePrice: number | null;
  totalShares: number | null;
  idleUsdc: number | null;
  apy7d: number | null;
  adapters: VaultEconomicsAdapter[];
}
interface AllocationItem { label: string; targetPct: number }
interface AllocationBucket { key: string; label: string; items: AllocationItem[] }
interface AllocationFramework {
  strategy: { label: string; targetPct: number }[];
  buckets: AllocationBucket[];
  asOf: string;
  source: string;
  managed: boolean;
}

function loadGolden<T>(route: string): T {
  const goldens = JSON.parse(
    readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8"),
  ) as { routes: Record<string, unknown> };
  const payload = goldens.routes[route];
  if (!payload) throw new Error(`no ${route} golden — run \`bun run goldens:update\``);
  return payload as T;
}

const ECONOMICS_ROUTE = "/api/dashboards/vault-economics";
const ALLOCATION_ROUTE = "/api/dashboards/allocation";

// The two endpoints this page must never touch, whatever else changes.
const FORBIDDEN = ["/api/dashboards/wallet-balances", "/api/dashboards/wallet-sleeves"];

function economicsGolden(): VaultEconomics {
  return loadGolden<VaultEconomics>(ECONOMICS_ROUTE);
}
function allocationGolden(): AllocationFramework {
  return loadGolden<AllocationFramework>(ALLOCATION_ROUTE);
}

function json(route: Route, payload: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

// Stub the two permitted endpoints and start recording every request the page
// makes, so the forbidden-endpoint assertion reads real traffic rather than a
// grep over the source.
async function stubEnvironment(
  page: Page,
  economics: VaultEconomics = economicsGolden(),
  allocation: AllocationFramework = allocationGolden(),
): Promise<string[]> {
  const requested: string[] = [];
  page.on("request", (req) => requested.push(new URL(req.url()).pathname));
  // Registration order matters: Playwright matches the MOST RECENTLY
  // registered handler first, so the catch-all goes down before the two
  // specific routes that must win over it. Anything else under /api 404s
  // rather than being fulfilled — a page that quietly grows a third feed
  // should break here, not degrade silently.
  await page.route("**/api/**", (route) => route.fulfill({
    status: 404, contentType: "application/json", body: "{}",
  }));
  await page.route(`**${ECONOMICS_ROUTE}`, (route) => json(route, economics));
  await page.route(`**${ALLOCATION_ROUTE}`, (route) => json(route, allocation));
  return requested;
}

async function openVault(page: Page, path = "/vault"): Promise<void> {
  await page.goto("/index.html");
  await navigate(page, path);
}

test("/vault resolves, renders the page, and keeps the #allocation anchor other pages link to", async ({ page }) => {
  await stubEnvironment(page);
  await openVault(page);

  await expect(page.locator("section.vp")).toBeVisible();
  await expect(page.locator("h1.vp__title")).toContainText("four sleeves");
  // /vault#allocation is linked from the skill, the home page and the swarm's
  // vault card. The id is part of the contract, not decoration.
  await expect(page.locator("#allocation")).toHaveCount(1);
  await expect(page.locator("#allocation .vp__h2")).toHaveText("Allocation");
});

test("/vault never requests wallet-balances or wallet-sleeves — the house book is not this page's money", async ({ page }) => {
  const requested = await stubEnvironment(page);
  await openVault(page);
  // Wait for the page's own two feeds to have been read, so this is not a
  // pass-by-being-early.
  await expect(page.locator(".vp__bullet")).toHaveCount(4);

  expect(requested).toContain(ECONOMICS_ROUTE);
  expect(requested).toContain(ALLOCATION_ROUTE);
  for (const banned of FORBIDDEN) {
    expect({ banned, hits: requested.filter((p) => p === banned) }).toEqual({ banned, hits: [] });
  }
});

test("the four sleeves render, in RM-97 vocabulary, with target and held weights from the two live feeds", async ({ page }) => {
  const economics = economicsGolden();
  const allocation = allocationGolden();
  await stubEnvironment(page, economics, allocation);
  await openVault(page);

  const bullets = page.locator(".vp__bullet");
  await expect(bullets).toHaveCount(4);
  await expect(page.locator(".vp__bullet-name")).toHaveText([
    "Fixed income",
    "Small cap tokens",
    "Protocol tokens",
    "Real world assets",
  ]);
  // The legacy DTO labels are a display-layer rename, so they must not leak.
  await expect(page.locator("section.vp")).not.toContainText("Conservative DeFi Yield");
  await expect(page.locator("section.vp")).not.toContainText("Agent Tokens");

  // Target weights come from the allocation feed…
  const targets = allocation.strategy.map((s) => String(s.targetPct));
  await expect(page.locator("#allocation .vp__target").first()).toHaveAttribute("data-t", targets[0]);
  // …and the held side is computed from the live adapter balances: the vault's
  // assets are its lending adapters plus idle USDC, so fixed income holds all
  // of it and every other sleeve is held at zero.
  await expect(bullets.first().locator(".vp__bullet-nums b")).toHaveText("100.0%");
});

test("the retired vocabulary and the banned risk claim do not survive the port", async ({ page }) => {
  await stubEnvironment(page);
  await openVault(page);
  const body = page.locator("section.vp");
  // RM-104: "Near-zero principal risk" is deleted, not renamed — the vault PRD
  // bans the phrase in its own words (D-006).
  await expect(body).not.toContainText("Near-zero principal risk");
  await expect(body).not.toContainText("Total AUM");
  await expect(body).not.toContainText("Vault assets");
});

test("Holdings carries balance AND price AND idle USDC, and reconciles to vault TVL", async ({ page }) => {
  const economics = economicsGolden();
  await stubEnvironment(page, economics);
  await openVault(page);

  // By id, not by text: "Holdings" is also a word the Allocation section
  // defines, and a hasText filter would match that one first.
  const holdings = page.locator("#holdings");
  // One row per adapter, plus idle USDC, plus the total.
  await expect(holdings.locator("tbody tr")).toHaveCount(economics.adapters.length + 2);
  // RM-104: adapter balance AND price, not value alone.
  const first = holdings.locator("tbody tr").first();
  await expect(first.locator("td").nth(2)).not.toHaveText("—");
  await expect(first.locator("td").nth(3)).toHaveText("$1.0000");
  // RM-104: idle USDC, or the rows never reconcile to totalAssets().
  await expect(holdings).toContainText("Idle USDC");
  await expect(holdings.locator("tr.tot")).toContainText("Vault TVL");
});

test("degradation states survive: stub source, stale reads, and a backfilled catch-up all show", async ({ page }) => {
  const economics = economicsGolden();
  const degraded: VaultEconomics = {
    ...economics,
    source: "stub",
    stale: true,
    adapters: economics.adapters.map((a, i) => ({
      ...a,
      provenance: i === 0 ? "backfilled" : "stale",
    })),
  };
  await stubEnvironment(page, degraded);
  await openVault(page);

  await expect(page.locator(".vp__badge--nonlive").first()).toBeVisible();
  await expect(page.locator(".vp__badge--stale")).toBeVisible();
  await expect(page.locator(".vp__badge--backfilled")).toBeVisible();
  // sleeveStaleLabel() names the observation time, so "stale" is a date rather
  // than an adjective.
  await expect(page.locator(".vp__cell-badge").first()).toContainText("stale (");
});

test("an unconfigured adapter reports itself, and a dead vault feed leaves the page standing", async ({ page }) => {
  const economics = economicsGolden();
  const unconfigured: VaultEconomics = {
    ...economics,
    adapters: economics.adapters.map((a, i) =>
      (i === 0 ? { ...a, configured: false, balanceUsd: null } : a)),
  };
  await stubEnvironment(page, unconfigured);
  await openVault(page);
  // issue #50: never a live-looking $0 for an adapter at its placeholder address.
  await expect(page.locator("section.vp")).toContainText("Not configured");
});

test("the value chart discloses the seam between the recorded series and the live read", async ({ page }) => {
  const economics = economicsGolden();
  await stubEnvironment(page, economics);
  await openVault(page);

  const seam = page.locator(".vp__seam");
  await expect(seam).toBeVisible();
  // issue #614 AC5's wording: an in-progress retrieval, not a loss.
  await expect(seam).toContainText("in process of being retrieved from the blockchain");
});

test("the full daily series is behind the Show All toggle, not just the charts", async ({ page }) => {
  await stubEnvironment(page);
  await openVault(page);

  const daily = page.locator("#daily-series");
  await expect(daily.locator("tbody tr")).toHaveCount(5);
  const toggle = daily.locator(".vp__toggle");
  await expect(toggle).toContainText("Show all");
  await toggle.click();
  await expect(daily.locator("tbody tr")).toHaveCount(162);
});

test("/allocation and /allocation2 both render the vault page", async ({ page }) => {
  await stubEnvironment(page);
  for (const legacy of ["/allocation", "/allocation2"]) {
    await openVault(page, legacy);
    await expect(page.locator("h1.vp__title")).toContainText("four sleeves");
    await expect(page.locator("#allocation")).toHaveCount(1);
  }
});

test("/performance is NOT redirected — RM-103 has to land before the house book's series moves", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/performance");
  await expect(page.locator("section.vp")).toHaveCount(0);
});

test("the page renders at 390px with no horizontal overflow, and swaps the fan for a list", async ({ page }) => {
  await stubEnvironment(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await openVault(page);

  // The fan's 16px labels render at ~6px below 640px, so the diagram is
  // replaced by the same four rows as a list rather than shrunk past
  // legibility. Both are in the DOM at every width; only one is ever visible.
  await expect(page.locator(".vp__fan-list li").first()).toBeVisible();
  await expect(page.locator(".vp__fan > svg")).toBeHidden();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the fan diagram, not the list, is what renders at desktop width", async ({ page }) => {
  await stubEnvironment(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openVault(page);

  await expect(page.locator(".vp__fan > svg")).toBeVisible();
  await expect(page.locator(".vp__fan-list")).toBeHidden();
  // Four sleeve labels, drawn from the live allocation feed.
  await expect(page.locator(".vp__fan > svg text")).toContainText(["1 USDC", "DEPOSIT", "Fixed income"]);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

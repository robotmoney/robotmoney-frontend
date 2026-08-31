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
// Same harness as performance-view.spec.ts: the SPA and its view fragments are
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

  // Scoped: Across regimes carries a seam banner of its own, so an unscoped
  // .vp__seam now matches two and trips strict mode.
  const seam = page.locator("#value-over-time .vp__seam");
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

test("the allocation rail carries HELD as the fill, with the target as a tick", async ({ page }) => {
  await stubEnvironment(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openVault(page);

  // The rail is the first thing a reader sees, so it must agree with the
  // Allocation section further down. An earlier draft filled it to the TARGET
  // (95%), which disagreed with "held 100.0%" on the same page. One segment per
  // funded sleeve; a tick marks where each target boundary falls.
  const segs = page.locator(".vp__rail-seg");
  await expect(segs).toHaveCount(1);
  await expect(segs.first()).toHaveAttribute("style", /width:\s*100/);
  await expect(page.locator(".vp__rail-tick")).toHaveCount(1);

  // Funded sleeves get a row each; everything held at zero collapses into one
  // muted row rather than four competing "0%" lines in the hero.
  await expect(page.locator(".vp__rail-key li")).toHaveCount(2);
  await expect(page.locator(".vp__rail-key li").first()).toContainText("100.0% held");
  await expect(page.locator(".vp__rail-key li").last()).toContainText("held at zero");
});

test("the page renders at 390px with no horizontal overflow", async ({ page }) => {
  await stubEnvironment(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await openVault(page);

  await expect(page.locator(".vp__rail-bar")).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("Across regimes is dormant: a pointer to the study, never its numbers", async ({ page }) => {
  await stubEnvironment(page);
  await openVault(page);

  // The eight-year regime study tests a strategy this vault does not run. At
  // ~95% stablecoin lending the line it resembles is that study's CASH line,
  // its worst performer, so reproducing its headline figures here would borrow
  // credibility the product has not earned.
  const sec = page.locator("#across-regimes");
  await expect(sec).toContainText("It does not include this vault");
  await expect(sec.locator("a")).toHaveAttribute("href", "/blog/treasury-allocation");
  await expect(sec.locator("svg")).toHaveCount(0);
  await expect(sec).not.toContainText("6.22");
  await expect(sec).not.toContainText("24.96");
});

// ── Migrated from allocation-view.spec.ts (issue #800, Cluster A) ────────────
// RM-105 (PR #774) replaced /allocation with this page and deleted its route,
// but left allocation-view.spec.ts driving the address it removed. These four
// assertions are the ones that spec made about the VAULT half — the half that
// moved here — and that this file did not already make. They are reproduced
// against /vault rather than dropped with the page they used to run on.
//
// The rest of allocation-view.spec.ts was about the HOUSE BOOK — the hero's
// combined "Total AUM", the prop-wallet provenance badges (#84, #614 AC4), the
// partial-total rule (#160), the buyback table and the per-wallet sleeve cards.
// Those cannot be reproduced here: this page is defined by NOT reading that
// money (see the FORBIDDEN assertion at the top of this file), and #774 left
// no other route rendering them. The buyback binding moved to
// tokenomics-fees.spec.ts, which drives the card /tokenomics still renders; the
// rest is tracked as coverage RM-103 has to restore with the token page.

test("the 7-day yield is the LIVE apy7d, and says so when it is the reference series instead", async ({ page }) => {
  const economics = economicsGolden();
  await stubEnvironment(page, { ...economics, apy7d: 0.0731 });
  await openVault(page);

  const yieldStat = page.locator(".vp__stat", { hasText: "Yield · 7-day" });
  await expect(yieldStat.locator("dd")).toHaveText("7.31%");
  // Never /allocation's retired baked 4.06% chip, and not the reference series
  // while a live figure exists.
  await expect(yieldStat.locator("dd")).not.toHaveText("4.06%");
  // The "· reference series" qualifier is x-show'd, so it is in the DOM either
  // way — assert on whether it is SHOWN, which is what a reader sees.
  await expect(yieldStat.locator(".vp__stat-sub span")).toBeHidden();
});

test("with no live apy7d the yield figure is labelled as the reference series, not passed off as live", async ({ page }) => {
  const economics = economicsGolden();
  await stubEnvironment(page, { ...economics, apy7d: null });
  await openVault(page);

  const yieldStat = page.locator(".vp__stat", { hasText: "Yield · 7-day" });
  const qualifier = yieldStat.locator(".vp__stat-sub span");
  await expect(qualifier).toBeVisible();
  await expect(qualifier).toHaveText("· reference series");
});

test("a vault feed carrying nothing renders '—' everywhere and never fabricates a zero", async ({ page }) => {
  const economics = economicsGolden();
  const dead: VaultEconomics = {
    ...economics,
    stale: true,
    tvlUsd: null,
    sharePrice: null,
    totalShares: null,
    idleUsdc: null,
    apy7d: null,
    // configured: true is the point — a CONFIGURED adapter with no balance is
    // an unknown, not a zero. issue #50's "Not configured" case is the other
    // test; this one is the degraded-read case.
    adapters: economics.adapters.map((a) => ({ ...a, configured: true, balanceUsd: null })),
  };
  await stubEnvironment(page, dead);
  await openVault(page);

  await expect(page.locator(".vp__badge--stale")).toBeVisible();
  await expect(page.locator(".vp__stat", { hasText: "Vault TVL" }).locator("dd")).toHaveText("—");

  const holdings = page.locator("#holdings");
  const rows = holdings.locator("tbody tr");
  await expect(rows).toHaveCount(economics.adapters.length + 2);
  for (let i = 0; i < economics.adapters.length; i++) {
    const cells = rows.nth(i).locator("td");
    await expect(cells.nth(2)).toHaveText("—"); // balance
    await expect(cells.nth(3)).toHaveText("—"); // price
    await expect(cells.nth(4)).toHaveText("—"); // value
  }
  await expect(holdings.locator("tr.tot td").nth(4)).toHaveText("—");
  // The failure mode this guards is a blank read rendered as a real number.
  await expect(holdings).not.toContainText("$0.00");
});

test("the Holdings total is the same tvlUsd the hero states, read from the one feed", async ({ page }) => {
  const economics = economicsGolden();
  await stubEnvironment(page, economics);
  await openVault(page);

  const expected = "$" + Number(economics.tvlUsd).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  await expect(page.locator("#holdings tr.tot td").nth(4)).toHaveText(expected);
  await expect(page.locator(".vp__stat", { hasText: "Vault TVL" }).locator("dd")).toHaveText(expected);
});

test("sleeve target weights derive FROM the allocation feed, not the baked 95/5/0/0 literal", async ({ page }) => {
  // A payload deliberately DIFFERENT from the literal /allocation used to bake:
  // if the sleeves read 70/30 they can only have come from this response.
  const mutated: AllocationFramework = {
    ...allocationGolden(),
    strategy: [
      { label: "Conservative DeFi Yield", targetPct: 70 },
      { label: "Agent Tokens", targetPct: 30 },
      { label: "Protocol Tokens", targetPct: 0 },
      { label: "Real World Assets", targetPct: 0 },
    ],
  };
  await stubEnvironment(page, economicsGolden(), mutated);
  await openVault(page);

  const bullets = page.locator(".vp__bullet");
  await expect(bullets).toHaveCount(4);
  await expect(bullets.nth(0)).toContainText("target 70%");
  await expect(bullets.nth(1)).toContainText("target 30%");
  await expect(page.locator("#allocation")).not.toContainText("target 95%");
  // The target markers on the tracks are driven by the same numbers.
  await expect(bullets.nth(0).locator(".vp__target")).toHaveAttribute("data-t", "70");
  await expect(bullets.nth(1).locator(".vp__target")).toHaveAttribute("data-t", "30");
});

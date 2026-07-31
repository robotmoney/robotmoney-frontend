import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { navigate } from "./navigation.ts";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

test.beforeEach(async ({ page }) => {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
});

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  // Let pending module/CDN failures reach the browser event loop.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual([]);
}

test("renders allocation and dynamic committee routes through Alpine", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const today = new Date().toISOString().slice(0, 10);

  await page.goto("/");
  await navigate(page, "/allocation");
  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  // The allocationView factory draws the strategy/vault/wallet pie canvases.
  await expect(page.locator("canvas").first()).toBeVisible();
  // Hero Total AUM combines BOTH live halves (issue #84): the live prop-wallet
  // feed (GET /api/dashboards/wallet-balances) + the live vault-economics tvlUsd,
  // both served by the in-CI deterministic Base RPC stub (issue #48) with ZERO
  // live Base mainnet calls. Derive the expectation from the same endpoints the
  // page reads so this stays correct as the stub fixtures evolve.
  const expectedAum = await page.evaluate(async () => {
    const [w, v] = await Promise.all([
      fetch("/api/dashboards/wallet-balances").then((r) => r.json()),
      fetch("/api/dashboards/vault-economics").then((r) => r.json()),
    ]);
    const total = w.totalUsd + v.tvlUsd;
    return "$" + total.toLocaleString("en-US", { maximumFractionDigits: Math.abs(total) < 1000 ? 2 : 0 });
  });
  await expect(page.locator(".alloc-aum__value")).toHaveText(expectedAum);
  await expect(page.locator(".alloc-aum__value")).not.toHaveText("—");

  // Test performance page with Wallet Performance heading
  await navigate(page, "/performance");
  await expect(page.getByRole("heading", { name: /Wallet Performance/, exact: false })).toBeVisible();

  await page.goto("/committee/members/athena");
  await expect(page.locator(".profile-name")).toHaveText("Athena");
  await expect(page.locator(".profile-role")).not.toHaveText("");

  await page.goto(`/committee/${today}/woon`);
  await expect(page.locator(".session-title")).toHaveText("Woon Treasury");
  await expect(page.locator(".session-submissions tbody tr")).toHaveCount(3);

  // Live loadApi -> camelTake -> cv__take render path (issue #75): a live/current
  // Woon session served from the Postgres committee API (not the pre-2026-07-01
  // static archive) renders one member-opinion card per participating member.
  // runSession drives athena/boreas/cygnus, so exactly three cards render. Each
  // card carries the member name, a non-empty role/lens, and a stance-confidence
  // badge — guards a silent regression in the member-opinion render surface.
  const takeCards = page.locator(".cv__take");
  await expect(takeCards).toHaveCount(3);
  const firstCard = takeCards.first();
  await expect(firstCard.locator(".cv__member-link")).not.toHaveText("");
  await expect(firstCard.locator(".cv__take-lens")).not.toHaveText("");
  await expect(firstCard.locator(".cv__stance-badge")).toHaveText(/\S+ · \d+%/);

  await expectNoBrowserErrors(errors);
});

// The router injects the route fragment into #view after boot. Without the
// reserved height, the footer paints directly under the nav on a cold load and
// is shoved down when the fragment lands: measured CLS 0.53 on /skills, against
// Google's 0.1 "good" threshold. These assert the mechanism rather than the
// score, because a score needs a real network profile to be meaningful.
test("an empty #view reserves a viewport of height, and stops doing so once routed", async ({ page }) => {
  await page.goto("/");

  const reserved = await page.evaluate(() => {
    const view = document.querySelector("#view");
    if (!view) return null;
    const previous = view.innerHTML;
    view.innerHTML = "";
    const empty = view.getBoundingClientRect().height;
    view.innerHTML = "<p style=\"margin:0\">short</p>";
    const filled = view.getBoundingClientRect().height;
    view.innerHTML = previous;
    return { empty, filled, viewport: window.innerHeight };
  });

  expect(reserved).not.toBeNull();
  // Empty: at least a viewport tall, so the footer starts below the fold.
  expect(reserved!.empty).toBeGreaterThanOrEqual(reserved!.viewport);
  // Routed: the reservation is gone, so a short route is not padded to 100vh.
  expect(reserved!.filled).toBeLessThan(reserved!.viewport);
});

test("the skills hero pairs the headline with the install card and runs the tree canvas", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.goto("/");
  await navigate(page, "/skills");

  // The install command is the call to action on this page, so it belongs in
  // the hero beside the headline rather than in a block further down.
  const hero = page.locator(".sk__head");
  await expect(hero.locator(".sk__title")).toContainText("Agent");
  await expect(hero.locator(".sk__install-cmd")).toContainText("npx skills add");
  await expect(hero.locator(".sk__cta")).toBeVisible();

  // Two columns above the breakpoint: the card sits to the right of the copy,
  // not under it.
  const copyBox = await hero.locator(".sk__head-copy").boundingBox();
  const cardBox = await hero.locator(".sk__install-card").boundingBox();
  expect(cardBox!.x).toBeGreaterThan(copyBox!.x + copyBox!.width / 2);

  // treeHero() mounted and produced a canvas rather than failing silently.
  await expect(hero.locator(".sk__head-viz canvas")).toHaveCount(1);

  // Copy button writes the exact command.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await hero.locator(".sk__install-copy").click();
  await expect(hero.locator(".sk__install-copy")).toHaveClass(/is-copied/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("npx skills add robotmoney/robotmoney-skills --skill robotmoney-cli");

  await expectNoBrowserErrors(errors);
});

test("latest navigation wins when an earlier fragment response is delayed", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.goto("/");

  await page.route("**/views/committee/member.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.evaluate(() => {
    history.pushState({}, "", "/committee/members/athena");
    window.dispatchEvent(new PopStateEvent("popstate"));
    history.pushState({}, "", "/allocation");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  await expect(page.locator(".profile-name")).toHaveCount(0);

  await expectNoBrowserErrors(errors);
});

test("navigation destroys Chart.js and p5 resources from the previous view", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.goto("/");
  await navigate(page, "/allocation");
  const allocCanvas = page.locator(".rm-chart canvas").first();
  await expect(allocCanvas).toBeVisible();
  const chartId = await allocCanvas.evaluate((canvas) => {
    const chart = window.Chart?.getChart(canvas as HTMLCanvasElement);
    if (!chart) throw new Error("allocation Chart.js instance was not created");
    return chart.id;
  });

  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(page.locator(".rm-chart canvas")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate((id) => Boolean(window.Chart?.instances?.[id]), chartId)
  ).toBe(false);

  await navigate(page, "/blog");
  const p5Canvas = page.locator(".hero-art__canvas canvas").first();
  await expect(p5Canvas).toBeVisible();
  const handle = await p5Canvas.elementHandle();
  if (!handle) throw new Error("p5 canvas was not created");

  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect.poll(() => handle.evaluate((canvas) => canvas.isConnected)).toBe(false);

  await expectNoBrowserErrors(errors);
});

declare global {
  interface Window {
    Chart?: {
      getChart(canvas: HTMLCanvasElement): { id: string } | undefined;
      instances?: Record<string, unknown>;
    };
  }
}

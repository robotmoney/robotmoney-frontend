// The site nav (RM-124): the section a page sits in, the desktop panels by
// pointer and by key, the phone sheet, and the links an agent reads without
// JavaScript. The markup, the sections and the vault list are pinned in
// scripts/tests/unit/site-nav.test.ts; this is what a reader does with them.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navigate } from "./navigation.ts";

const top = (page: Page, key: string) => page.locator(`.nav__group[data-nav-section="${key}"] > .nav__top`);
const panel = (page: Page, key: string) => page.locator(`#nav-p-${key}`);

function failOnPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  return errors;
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the section a page sits in keeps its underline, and its own link is current", async ({ page }) => {
    const errors = failOnPageErrors(page);
    await page.goto("/");
    await expect(page.locator(".nav__top--active")).toHaveCount(0);

    await navigate(page, "/vault/rmagent");
    await expect(page.locator(".nav__top--active")).toHaveCount(1);
    await expect(top(page, "vaults")).toHaveClass(/nav__top--active/);
    await expect(page.locator('.nav a[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.nav a[href="/vault/rmagent"]')).toHaveAttribute("aria-current", "page");
    const underline = top(page, "vaults").locator(".nav__underline");
    await expect(underline).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    // Monochrome, like every link on the site: never the accent.
    await expect(underline).toHaveCSS("background-color", "rgb(242, 244, 249)");

    // The Robot Money Vault's address is under /swarm; it still lights Vaults.
    await navigate(page, "/swarm/subjects/robotmoney-vault");
    await expect(top(page, "vaults")).toHaveClass(/nav__top--active/);
    await expect(top(page, "swarm")).not.toHaveClass(/nav__top--active/);

    await navigate(page, "/regime/indicators");
    await expect(top(page, "research")).toHaveClass(/nav__top--active/);
    // The panel holding the current link is closed, so the group says so.
    await expect(top(page, "research")).toHaveAttribute("aria-current", "true");
    await expect(top(page, "vaults")).not.toHaveAttribute("aria-current", /.+/);
    await expect(page.locator('.nav a[href="/regime"]')).not.toHaveAttribute("aria-current", "page");
    expect(errors).toEqual([]);
  });

  test("a click pins a panel; a second click, Esc or a click outside closes it", async ({ page }) => {
    await page.goto("/");
    await expect(panel(page, "vaults")).toBeHidden();

    await top(page, "vaults").click();
    await expect(panel(page, "vaults")).toBeVisible();
    await expect(top(page, "vaults")).toHaveAttribute("aria-expanded", "true");
    // Pinned: the pointer leaving does not drop it.
    await page.mouse.move(700, 700);
    await page.waitForTimeout(400);
    await expect(panel(page, "vaults")).toBeVisible();

    await top(page, "vaults").click();
    await expect(panel(page, "vaults")).toBeHidden();
    await expect(top(page, "vaults")).toHaveAttribute("aria-expanded", "false");

    await top(page, "docs").click();
    await expect(panel(page, "docs")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page, "docs")).toBeHidden();
    await expect(top(page, "docs")).toBeFocused();

    await top(page, "swarm").click();
    await page.mouse.click(700, 700);
    await expect(panel(page, "swarm")).toBeHidden();
  });

  test("hover opens a panel, the pointer can reach it, and leaving closes it", async ({ page }) => {
    await page.goto("/");
    await top(page, "research").hover();
    await expect(panel(page, "research")).toBeVisible();

    // Straight down from the label into the panel: it stays.
    await panel(page, "research").locator("a").first().hover();
    await page.waitForTimeout(400);
    await expect(panel(page, "research")).toBeVisible();

    // Along the bar: the next panel takes over.
    await top(page, "docs").hover();
    await expect(panel(page, "docs")).toBeVisible();
    await expect(panel(page, "research")).toBeHidden();

    await page.mouse.move(700, 700);
    await expect(panel(page, "docs")).toBeHidden();

    // A panel the pointer opened closes on Esc with focus out on the page.
    await page.locator(".footer a").first().focus();
    await top(page, "vaults").hover();
    await expect(panel(page, "vaults")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page, "vaults")).toBeHidden();
  });

  test("keys: along the bar, down into a panel, through it, and back out", async ({ page }) => {
    await page.goto("/");
    await top(page, "vaults").focus();
    await page.keyboard.press("ArrowRight");
    await expect(top(page, "swarm")).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(panel(page, "swarm")).toBeVisible();
    await expect(panel(page, "swarm").locator("a").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(panel(page, "swarm").locator("a").nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(panel(page, "swarm").locator("a").last()).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(top(page, "swarm")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel(page, "swarm")).toBeHidden();
    await page.keyboard.press("End");
    await expect(top(page, "company")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(top(page, "vaults")).toBeFocused();

    // Focus leaving the nav closes an open panel.
    await page.keyboard.press("Enter");
    await expect(panel(page, "vaults")).toBeVisible();
    await page.locator(".footer a").first().focus();
    await expect(panel(page, "vaults")).toBeHidden();
  });

  // On staging's tunnel the first fragment landed after a click had opened a
  // panel, and the router's view-change event shut it: only a new page may.
  test("a panel opened before the first page lands stays open", async ({ page }) => {
    await page.route("**/views/regime.html", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto("/regime", { waitUntil: "domcontentloaded" });
    await expect(page.locator("nav.nav--js")).toBeAttached();
    await top(page, "vaults").click();
    await expect(panel(page, "vaults")).toBeVisible();
    await expect(page.locator("#view h1")).toBeVisible();
    await expect(panel(page, "vaults")).toBeVisible();
  });

  test("the Vaults card shows each vault's value from a live read, and nothing from test data", async ({ page }) => {
    // The Base vault's feed: the contract declares no four-vault route yet, so
    // the loader reads this one (lib/vault-source.js), and "stub" is test data.
    const economics = { asOf: "2026-09-24T10:00:00Z", tvlUsd: 18390.4, sharePrice: 1.0177, idleUsdc: 0, adapters: [], source: "rpc" };
    let reads = 0;
    await page.route("**/api/dashboards/vault-economics*", (route) => {
      reads += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(economics) });
    });
    await page.goto("/");
    await expect(page.locator("#view h1").first()).toBeAttached();
    // Read when the card opens, not on every page load.
    expect(reads).toBe(0);
    await top(page, "vaults").click();
    const fig = (href: string) => panel(page, "vaults").locator(`a[href="${href}"] .nav__item-v`);
    await expect(fig("/vault/rmusdc")).toHaveText("$18,390");
    await expect(fig("/vault/rmagent")).toHaveText("Coming soon");
    // Not on the network yet reads as a state, in a pill, not as a figure.
    await expect(fig("/vault/rmagent").locator(".rm-soon")).toHaveText("Coming soon");
    await expect(fig("/vault/rmusdc").locator(".rm-soon")).toHaveCount(0);
    await expect(fig("/swarm/subjects/robotmoney-vault")).toHaveText("$18,390");
    expect(reads).toBe(1);

    // Test data carries a label wherever a figure shows; a menu row has no
    // room for one, so the card shows none.
    const test = await page.context().newPage();
    await test.route("**/api/dashboards/vault-economics*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...economics, source: "stub" }) }));
    await test.goto("/");
    await expect(test.locator("#view h1").first()).toBeAttached();
    await test.locator('.nav__group[data-nav-section="vaults"] > .nav__top').click();
    await expect(test.locator("#nav-p-vaults")).toBeVisible();
    await test.waitForTimeout(500);
    await expect(test.locator("#nav-p-vaults .nav__item-v")).toHaveText(["", "", "", "", ""]);
  });

  test("a link off the site shows its arrow before any pointer reaches it; one on the site shows it on hover", async ({ page }) => {
    await page.goto("/");
    await top(page, "company").click();
    const arrow = (sel: string) => page.locator(sel).evaluate((el) => {
      const c = getComputedStyle(el, "::after");
      return { content: c.content, opacity: c.opacity, marginLeft: c.marginLeft };
    });
    const out = await arrow('#nav-p-company a[href^="https://t.me"]');
    expect(out.opacity).toBe("1");
    expect(out.content).toContain("\u2197");
    const inside = await arrow('#nav-p-company a[href="/media"]');
    expect(inside.opacity).toBe("0");
    // Both sit at the row's right edge: the site-wide new-tab arrow does not
    // pull the external one in beside the word.
    const box = await page.locator('#nav-p-company a[href^="https://t.me"]').boundingBox();
    expect(parseFloat(out.marginLeft)).toBeGreaterThan(box!.width / 3);

    // A page not built yet is named, marked and not a link.
    await top(page, "swarm").click();
    const soon = panel(page, "swarm").locator(".nav__item--soon");
    await expect(soon).toContainText("Leaderboard");
    await expect(soon.locator(".rm-soon")).toHaveText("Coming soon");
    await expect(panel(page, "swarm").locator('a:has-text("Leaderboard")')).toHaveCount(0);
  });

  test("a click on blank space inside a pinned card keeps it open", async ({ page }) => {
    await page.goto("/");
    await top(page, "docs").click();
    await expect(panel(page, "docs")).toBeVisible();
    await panel(page, "docs").locator(".nav__label").first().click();
    await expect(panel(page, "docs")).toBeVisible();
    const card = await panel(page, "docs").locator(".nav__card").boundingBox();
    await page.mouse.click(card!.x + card!.width - 6, card!.y + card!.height - 6);
    await expect(panel(page, "docs")).toBeVisible();
  });

  test("the page behind an open card steps back, and a click on it closes the card", async ({ page }) => {
    await page.goto("/");
    const scrim = page.locator(".nav__scrim");
    await expect(scrim).toBeHidden();
    await top(page, "docs").click();
    await expect(scrim).toBeVisible();
    await expect(scrim).toHaveCSS("opacity", "1");
    // A flat shade: the covenant allows no gradient here.
    await expect(scrim).toHaveCSS("background-image", "none");
    await page.mouse.click(700, 700);
    await expect(panel(page, "docs")).toBeHidden();
    await expect(scrim).toBeHidden();
  });

  // RM-127: the swarm page draws its sections only once its data lands, so a
  // link to one of them from another page used to land at the top and stay.
  test("a link to a section of a page that draws late lands on that section", async ({ page }) => {
    const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")).routes;
    await page.route("**/api/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.startsWith("/api/swarm")) await new Promise((resolve) => setTimeout(resolve, 1200));
      if (pathname in goldens) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(goldens[pathname]) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' });
    });
    await page.goto("/tokenomics");
    await expect(page.locator("#view h1")).toBeVisible();
    await top(page, "swarm").click();
    await panel(page, "swarm").locator('a[href="/swarm#history"]').click();
    const history = page.locator("#history");
    await expect(history).toBeVisible({ timeout: 10_000 });
    // Held under the bar once the sections above it have filled in: the
    // section's own scroll-margin-top (6rem) from the top of the window.
    await expect.poll(async () => Math.round((await history.boundingBox())!.y), { timeout: 10_000 }).toBe(96);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  });

  test("following a link closes the panel, a link to a section of this page too", async ({ page }) => {
    await page.goto("/");
    await navigate(page, "/swarm");
    await top(page, "swarm").click();
    await panel(page, "swarm").locator('a[href="/swarm#history"]').click();
    await expect(panel(page, "swarm")).toBeHidden();
    await expect(page).toHaveURL(/\/swarm#history$/);

    await top(page, "vaults").click();
    await panel(page, "vaults").locator('a[href="/vault/rmusdc"]').click();
    await expect(panel(page, "vaults")).toBeHidden();
    await expect(page).toHaveURL(/\/vault\/rmusdc$/);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one sheet: every group open under its heading, the button pinned at the bottom", async ({ page }) => {
    const errors = failOnPageErrors(page);
    await page.goto("/");
    await expect(page.locator(".nav__menu")).toBeHidden();

    const toggle = page.locator(".nav__toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".nav__menu")).toBeVisible();
    // Every group open under a heading; the desktop buttons, which would do
    // nothing here, are not in the sheet at all.
    for (const key of ["vaults", "swarm", "research", "docs", "company"]) {
      await expect(panel(page, key)).toBeVisible();
      await expect(top(page, key)).toBeHidden();
    }
    await expect(page.locator(".nav__head")).toHaveText(["Vaults", "Swarm", "Research", "Docs", "Company"]);
    await expect(page.locator(".nav").getByRole("heading", { level: 2 })).toHaveCount(5);
    await expect(panel(page, "company").getByRole("link", { name: "Token", exact: true })).toBeVisible();

    // The sheet's links follow the button that opened it, and a link that
    // takes focus is never left under the pinned button.
    await page.keyboard.press("Tab");
    await expect(page.locator(".nav__menu a").first()).toBeFocused();
    const ctaTop = (await page.locator(".nav__ctas").boundingBox())!.y;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const b = await page.evaluate(() => document.activeElement!.getBoundingClientRect().bottom);
      if (await page.locator(".nav__cta").evaluate((el) => el === document.activeElement)) break;
      expect(b).toBeLessThanOrEqual(ctaTop + 1);
    }

    const cta = page.locator(".nav__cta");
    await expect(cta).toHaveText("Deposit");
    const box = await cta.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    // The page behind does not scroll, and nothing runs off the side.
    await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.keyboard.press("Escape");
    await expect(page.locator(".nav__menu")).toBeHidden();
    await expect(toggle).toBeFocused();

    // Tab past the last link: focus goes to the page, so the sheet closes.
    await toggle.click();
    await page.locator(".nav__cta").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".nav__menu")).toBeHidden();

    await toggle.click();
    await page.locator('.nav__menu a[href="/regime/indicators"]').click();
    await expect(page.locator(".nav__menu")).toBeHidden();
    await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
    expect(errors).toEqual([]);
  });
});

test.describe("without JavaScript", () => {
  test.use({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });

  test("every link is in the served page, and a panel still opens on hover", async ({ page }) => {
    await page.goto("/");
    expect(await page.locator(".nav a[href]").count()).toBeGreaterThanOrEqual(20);
    await top(page, "vaults").hover();
    await expect(panel(page, "vaults")).toBeVisible();
  });
});

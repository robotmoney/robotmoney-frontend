// Functional + visual coverage for the P0.1/P0.2 dashboard primitives
// (issue #379, docs/bot-analytics-ui-port-plan.md §2/§8): the `.a3`-scoped
// dash.css, the alpine/dash-ui.js primitive factories, and the
// assets/img/dash-icons.svg sprite. The styleguide fixture
// (frontend/public/views/dash/_styleguide.html) is a dev-only fragment that
// renders every primitive in one place so this spec can assert the whole
// P0.1/P0.2 surface without any downstream dashboard view existing yet.
//
// No API calls: the fixture is pure static/local Alpine state, so — like
// every other spec in this directory — it still needs the SPA shell + static
// assets served by the real backend at baseURL (only `preview-smoke.spec.ts`
// runs backend-free; see frontend.yml's header comment), so this spec stays
// in the e2e workflow's full `test:browser` run rather than the fast
// frontend.yml lane.
//
// Generate/refresh the visual baseline with:
//   bun run test:browser -- --update-snapshots dash-styleguide
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

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

test.beforeEach(async ({ page }) => {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
});

test("home has no .a3 element; the styleguide fixture has exactly one root .a3", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".a3")).toHaveCount(0);

  // Error tracking starts AFTER the home-page load: home's own hero fetch
  // (unrelated to this issue) is out of scope here, this asserts the
  // STYLEGUIDE navigation itself is error-free.
  const errors = failOnBrowserErrors(page);
  await navigate(page, "/dash/_styleguide");
  await expect(page.locator("[data-sg-root]")).toHaveCount(1);
  await expect(page.locator("[data-sg-root]")).toHaveClass(/(^| )a3( |$)/);
  // The fixture root is the ONLY `.a3` element on the route — every other
  // dashboard fragment (future issues) puts the class on its own single
  // root, never nested.
  await expect(page.locator(".a3")).toHaveCount(1);

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual([]);
});

test("dash.css ported component classes + badge/table shell render", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  await expect(page.locator(".metric-card")).toHaveCount(3);
  await expect(page.locator(".metric-card.glow-cyan")).toHaveCount(1);
  await expect(page.locator(".metric-card.glow-purple")).toHaveCount(1);
  await expect(page.locator(".data-label")).not.toHaveCount(0);
  await expect(page.locator(".data-value").first()).toBeVisible();
  await expect(page.locator(".status-active")).toHaveCount(1);
  await expect(page.locator(".status-inactive")).toHaveCount(1);
  await expect(page.locator("[data-sg='status'] .a3-badge")).toHaveCount(5);

  const table = page.locator("[data-sg='table'] .a3-table");
  await expect(table).toBeVisible();
  await expect(table.locator("thead th")).toHaveCount(3);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("th.is-sorted")).toHaveCount(1);
});

test("icon sprite exposes every glyph in the plan's §3 list via <use>", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const icons = page.locator("[data-sg='icons'] [data-sg-icon]");
  const count = await icons.count();
  expect(count).toBeGreaterThanOrEqual(40);

  // Spot-check a handful resolve to a real <symbol> id in the sprite file
  // (i.e. the sprite and the styleguide's glyph list actually agree).
  const hrefs = await icons.evaluateAll((els) =>
    els.map((el) => el.querySelector("use")?.getAttribute("href") || "")
  );
  for (const name of ["triangle", "lock", "eye", "wallet", "trash", "star"]) {
    expect(hrefs).toContain(`/assets/img/dash-icons.svg#i-${name}`);
  }

  const spriteRes = await page.request.get("/assets/img/dash-icons.svg");
  expect(spriteRes.ok()).toBe(true);
  const spriteBody = await spriteRes.text();
  for (const href of hrefs) {
    const id = href.split("#")[1];
    expect(spriteBody).toContain(`id="${id}"`);
  }
});

test("a3Tabs switches the active pill", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const tabs = page.locator("[data-sg='tabs']");
  await expect(tabs.getByRole("button", { name: "All" })).toHaveClass(/is-active/);
  await tabs.getByRole("button", { name: "Coins" }).click();
  await expect(tabs.getByRole("button", { name: "Coins" })).toHaveClass(/is-active/);
  await expect(tabs.getByRole("button", { name: "All" })).not.toHaveClass(/is-active/);
  await expect(tabs.locator("[data-sg-active-tab]")).toHaveText("coins");
});

test("a3ToggleGroup switches the active segment", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const group = page.locator("[data-sg='toggle-group']");
  await expect(group.getByRole("button", { name: "30D" })).toHaveClass(/is-active/);
  await group.getByRole("button", { name: "1Y" }).click();
  await expect(group.getByRole("button", { name: "1Y" })).toHaveClass(/is-active/);
  await expect(group.getByRole("button", { name: "30D" })).not.toHaveClass(/is-active/);
});

test("a3Switch toggles on/off", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const sw = page.locator("[data-sg-switch]");
  await expect(sw).toHaveClass(/is-on/);
  await expect(page.locator("[data-sg-switch-label]")).toContainText("on");
  await sw.click();
  await expect(sw).not.toHaveClass(/is-on/);
  await expect(page.locator("[data-sg-switch-label]")).toContainText("off");
});

test("a3Select opens, choosing an option updates the trigger label, and it closes on outside click", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const trigger = page.locator("[data-sg-select-trigger]");
  const list = page.locator("[data-sg-select-list]");
  await expect(list).toBeHidden();
  await expect(trigger).toContainText("Score");

  await trigger.click();
  await expect(list).toBeVisible();
  await list.getByText("x402 Vol", { exact: true }).click();
  await expect(list).toBeHidden();
  await expect(trigger).toContainText("x402 Vol");

  // Reopen, then click well outside the select — @click.outside closes it.
  // The icon-sprite section sits at the bottom of the fixture, clear of both
  // the select itself and the fixed site nav bar at the top of the viewport.
  await trigger.click();
  await expect(list).toBeVisible();
  await page.locator("[data-sg='icons'] h2").click();
  await expect(list).toBeHidden();
});

test("a3Dialog opens, closes on Escape, and closes on backdrop click", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const overlay = page.locator("[data-sg-dialog-overlay]");
  await expect(overlay).toBeHidden();

  await page.locator("[data-sg-open-dialog]").click();
  await expect(overlay).toBeVisible();
  await expect(page.locator("[data-sg-dialog]")).toContainText("$ROBOTMONEY");

  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();

  await page.locator("[data-sg-open-dialog]").click();
  await expect(overlay).toBeVisible();
  // Click the overlay itself (top-left corner, off the centered dialog card).
  await overlay.click({ position: { x: 5, y: 5 } });
  await expect(overlay).toBeHidden();

  // The close (×) button works too.
  await page.locator("[data-sg-open-dialog]").click();
  await page.locator("[data-sg-close-dialog]").click();
  await expect(overlay).toBeHidden();
});

test("a3Sheet opens and closes on Escape", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const overlay = page.locator("[data-sg-sheet-overlay]");
  await expect(overlay).toBeHidden();

  await page.locator("[data-sg-open-sheet]").click();
  await expect(overlay).toBeVisible();
  await expect(page.locator("[data-sg-sheet]")).toHaveClass(/a3-sheet--xl/);

  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
});

test("a3Toast: firing pushes a toast into the viewport", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  await expect(page.locator("[data-sg-toast-viewport] .a3-toast")).toHaveCount(0);
  await page.locator("[data-sg-fire-toast]").click();
  const toast = page.locator("[data-sg-toast-viewport] .a3-toast");
  await expect(toast).toHaveCount(1);
  await expect(toast).toHaveText("Copied to clipboard");
  await expect(toast).toHaveClass(/a3-toast--success/);
});

test("x-a3-tooltip shows on hover/focus and hides on leave/blur/Escape", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const trigger = page.locator("[data-sg-tooltip-trigger]");
  await expect(page.locator(".a3-tooltip-bubble")).toHaveCount(0);

  await trigger.hover();
  await expect(page.locator(".a3-tooltip-bubble")).toHaveText("26-week token price trend");

  await page.mouse.move(0, 0);
  await expect(page.locator(".a3-tooltip-bubble")).toHaveCount(0);

  await trigger.focus();
  await expect(page.locator(".a3-tooltip-bubble")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".a3-tooltip-bubble")).toHaveCount(0);
});

test("copy button reuses the site-wide data-copy handler", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  const button = page.locator("[data-sg-copy-button]");
  await button.click();
  await expect(button).toHaveClass(/is-copied/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd");
});

test("dash styleguide matches its visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await navigate(page, "/dash/_styleguide");

  await expect(page.locator("[data-sg='icons'] [data-sg-icon]").first()).toBeVisible();
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("dash-styleguide-full.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

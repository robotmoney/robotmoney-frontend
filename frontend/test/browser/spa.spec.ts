import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navigate } from "./navigation.ts";
import { renderMeta } from "../../public/assets/js/app/seo.js";

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

test("renders allocation and dynamic swarm routes through Alpine", async ({ page }) => {
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

  await page.goto("/swarm/members/athena");
  await expect(page.locator(".profile-name")).toHaveText("Athena");
  await expect(page.locator(".profile-role")).not.toHaveText("");

  await page.goto(`/swarm/${today}/woon`);
  await expect(page.locator(".session-title")).toHaveText("Woon Treasury");
  await expect(page.locator(".session-submissions tbody tr")).toHaveCount(3);

  // Live loadApi -> camelTake -> sv__take render path (issue #75): a live/current
  // Woon session served from the Postgres swarm API (not the pre-2026-07-01
  // static archive) renders one member-opinion card per participating member.
  // runSession drives athena/boreas/cygnus, so exactly three cards render. Each
  // card carries the member name, a non-empty role/lens, and a stance-confidence
  // badge — guards a silent regression in the member-opinion render surface.
  const takeCards = page.locator(".sv__take");
  await expect(takeCards).toHaveCount(3);
  const firstCard = takeCards.first();
  await expect(firstCard.locator(".sv__member-link")).not.toHaveText("");
  await expect(firstCard.locator(".sv__take-lens")).not.toHaveText("");
  await expect(firstCard.locator(".sv__stance-badge")).toHaveText(/\S+ · \d+%/);

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

// Every nav page's hero headline is the same type in the same place, so it does
// not jump as you navigate. Before the shared rules this asserted, the nav pages
// rendered at five different sizes (56 / 57.6 / 60 / 64px), /media was set in a
// different typeface with no uppercase, and the headline top varied by 55px.
// Asserted as an invariant across pages rather than as a pinned pixel value, so
// the design can change without this needing a rewrite — only divergence fails.
const HERO_ROUTES = [
  "/skills", "/regime", "/tokenomics", "/allocation",
  "/performance", "/projects", "/media", "/changelog", "/swarm",
];

test("every hero headline shares one size, one typeface and one offset", async ({ page }) => {
  await page.goto("/");

  const seen: Record<string, { size: string; family: string; transform: string; top: number }> = {};
  for (const route of HERO_ROUTES) {
    await navigate(page, route);
    const h1 = page.locator("#view h1").first();
    await expect(h1).toBeVisible();
    seen[route] = await h1.evaluate((el) => {
      const c = getComputedStyle(el);
      return {
        size: c.fontSize,
        family: c.fontFamily,
        transform: c.textTransform,
        top: Math.round(el.getBoundingClientRect().top),
      };
    });
  }

  const first = seen[HERO_ROUTES[0]];
  for (const route of HERO_ROUTES) {
    expect(seen[route].size, `${route} font-size`).toBe(first.size);
    expect(seen[route].family, `${route} font-family`).toBe(first.family);
    expect(seen[route].transform, `${route} text-transform`).toBe(first.transform);
    // Same offset from the top of the band on every page, which is what stops
    // the headline moving as you navigate.
    expect(seen[route].top, `${route} headline top`).toBe(first.top);
  }
});

test("latest navigation wins when an earlier fragment response is delayed", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.goto("/");

  await page.route("**/views/swarm/member.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.evaluate(() => {
    history.pushState({}, "", "/swarm/members/athena");
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

// RM-41. These three routes resolve to placeholder stubs that exist only so
// links out of /changelog do not 404. They are out of sitemap.xml, which stops
// us advertising them but does nothing to stop indexing — and with no seo.js
// entry they inherited the shell's own metadata, so each one served the HOME
// PAGE's title and `index, follow` at a second URL. Assert the override, not
// just the absence from the sitemap, because the sitemap was never the thing
// keeping them out of the index.
const NOINDEX_STUB_ROUTES = [
  { path: "/flow-field", title: "Flow Field (in progress) — Robot Money" },
  { path: "/regime_2panel", title: "Regime Classifier, 2-panel reference — Robot Money" },
  { path: "/tech-proposal-march-16", title: "Technical Proposal, March 16 (archived) — Robot Money" },
];

for (const { path, title } of NOINDEX_STUB_ROUTES) {
  test(`${path} resolves to its stub and is noindexed, not the home page`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await page.goto("/");
    await navigate(page, path);

    await expect(page.locator("h1.stub__title")).toBeVisible();
    await expect(page).toHaveTitle(title);
    // `follow`, not `nofollow`: each stub's only links are /changelog and /,
    // both real indexed pages whose value should carry.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");

    await expectNoBrowserErrors(errors);
  });
}

test("the noindex override does not leak onto the next route", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/flow-field");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  await navigate(page, "/faq");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index, follow/);
});

// The inverse of the stub tests above: these two are REAL pages that were being
// noindexed. views/media/ ships articles.html and videos.html and views/media.html
// links to both, but seo.js had no `/media` section prefix, so each fell through
// to NOT_FOUND_META and served "Page Not Found — Robot Money" under
// `noindex, follow` while rendering its content perfectly well.
const MEDIA_SECTION_ROUTES = [
  { path: "/media/articles", title: "Articles — Robot Money Media" },
  { path: "/media/videos", title: "Videos — Robot Money Media" },
];

for (const { path, title } of MEDIA_SECTION_ROUTES) {
  test(`${path} is a real page and says so, rather than "Page Not Found"`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await page.goto("/");
    await navigate(page, path);

    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index, follow/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://robotmoney.network${path}`,
    );

    await expectNoBrowserErrors(errors);
  });
}

// routes.js rewrites the pre-rename paths (issue #263 pass 2) and serves the
// renamed page's own fragment, so an old URL returns 200 with real content —
// which makes it a duplicate of the new URL unless it points at it. seo.js had
// no matching rewrite, so /docs/investment-committee/* declared ITSELF
// canonical and competed with the /docs/investment-swarm/* page it renders.
test("a legacy /docs/investment-committee URL is canonical to its renamed address", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.goto("/");
  await navigate(page, "/docs/investment-committee/how-it-works");

  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://robotmoney.network/docs/investment-swarm/how-it-works",
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    "content",
    "https://robotmoney.network/docs/investment-swarm/how-it-works",
  );
  // The rewrite must not cost the page its own copy — before it, this path
  // still reached the /docs section prefix and got a real title, and it should
  // keep exactly that one.
  await expect(page).toHaveTitle("How It Works — Robot Money Docs");

  await expectNoBrowserErrors(errors);
});

// renderMeta() is a pure string function with no DOM, so this needs no `page`.
// It lives in this file because seo.js is browser code and this spec is where
// its route-metadata behaviour is already covered.
//
// The reason it needs its own test: renderMeta substitutes a title derived from
// the raw last path segment, and its intended caller is the api process's shell
// fallback, which is handed arbitrary decoded request paths. Passing a STRING as
// the second argument to String.prototype.replace makes `$&`, `$'`, "$`" and
// `$n` replacement PATTERNS rather than literals, so a `$` in the URL is
// expanded instead of inserted: `$&` re-injects the matched tag along with its
// quote and reopens the attribute, and `$'` splices in the rest of the document
// once per substitution.
const INJECTION_PATHS = [
  ["a $& pattern plus markup", "/docs/$&><img src=x onerror=alert(1)>"],
  ["a $' pattern, which self-amplifies", "/docs/x$'y"],
  ["six $' patterns", "/docs/$'$'$'$'$'$'"],
  ["a raw double quote", '/docs/a"onload=alert(1) x'],
  ["a $` pattern", "/swarm/members/w$`oon"],
  ["numbered $n patterns", "/docs/$1$2$3"],
];

test("renderMeta neither expands $ replacement patterns nor lets a path escape an attribute", async () => {
  // node:fs, not Bun.file — Playwright's runner is Node.
  const shell = readFileSync(join(process.cwd(), "frontend/public/index.html"), "utf8");

  const headOf = (html: string) => html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? "";
  // Counting `<` is the structural invariant: a correctly escaped substitution
  // can only ever change the TEXT inside existing tags, never create a tag. Any
  // `<` the payload carries arrives as `&lt;`. Asserting on the raw string
  // instead (say, matching an `on*=` attribute) cannot tell a live attribute
  // from the same characters safely escaped inside a quoted value.
  const openAngles = (html: string) => (html.match(/</g) ?? []).length;
  const shellAngles = openAngles(headOf(shell));

  for (const [label, path] of INJECTION_PATHS) {
    const out = renderMeta(shell, path);
    const head = headOf(out);

    expect(openAngles(head), `${label}: new markup created in <head>`).toBe(shellAngles);
    // $' splices the remainder of the document in, once per substitution.
    expect(out.length, `${label}: output size`).toBeLessThan(shell.length + 2000);
    // No substituted value may carry a character that would end its attribute
    // or open a tag. `[^"]*` cannot capture a raw quote, so a payload that
    // escaped its attribute shows up as a SHORTER capture plus stray markup,
    // which the angle-bracket count above catches.
    for (const [, value] of out.matchAll(/(?:href|content)="([^"]*)"/g)) {
      expect(value.includes("<"), `${label}: raw < inside an attribute value`).toBe(false);
    }
  }
});

declare global {
  interface Window {
    Chart?: {
      getChart(canvas: HTMLCanvasElement): { id: string } | undefined;
      instances?: Record<string, unknown>;
    };
  }
}

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
    if (message.type() !== "error") return;
    // "Failed to load resource" carries no URL in its text; Chromium puts the
    // failing resource in the message's location. Without it a full-stack
    // failure named a 404 and nothing else.
    const where = message.location()?.url;
    errors.push(`console: ${message.text()}${where ? ` (${where})` : ""}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  // Let pending module/CDN failures reach the browser event loop.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual([]);
}

// Issue #827: the smoke seed writes the Woon session on ITS OWN clock,
// strictly before this spec runs (scripts/lib/smoke-main.ts). Recomputing
// `new Date()` here to build the session URL assumed the two clocks always
// land on the same calendar day — false once in a while a run straddles
// 00:00 UTC, when the seed's `today` and this test's `today` disagree and
// the page 404s with no session to render. Read the date the API actually
// stored instead of recomputing it.
//
// The take count is read the same way. The seed drives three members, and a
// member whose model refuses or times out is recorded absent, as the session
// is built to tolerate; the page is right to show the takes that landed.
async function resolveSeededSession(page: Page, subjectId: string): Promise<{ date: string; takes: number }> {
  const match = await page.evaluate(async (id) => {
    const res = await fetch(`/api/swarm/sessions?limit=50`);
    const body = await res.json();
    const row = (body.sessions as Array<{ subjectId: string; date: string; takeCount?: number }>).find((s) => s.subjectId === id);
    return row ? { date: row.date, takes: Number(row.takeCount) } : null;
  }, subjectId);
  // Fail loudly rather than falling back to a computed date: a null here
  // means the seed did not run (or ran for a different subject), which is a
  // real defect this test must still catch — not paper over.
  if (!match) throw new Error(`no swarm session found for subject "${subjectId}" — did the seed run?`);
  if (!(match.takes > 0)) throw new Error(`the seeded ${subjectId} session carries no takes — no member filed`);
  return match;
}

test("renders allocation and dynamic swarm routes through Alpine", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.goto("/");
  await navigate(page, "/allocation");
  await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
  // The allocationView factory draws the allocation donut and the yield
  // comparison as hand-authored inline SVG (RM-115 replaced the Chart.js pies).
  await expect(page.locator(".alp__ring circle[data-sleeve]").first()).toBeVisible();

  // RM-115: the page reads the VAULTS and the allocation framework, and the
  // house book is gone from it entirely. Until the four-vault route is served,
  // the Vaults section reads rmUSDC from vault-economics (lib/vault-source.js),
  // so its TVL is derived from that same endpoint and stays correct as the
  // in-CI Base RPC stub's fixtures evolve (issue #48; zero live Base mainnet
  // calls).
  const expected = await page.evaluate(async () => {
    const v = await fetch("/api/dashboards/vault-economics").then((r) => r.json());
    // Mirrors allocationView.actualUsd through fmtUsd, whole dollars,
    // INCLUDING its null branch. A documented #120 degrade (a null tvlUsd, say)
    // has to surface here as a text diff against the rendered "", not as an
    // opaque TypeError inside evaluate().
    const usd0 = (n: number | null) =>
      typeof n !== "number" ? "" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    return { vault: usd0(v.tvlUsd) };
  });
  // The vault's TVL is rmUSDC's Actual in dollars, in the Vaults table; the
  // meta rail above the weights carries the router, which holds nothing.
  const vaultRows = page.locator("#vaults tbody tr");
  const rmusdcTvl = vaultRows.first().locator("td[data-col=actual] small");
  await expect(vaultRows).toHaveCount(4);
  await expect(rmusdcTvl).toHaveText(expected.vault);
  await expect(page.locator(".alp__meta")).not.toContainText("Deployed");

  // THE CONSTRAINT A REVIEWER CHECKS FIRST (RM-115): depositor capital and the
  // protocol's own wallets are different money, and this page reads only the
  // first. Asserted as the absence of the REQUEST, not of a number: a page that
  // fetched the house book and merely declined to print it would still be one
  // edit away from printing it again.
  const houseBookHits: string[] = [];
  await page.route("**/api/dashboards/wallet-*", (route) => {
    houseBookHits.push(route.request().url());
    return route.continue();
  });
  await navigate(page, "/");
  await navigate(page, "/allocation");
  await expect(rmusdcTvl).toHaveText(expected.vault);
  expect(houseBookHits).toEqual([]);
  await page.unroute("**/api/dashboards/wallet-*");

  // The NAV line went to the vault pages with the holdings it described.
  await expect(page.locator(".alp__pending")).toHaveCount(0);

  // #vault is still the anchor the deposit skill and the swarm's vault row
  // point at. It sits on the Vaults heading, inside #vaults.
  await expect(page.locator("#vaults #vault")).toBeVisible();
  await expect(page.locator("#allocation")).toBeVisible();

  // Test performance page with Wallet Performance heading
  await navigate(page, "/performance");
  await expect(page.getByRole("heading", { name: /Wallet Performance/, exact: false })).toBeVisible();

  // A member's page is a research record now (RM-121); its h1 still carries
  // .profile-name. The tagline under it (.profile-role) shows only what the
  // member declared: the seeded member declares none, and the page used to
  // invent "Athena reads the session through a macro lens." to fill the line.
  // The declared lens is what every seat carries, so the rendered page is
  // proven by it instead.
  await page.goto("/swarm/members/athena");
  await expect(page.locator(".profile-name")).toHaveText("Athena");
  await expect(page.locator("#intent .rr-profile__lens")).not.toHaveText("");
  await expect(page.locator(".profile-role")).not.toContainText("reads the session through");

  const woon = await resolveSeededSession(page, "woon");
  await page.goto(`/swarm/${woon.date}/woon`);
  await expect(page.locator(".session-title")).toHaveText("Woon Treasury");
  // The per-member submissions table became the vote chart (RM-121): one dot
  // per member who took part, keyed on the member like the table rows were
  // (issue #573), so a revision never adds a second dot for the same member.
  const takesSection = page.locator("#takes");
  await expect(takesSection.locator(".rr-vote__dot")).toHaveCount(woon.takes);
  // The turnout is the facts row's take count, stated once.
  await expect(page.locator(".rr-meta > .rr-meta__i").filter({ hasText: /^\s*Takes/ })).toHaveText(new RegExp(`^\\s*Takes\\s+${woon.takes}\\s*$`));

  // Live loadApi -> camelTake -> take-card render path (issue #75): a
  // live/current Woon session served from the Postgres swarm API (not the
  // pre-2026-07-01 static archive) renders one member-opinion card per
  // participating member: runSession drives athena/boreas/cygnus, and one card
  // renders for each that filed. Each card carries the member name, a non-empty
  // role/lens, a stance badge, its confidence and the signature seal: guards a
  // silent regression in the member-opinion render surface.
  const takeCards = takesSection.locator(".rr-take");
  await expect(takeCards).toHaveCount(woon.takes);
  const firstCard = takeCards.first();
  await expect(firstCard.locator(".sv__member-link")).not.toHaveText("");
  await expect(firstCard.locator(".sv__take-lens")).not.toHaveText("");
  // Stance and confidence apart, as every take card sets them.
  await expect(firstCard.locator(".sv__stance-badge")).toHaveText(/^\s*[a-z]+\s*$/);
  await expect(firstCard.locator(".rr-conf")).toHaveText(/^\s*Confidence \d+%\s*$/);
  await expect(firstCard.locator(".sv__vfy[data-verified-badge]")).toHaveCount(1);

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
//
// The route list is READ OFF THE NAV, not hand-maintained here. It used to be
// a literal, and RM-105 (PR #774) shipped /vault — a new nav page whose
// headline was 48px at a 9px-lower offset than every other one — without this
// test ever looking at it, because the literal still said "/allocation". The
// vault route has since been rolled back, but the lesson is why this list is
// derived: the next page added to the nav is covered the day it lands, not the
// day someone remembers to edit an array.
const EXTRA_HERO_ROUTES = [
  // Routed and hero-shaped, but deliberately not advertised in the nav:
  // /projects is linked from content only.
  "/projects",
];

// The hero bands components.css pins to one offset. Since RM-124 the nav also
// reaches pages that open without one (a vault, a subject, the docs), and the
// invariant is about the bands, so those are passed over rather than listed.
const HERO_BANDS = ".a2-hero, .sv__hero, .rv__hero, .tok__hero, .md-hero, .cl__hero, .sk__head";

async function heroRoutes(page: Page): Promise<string[]> {
  const nav = await page.locator(".nav a[href^='/']").evaluateAll((els) =>
    els.map((el) => el.getAttribute("href") as string));
  // "/" is the home page: a full-bleed landing hero, not one of the nav pages
  // this invariant is about. A link to a section of a page (/swarm#members) is
  // that page again, and llms.txt is a file.
  const routes = [...new Set([...nav, ...EXTRA_HERO_ROUTES])]
    .filter((h) => h !== "/" && !h.includes("#") && !/\.[a-z]+$/.test(h));
  // A derived list that silently derives to nothing would pass this test
  // without asserting anything.
  expect(routes.length).toBeGreaterThanOrEqual(7);
  return routes;
}

test("every hero headline shares one size, one typeface and one offset", async ({ page }) => {
  await page.goto("/");
  const HERO_ROUTES = await heroRoutes(page);

  const seen: Record<string, { size: string; family: string; transform: string; top: number }> = {};
  for (const route of HERO_ROUTES) {
    await navigate(page, route);
    const band = page.locator(`#view :is(${HERO_BANDS})`).first();
    if (!(await band.count())) continue;
    const h1 = band.locator("h1").first();
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

  const checked = Object.keys(seen);
  // The pages that carried the nav before RM-124 all open with a band.
  expect(checked.length).toBeGreaterThanOrEqual(7);
  const first = seen[checked[0]];
  for (const route of checked) {
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
  // /performance rather than /allocation. Both view factories build Chart.js
  // canvases, so either proves the teardown; this one moved here in #802 when
  // /allocation briefly resolved to an inline-SVG page, and there is no reason
  // to move it back now that it does not.
  await navigate(page, "/performance");
  const perfCanvas = page.locator(".a2-chart canvas").first();
  await expect(perfCanvas).toBeVisible();
  const chartId = await perfCanvas.evaluate((canvas) => {
    const chart = window.Chart?.getChart(canvas as HTMLCanvasElement);
    if (!chart) throw new Error("performance Chart.js instance was not created");
    return chart.id;
  });

  // The logo is the way home: the nav has no Home link (RM-124).
  await page.locator(".nav__logo").click();
  await expect(page.locator(".a2-chart canvas")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate((id) => Boolean(window.Chart?.instances?.[id]), chartId)
  ).toBe(false);

  await navigate(page, "/blog");
  const p5Canvas = page.locator(".hero-art__canvas canvas").first();
  await expect(p5Canvas).toBeVisible();
  const handle = await p5Canvas.elementHandle();
  if (!handle) throw new Error("p5 canvas was not created");

  await page.locator(".nav__logo").click();
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
  { path: "/visualizations", title: "Robot Money Visualizations — Live Vault Data" },
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

test("/vault renders the allocation page and declares it canonical", async ({ page }) => {
  // Bare /vault is the four vaults on /allocation: the router moves the
  // address to /allocation#vaults before it renders, so navigate(), which
  // waits for the render of the path it pushed, cannot drive it. A direct load
  // can. It is still an EXPLICIT route, not an absence: the catch-all maps an
  // unknown path to /views/<path>.html, which for /vault is now the per-vault
  // page.
  await page.goto("/vault");
  await expect(page).toHaveURL(/\/allocation#vaults$/);
  await expect(page.locator("section.alp")).toHaveCount(1);
  // Two addresses, one page: seo.js names /allocation canonical for both so
  // they do not compete as duplicates, and the page stays indexable.
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href", "https://robotmoney.network/allocation");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index, follow/);
});

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


// Every stylesheet is requested with `?v=<first 8 of its sha256>`, and this
// asserts the stamp still matches the file.
//
// WHY THE STAMP EXISTS. Cloudflare fronts the site with
// `cache-control: public, max-age=14400` on static assets, so a CSS deploy is
// invisible for up to four hours: on 2026-08-28 staging served the new markup
// against the previous stylesheet, with the session spread bar, the status
// chip and the link convention all styled by rules that were not there yet.
// The edge ignores a request-side `Cache-Control: no-cache`, and only a
// dashboard purge or a changed URL gets through. A changed URL is the half the
// frontend owns; RM-112 asks for the dashboard half, which is the only thing
// that can fix module JS (main.js imports ~30 files by relative path, so
// stamping the entry point does not stamp the graph).
//
// WHY THIS TEST EXISTS. A hand-maintained version token rots the first time
// somebody edits CSS without bumping it, and it rots SILENTLY into exactly the
// bug it was added to prevent. Deriving it from the content means the only way
// to be wrong is to be caught here.
//
// Regenerate every stamp after changing any stylesheet:
//
//   python3 - <<'PY'
//   import hashlib, pathlib, re
//   root = pathlib.Path("frontend/public"); idx = root / "index.html"
//   def stamp(m):
//       href = m.group(1)
//       h = hashlib.sha256((root / href.lstrip("/")).read_bytes()).hexdigest()[:8]
//       return f'href="{href}?v={h}"'
//   idx.write_text(re.sub(r'href="(/assets/css/[^"?]+\.css)(?:\?v=[0-9a-f]+)?"', stamp, idx.read_text()))
//   PY
test("every stylesheet is cache-busted by its own content hash", () => {
  const root = join(process.cwd(), "frontend/public");
  const html = readFileSync(join(root, "index.html"), "utf8");
  const links = [...html.matchAll(/href="(\/assets\/css\/[^"?]+\.css)(\?v=([0-9a-f]+))?"/g)];

  expect(links.length, "index.html should still be linking stylesheets").toBeGreaterThan(0);

  const stale: string[] = [];
  for (const [, href, , stamped] of links) {
    const actual = createHash("sha256").update(readFileSync(join(root, href.slice(1)))).digest("hex").slice(0, 8);
    if (stamped !== actual) stale.push(`${href} is stamped ?v=${stamped ?? "(none)"} but hashes to ${actual}`);
  }
  expect(stale, "regenerate the stamps: see the snippet above this test").toEqual([]);
});

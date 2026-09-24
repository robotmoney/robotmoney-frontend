// Section links on the research pages (RM-134): lib/heading-anchors.js and the
// .rm-hlink rules in components.css.
//
// Runs against a plain static server with /api answering 503: every page here
// is static prose, and the one live panel on /research/channel-divergence is
// not what is under test. Specs enter at "/" (the only path a plain static
// server is sure to answer with the shell) and move in-app from there.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navigate } from "./navigation.ts";

test.use({ viewport: { width: 1440, height: 900 } });

const VIEWS = join(process.cwd(), "frontend/public/views");
const RESEARCH_VIEWS = [
  "regime/indicators.html",
  "blog.html",
  "blog/ai-ate-the-bull-market.html",
  "blog/announcement.html",
  "blog/honest-backtesting-weights.html",
  "blog/peaq-partnership.html",
  "blog/regime-conservative-aggressive.html",
  "blog/regime-eq-vs-base.html",
  "blog/treasury-allocation.html",
  "research/channel-divergence.html",
  "research/late-cycle-signals.html",
  "smart-contract-risks.html",
  "regime-detection.html",
];

// The ids are in the HTML, not generated at runtime, so a reader without
// JavaScript and an agent reading the fragment get the same addresses.
test("every research view opts in, and every h2 and h3 in it has a unique id", () => {
  for (const file of RESEARCH_VIEWS) {
    const src = readFileSync(join(VIEWS, file), "utf8");
    expect(src, `${file} has no data-anchors root`).toMatch(/<(section|article)\b[^>]*\sdata-anchors[\s>]/);
    const headings = [...src.matchAll(/<h[23]\b[^>]*>/g)].map((m) => m[0]);
    expect(headings.length, `${file} has no h2/h3`).toBeGreaterThan(0);
    // A heading whose text Alpine binds has no stable slug, and is exempt.
    const missing = headings.filter((h) => !/\sid="[^"]+"/.test(h) && !/\sx-(text|html)=/.test(h));
    expect(missing, `${file}: headings without an id`).toEqual([]);
    const ids = [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), `${file}: duplicate ids`).toEqual([]);
  }
});

test("a section link shows on hover and copies the section's full address", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL!).origin });
  await page.goto("/");
  await navigate(page, "/smart-contract-risks");

  const heading = page.locator("#view h3#drift-protocol");
  const link = heading.locator(".rm-hlink");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", "#drift-protocol");
  await expect(link).toHaveAttribute("aria-label", "Link to this section");
  // The glyph is generated content: the heading's own text is untouched.
  await expect(heading).toHaveText("Drift Protocol: Durable Nonce + Multisig Social Engineering Attack");

  await expect(link).toHaveCSS("opacity", "0");
  await heading.hover();
  await expect(link).toHaveCSS("opacity", "1");

  await link.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#drift-protocol");
  const expected = await page.evaluate(() => `${location.origin}${location.pathname}#drift-protocol`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  await expect(link).toHaveClass(/\bis-copied\b/);
  const region = page.locator("body > .rm-visually-hidden[aria-live]");
  await expect(region).toHaveText("Link copied");

  // A second copy reuses the one live region, and a second pass over the same
  // view adds no second link.
  await page.locator("#view h2#patterns").hover();
  await page.locator("#view h2#patterns .rm-hlink").click();
  await expect(region).toHaveCount(1);
  await page.evaluate(() => dispatchEvent(new CustomEvent("rm:view-changed", { detail: { pathname: location.pathname } })));
  await expect(heading.locator(".rm-hlink")).toHaveCount(1);
});

test("a link to a section from another page lands the heading clear of the fixed nav", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/smart-contract-risks");
  await navigate(page, "/regime-detection#indicator-universe");
  const top = () => page.evaluate(() => document.getElementById("indicator-universe")?.getBoundingClientRect().top ?? null);
  const landed = async () => { const t = await top(); return t !== null && t >= 80 && t <= 130 ? "landed" : t; };
  // The router scrolls a frame after render, smoothly, and holds the target
  // while the view settles, so poll rather than sample once; then sample again
  // a moment later, so a scroll still passing through the band does not count.
  await expect.poll(landed, { timeout: 8000 }).toBe("landed");
  await page.waitForTimeout(600);
  expect(await landed()).toBe("landed");
});

test("the glossary links to the section id the dashboard uses; blog cards get no link inside their link", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/regime/indicators");
  await expect(page.locator('#view h3[id="10y-2y-yield-curve"] .rm-hlink')).toHaveAttribute("href", "#T10Y2Y");
  await expect(page.locator("#view h2#macro-panel .rm-hlink")).toHaveAttribute("href", "#panel-macro");

  await navigate(page, "/blog");
  await expect(page.locator("#view .blog-card h3[id]").first()).toBeAttached();
  await expect(page.locator("#view .blog-card .rm-hlink")).toHaveCount(0);
});

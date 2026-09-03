// Every route in sitemap.xml must ship its own content to a reader that does
// not execute JavaScript.
//
// THE REGRESSION THIS EXISTS TO CATCH, stated as it was actually found. Before
// scripts/prerender.ts inlined view fragments, a non-browser reader got 788
// characters on /allocation and 772 on /regime: nav, footer, legal boilerplate,
// not one figure, and the two pages indistinguishable apart from the <title>.
// 27 of the 37 sitemap routes were in that state, including the home page and
// every blog post. Only /docs read correctly, because backend/src/api/static.ts's
// docsShell already did this one thing at request time for that one subtree.
//
// None of that is visible in a browser, which is exactly why it survived: the
// site looks perfect to every human who opens it. It is only visible to a
// crawler, an LLM, or an agent's fetch tool, and none of those file bug reports.
// So the guarantee has to be asserted here or it does not hold.
//
// The prerender is run for real into a temp directory rather than checked
// against a committed fixture: the claim is about what a deploy serves, and a
// fixture keeps passing long after the injection stops happening.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewFor } from "../../../frontend/public/assets/js/app/routes.js";

const repoRoot = join(import.meta.dir, "../../..");
const publicDir = join(repoRoot, "frontend/public");

const sitemap = readFileSync(join(publicDir, "sitemap.xml"), "utf8");
const ROUTES = Array.from(sitemap.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g), (m) => m[1] || "/");

const dir = mkdtempSync(join(tmpdir(), "rm-prerender-"));
cpSync(publicDir, dir, { recursive: true });
const run = Bun.spawnSync(["bun", "scripts/prerender.ts"], { cwd: repoRoot, env: { ...process.env, PRERENDER_DIR: dir } });

const fileFor = (route: string) => (route === "/" ? join(dir, "index.html") : join(dir, route.slice(1), "index.html"));
const htmlFor = (route: string) => readFileSync(fileFor(route), "utf8");

/** Roughly what an HTML-to-text pass keeps. Comments FIRST: several fragments
 *  quote "<style>" inside a comment, and stripping tag pairs before comments
 *  pairs that with the real closing tag and silently eats the page. */
function readableText(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<[^>]+>/g, " ");
  return h.replace(/\s+/g, " ").trim();
}

const readableChars = (html: string) => readableText(html).length;

// Nav, footer and the legal fine print, measured on a shell with an empty
// mount. Any route at or under this is serving furniture and no content.
const BOILERPLATE_CHARS = 800;

describe("prerendered routes carry their own content", () => {
  test("the prerender ran clean", () => {
    expect(new TextDecoder().decode(run.stderr)).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("sitemap.xml is not empty, so the loops below cannot pass vacuously", () => {
    expect(ROUTES.length).toBeGreaterThan(30);
  });

  test("no route ships an empty view mount", () => {
    // The literal state of all 27 broken routes. If this string survives into a
    // built page, that page is boilerplate to every non-browser reader.
    for (const route of ROUTES) {
      expect(htmlFor(route).includes('<main id="view"></main>'), `${route} shipped an empty view mount`).toBe(false);
    }
  });

  test("every route carries substantially more than nav and footer", () => {
    for (const route of ROUTES) {
      expect(readableChars(htmlFor(route)), `${route} is boilerplate only`).toBeGreaterThan(BOILERPLATE_CHARS * 1.5);
    }
  });

  test("each route inlines its OWN fragment, exactly once", () => {
    // Exactly once matters in both directions: zero means the route regressed to
    // a shell, twice means the reader (and any LLM indexing us) sees the page
    // duplicated. Comparing against the real fragment body, resolved through the
    // client router's own viewFor(), also catches a route being prerendered with
    // some other page's content.
    for (const route of ROUTES) {
      const body = readFileSync(join(publicDir, viewFor(route).replace(/^\//, "")), "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim();
      const html = htmlFor(route);
      expect(html.split(body).length - 1, `${route} does not inline ${viewFor(route)} exactly once`).toBe(1);
    }
  });

  test("the data pages a reader most wants are no longer blank", () => {
    // Named explicitly rather than left to the loop above: these four are the
    // pages the outside report was about, and a threshold test would keep
    // passing if they alone regressed while the blog carried the total.
    for (const [route, marker] of [
      ["/regime", "Regime Classifier"],
      ["/allocation", "Asset Allocation"],
      ["/performance", "Wallet Performance"],
      ["/swarm", "Investment Swarm"],
    ] as const) {
      // Matched against EXTRACTED TEXT, not raw HTML: these headings are split
      // by inner markup (`<h1>Asset <span>Allocation</span></h1>`), so a raw
      // substring match fails on a page that is perfectly fine.
      const html = htmlFor(route);
      expect(readableText(html), `${route} lost its heading`).toContain(marker);
      expect(readableChars(html), `${route} is thin`).toBeGreaterThan(1200);
    }
  });
});

describe("what gets inlined is safe to inline", () => {
  test("no <script> reaches a prerendered page body", () => {
    // An inlined <script> would execute during initial parse, before main.js
    // registers the Alpine factories it might depend on. prerender.ts refuses
    // rather than shipping one; this asserts the outcome, not the intent.
    for (const route of ROUTES) {
      const body = htmlFor(route).split("</head>")[1] ?? "";
      const inlined = body.slice(body.indexOf('<main id="view">'), body.indexOf("</main>"));
      expect(/<script[\s>]/i.test(inlined), `${route} inlined a <script>`).toBe(false);
    }
  });

  test("internal engineering comments are stripped from the published body", () => {
    // The fragments carry house-style banners ("NO <script>, NO custom Alpine
    // factories, NO gradients"). They belong in the source, not in a page we are
    // asking people and their agents to read and cite. Several also QUOTE tags,
    // which a naive text extractor pairs with the real closing tag further down
    // and swallows the page between.
    for (const route of ROUTES) {
      const html = htmlFor(route);
      const inlined = html.slice(html.indexOf('<main id="view">'), html.indexOf("</main>"));
      expect(inlined.includes("<!--"), `${route} published a source comment`).toBe(false);
    }
  });

  test("no page grows a second <html>, <body> or doctype from its fragment", () => {
    for (const route of ROUTES) {
      const html = htmlFor(route);
      expect(html.split(/<html\b/i).length - 1, `${route} <html>`).toBe(1);
      expect(html.split(/<body\b/i).length - 1, `${route} <body>`).toBe(1);
      expect(html.split(/<!doctype/i).length - 1, `${route} doctype`).toBe(1);
    }
  });
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
  expect(true).toBe(true);
});

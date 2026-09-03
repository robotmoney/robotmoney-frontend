import { metaFor } from "../frontend/public/assets/js/app/seo.js";
import { viewFor } from "../frontend/public/assets/js/app/routes.js";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ORIGIN as API_ORIGIN, endpointsForRoute, openApiPath } from "./lib/agent-endpoints.ts";
import { publishableFragment } from "./lib/prerender-view.ts";

const ORIGIN = "https://robotmoney.network";

const repoRoot = join(import.meta.dir, "..");
const sitemapPath = join(repoRoot, "frontend/public/sitemap.xml");
// WHICH assembly to prerender in place. There are two hosts and one
// prerenderer (docs/decisions.md D29): `_site` is the Cloudflare Pages deploy
// dir `scripts/cloudflare-statics.sh` assembles, and `PRERENDER_DIR` points
// this at the api process's STATIC_DIR assembly instead
// (scripts/static-assembly.sh). Both read the SAME metadata table — seo.js's
// `metaFor` — so the two hosts can never disagree, and neither can disagree
// with the JS path that runs after hydration.
const siteDir = resolve(repoRoot, process.env.PRERENDER_DIR || "_site");
const shellPath = join(siteDir, "index.html");

if (!(await Bun.file(shellPath).exists())) {
  console.error(`Error: ${shellPath} does not exist. Run static asset assembly before prerendering.`);
  process.exit(1);
}

const sitemapText = await Bun.file(sitemapPath).text();
// Derived from ORIGIN rather than spelled out again: a hardcoded host here
// silently half-matched when the site moved to .network — `robotmoney.net`
// matched inside `robotmoney.network` and captured `work/…` as the route,
// so every page prerendered into an `ork/` directory and the real routes
// were never written.
const ORIGIN_PATTERN = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const locMatches = sitemapText.matchAll(new RegExp(`<loc>${ORIGIN_PATTERN}([^<]*)</loc>`, "g"));
const routes = Array.from(locMatches, (m) => m[1] || "/");

const shell = await Bun.file(shellPath).text();

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The second half of the prerender, and the reason it exists beyond link
// unfurling: telling a non-browser reader where this page's DATA is.
//
// A prerendered route still ships an empty <main>. Baking the numbers in is not
// possible from here (the API is not up when the assembly runs, and a baked
// number would be stale the moment it deployed), so instead every route names
// the endpoints that fill it, in two places:
//
//   <link rel="alternate" type="application/json"> in <head>, for anything
//   that parses link relations;
//
//   a <noscript> block after </main>, for anything that reduces HTML to text.
//   <noscript> is the exact semantic wanted here: a client running our JS never
//   renders it, so there is no flash and no visual change, while the raw bytes
//   carry the URLs. An agent's fetch tool IS a client that does not run the JS.
function routeDataLinks(route: string): string {
  const endpoints = endpointsForRoute(route);
  if (!endpoints.length) return "";
  return endpoints
    .map((e) => {
      const url = API_ORIGIN + openApiPath(e.path);
      return `    <link rel="alternate" type="application/json" href="${escapeAttr(url)}" title="${escapeAttr(e.summary)}" />`;
    })
    .join("\n");
}

function routeDataBlock(route: string): string {
  const endpoints = endpointsForRoute(route);
  const items = endpoints
    .map((e) => {
      const url = API_ORIGIN + openApiPath(e.path);
      const templated = e.params?.some((p) => p.in === "path");
      // A templated URL is not fetchable, so it is not offered as a link.
      const target = templated
        ? `<code>${escapeHtml(url)}</code>`
        : `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;
      return `          <li>${target}: ${escapeHtml(e.summary)}.</li>`;
    })
    .join("\n");

  const lead = endpoints.length
    ? `<p>This page is rendered in the browser, so the HTML you are reading carries no data. The values on it come from these public JSON endpoints, which need no key and answer a plain GET:</p>\n        <ul>\n${items}\n        </ul>`
    : `<p>This page is rendered in the browser, so the HTML you are reading carries no data.</p>`;

  return [
    "<noscript>",
    '      <section id="agent-data">',
    "        <h2>Data for machine readers</h2>",
    `        ${lead}`,
    `        <p>Full API description: <a href="${API_ORIGIN}/openapi.json">${API_ORIGIN}/openapi.json</a>. Site index for LLM readers: <a href="${API_ORIGIN}/llms.txt">${API_ORIGIN}/llms.txt</a>. Source: <a href="https://github.com/robotmoney/robotmoney-frontend">github.com/robotmoney/robotmoney-frontend</a>.</p>`,
    "      </section>",
    "    </noscript>",
  ].join("\n");
}

// The mount the client router injects a view into. Filling it here is the
// difference between a crawler seeing a page and seeing our footer.
const VIEW_MOUNT = '<main id="view"></main>';

// Inline the route's own view fragment into the shell.
//
// This is the whole reason a prerender is worth running. Without it a
// non-browser reader gets nav, footer and legal boilerplate on every route: 788
// characters on /allocation, 772 on /regime, not a single figure, and the two
// pages indistinguishable apart from the <title>. 28 of the 38 routes in
// sitemap.xml were in that state, including the home page and every blog post.
// Only /docs read correctly, because backend/src/api/static.ts's docsShell
// already does this one thing at request time for that one subtree. This
// generalises it to every route and moves it to build time.
//
// `viewFor` is the client router's own resolver (assets/js/app/routes.js),
// imported rather than reimplemented: a second copy of that table would drift,
// and the failure mode of drift is a page prerendered with someone else's
// content. It is pure string logic with no DOM dependency, same as `metaFor`.
//
// Safe to inline because the fragments are, by house convention, script-free
// and carry no <html>/<body>/<!doctype>. Verified over every sitemap route;
// prerenderView throws rather than silently shipping a shell if that changes.
// The docs fragments do contain <main>, which nests, but that is exactly what
// docsShell already ships in production today, so it is not a new condition.
async function prerenderView(html: string, route: string): Promise<string> {
  const viewPath = viewFor(route);
  const fragment = Bun.file(join(siteDir, viewPath.replace(/^\//, "")));
  if (!(await fragment.exists())) {
    throw new Error(`prerender: ${route} resolves to ${viewPath}, which is not in the assembly`);
  }
  // See scripts/lib/prerender-view.ts for what this drops and why: source
  // comments, and the elements the codebase itself marks as not-content-until-
  // hydrated.
  const body = await publishableFragment(await fragment.text());
  if (/<script[\s>]/i.test(body)) {
    // An inlined <script> would run during initial parse, before main.js
    // registers the Alpine factories it may depend on. Refuse rather than ship
    // a page that breaks only in a real browser.
    throw new Error(`prerender: ${viewPath} contains a <script>; inlining it would execute before the app boots`);
  }
  if (!html.includes(VIEW_MOUNT)) throw new Error(`prerender: ${route} shell has no view mount`);
  // A function replacer, never a string: fragments are full of "$ROBOTMONEY"
  // and String.replace reads $-sequences in a string replacement.
  return html.replace(VIEW_MOUNT, () => `<main id="view">${body}</main>`);
}

/** The shell with one route's metadata substituted in. The view mount is still
 *  empty at this point; prerenderView fills it. */
function shellFor(route: string): string {
  const m = metaFor(route);
  const url = ORIGIN + (route === "/" ? "/" : route);
  return shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(m.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeAttr(m.title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escapeAttr(m.title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`)
    .replace("<!--AGENT-DATA-->", () => routeDataBlock(route));
}

// The shell to answer an UNKNOWN client route with, written for
// backend/src/api/static.ts (issue #870).
//
// Its fallback is index.html, which was harmless while index.html was an empty
// shell and is not any more: this prerender fills the view mount, so index.html
// now carries the HOME PAGE'S BODY. Falling back to it answers
// /swarm/members/<id> and /swarm/takes/<id> with the front page, at 200. Those
// are real addresses the client router resolves; they simply cannot be
// prerendered, because the id is not known at build time.
//
// So the assembly also carries the shell with an EMPTY mount, which is what the
// client router expects to hydrate into. Emitted now rather than after #870
// merges, deliberately: static.ts's proposed change falls back to index.html
// when this file is absent, so the two sides can land in either order and
// neither half is broken on its own.
//
// Home's metadata, because a fallback has no route of its own and canonical
// pointing at / is what consolidates these URLs today.
const bareShell = shellFor("/");
await Bun.write(join(siteDir, "_shell.html"), bareShell);

let count = 0;
for (const route of routes) {
  const normalizedRoute = !route || route === "/" ? "/" : route.replace(/\/+$/, "") || "/";

  let html = await prerenderView(shellFor(normalizedRoute), normalizedRoute);

  const dataLinks = routeDataLinks(normalizedRoute);
  if (dataLinks) html = html.replace("  </head>", () => `${dataLinks}\n  </head>`);

  const targetPath = normalizedRoute === "/"
    ? shellPath
    : join(siteDir, normalizedRoute.slice(1), "index.html");

  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, html);
  count++;
}

console.log(`Successfully prerendered ${count} routes into ${siteDir}/ (plus _shell.html for unknown routes)`);

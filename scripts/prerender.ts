import { metaFor } from "../frontend/public/assets/js/app/seo.js";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ORIGIN as API_ORIGIN, endpointsForRoute, openApiPath } from "./lib/agent-endpoints.ts";

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

let count = 0;
for (const route of routes) {
  const normalizedRoute = !route || route === "/" ? "/" : route.replace(/\/+$/, "") || "/";
  const m = metaFor(normalizedRoute);
  const url = ORIGIN + (normalizedRoute === "/" ? "/" : normalizedRoute);

  let html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(m.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeAttr(m.title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escapeAttr(m.title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`)
    .replace("<!--AGENT-DATA-->", routeDataBlock(normalizedRoute));

  const dataLinks = routeDataLinks(normalizedRoute);
  if (dataLinks) html = html.replace("  </head>", `${dataLinks}\n  </head>`);

  const targetPath = normalizedRoute === "/"
    ? shellPath
    : join(siteDir, normalizedRoute.slice(1), "index.html");

  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, html);
  count++;
}

console.log(`Successfully prerendered ${count} routes into ${siteDir}/`);

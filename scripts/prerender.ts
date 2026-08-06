import { metaFor } from "../frontend/public/assets/js/app/seo.js";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ORIGIN = "https://robotmoney.net";

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
const locMatches = sitemapText.matchAll(/<loc>https:\/\/robotmoney\.net([^<]*)<\/loc>/g);
const routes = Array.from(locMatches, (m) => m[1] || "/");

const shell = await Bun.file(shellPath).text();

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escapeAttr(m.description)}$2`);

  const targetPath = normalizedRoute === "/"
    ? shellPath
    : join(siteDir, normalizedRoute.slice(1), "index.html");

  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, html);
  count++;
}

console.log(`Successfully prerendered ${count} routes into ${siteDir}/`);

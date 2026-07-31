import { metaFor } from "../frontend/public/assets/js/app/seo.js";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ORIGIN = "https://robotmoney.net";

const repoRoot = join(import.meta.dir, "..");
const sitemapPath = join(repoRoot, "frontend/public/sitemap.xml");
const siteDir = join(repoRoot, "_site");
const shellPath = join(siteDir, "index.html");

if (!(await Bun.file(shellPath).exists())) {
  console.error("Error: _site/index.html does not exist. Run static asset assembly before prerendering.");
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

console.log(`Successfully prerendered ${count} routes into _site/`);

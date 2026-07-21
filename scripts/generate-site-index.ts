import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_ORIGIN, SITE_ROUTES } from "../contract/src/site.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sitemapPath = join(root, "frontend/public/sitemap.xml");
const robotsPath = join(root, "frontend/public/robots.txt");

const escapeXml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...[...SITE_ROUTES].sort().map((path) => `  <url><loc>${escapeXml(`${SITE_ORIGIN}${path}`)}</loc></url>`),
  '</urlset>',
  '',
].join('\n');

const robots = [
  'User-agent: *',
  'Allow: /',
  'Disallow: /admin',
  'Disallow: /committee/apply/',
  `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
  '',
].join('\n');

if (process.argv.includes("--check")) {
  const [committedSitemap, committedRobots] = await Promise.all([
    readFile(sitemapPath, "utf8").catch(() => ""),
    readFile(robotsPath, "utf8").catch(() => ""),
  ]);
  if (committedSitemap !== sitemap || committedRobots !== robots) {
    console.error("site index is stale; run `bun run site:generate`");
    process.exit(1);
  }
  console.log(`site index current (${SITE_ROUTES.length} canonical routes)`);
} else {
  await Promise.all([
    writeFile(sitemapPath, sitemap),
    writeFile(robotsPath, robots),
  ]);
  console.log(`generated sitemap.xml and robots.txt (${SITE_ROUTES.length} canonical routes)`);
}

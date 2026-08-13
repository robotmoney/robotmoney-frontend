import { test, expect, beforeAll, afterAll } from "bun:test";
import { metaFor } from "../../../frontend/public/assets/js/app/seo.js";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "../../..");
const siteDir = join(repoRoot, "_site");

beforeAll(() => {
  execSync("bash scripts/cloudflare-statics.sh", { cwd: repoRoot, stdio: "ignore" });
});

afterAll(() => {
  rmSync(siteDir, { recursive: true, force: true });
});

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

test("Prerendered per-route HTML matches seo.js metadata and does not fall back to home-page shell metadata", () => {
  const sitemapPath = join(import.meta.dir, "../../../frontend/public/sitemap.xml");
  const sitemapText = readFileSync(sitemapPath, "utf8");
  const locMatches = Array.from(sitemapText.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g));
  const routes = locMatches.map((m) => m[1] || "/");
  
  expect(routes.length).toBeGreaterThan(0);

  const homeMeta = metaFor("/");
  
  for (const route of routes) {
    const normalizedRoute = !route || route === "/" ? "/" : route.replace(/\/+$/, "") || "/";
    const m = metaFor(normalizedRoute);
    const url = "https://robotmoney.network" + (normalizedRoute === "/" ? "/" : normalizedRoute);
    
    const targetPath = normalizedRoute === "/"
      ? join(import.meta.dir, "../../../_site/index.html")
      : join(import.meta.dir, "../../../_site", normalizedRoute.slice(1), "index.html");
      
    if (!existsSync(targetPath)) {
      throw new Error(`Expected prerendered file at ${targetPath} for route ${normalizedRoute}`);
    }
    const html = readFileSync(targetPath, "utf8");
    
    expect(html).toContain(`<title>${escapeHtml(m.title)}</title>`);
    expect(html).toContain(`property="og:title" content="${escapeAttr(m.title)}"`);
    expect(html).toContain(`property="og:description" content="${escapeAttr(m.description)}"`);
    expect(html).toContain(`property="og:url" content="${url}"`);
    
    if (normalizedRoute !== "/" && m.title !== homeMeta.title) {
        expect(html).not.toContain(`<title>${escapeHtml(homeMeta.title)}</title>`);
        expect(html).not.toContain(`property="og:title" content="${escapeAttr(homeMeta.title)}"`);
    }
  }
});

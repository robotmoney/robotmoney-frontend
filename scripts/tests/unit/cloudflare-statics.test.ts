// Assembly & prerender gate: scripts/cloudflare-statics.sh assembles _site
// with key static files, environment headers/redirects, and prerendered per-route HTML.
import { afterAll, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { metaFor } from "../../../frontend/public/assets/js/app/seo.js";

const repoRoot = join(import.meta.dir, "../../..");
const site = join(repoRoot, "_site");

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

describe("cloudflare-statics.sh", () => {
  it("assembles _site in prod mode by default with production headers, redirects, and prerendered routes", () => {
    execSync("bash scripts/cloudflare-statics.sh", { cwd: repoRoot, stdio: "pipe" });

    for (const f of ["index.html", "preview/index.html", "goldens/api-goldens.json", "_redirects", "_headers", "404.html"]) {
      expect(existsSync(join(site, f))).toBe(true);
    }

    const headers = readFileSync(join(site, "_headers"), "utf8");
    expect(headers).not.toContain("X-Robots-Tag: noindex");
    expect(headers).toContain("Cache-Control: public, max-age=31536000, immutable");
    expect(headers).toContain("Cache-Control: public, max-age=300, must-revalidate");

    const redirects = readFileSync(join(site, "_redirects"), "utf8");
    expect(redirects).toContain("https://www.robotmoney.net/*  https://robotmoney.net/:splat  301!");
    expect(redirects).toContain("/*                            /index.html                     200");

    // Check prerendered routes
    for (const route of ["/allocation", "/skills", "/docs/skill/installation"]) {
      const htmlPath = join(site, route.slice(1), "index.html");
      expect(existsSync(htmlPath)).toBe(true);

      const html = readFileSync(htmlPath, "utf8");
      const m = metaFor(route);
      expect(html).toContain(`<title>${escapeHtml(m.title)}</title>`);
      expect(html).toContain(`content="${escapeAttr(m.description)}"`);
      expect(html).toContain(`href="https://robotmoney.net${route}"`);
    }
  });

  it("assembles _site in preview mode with noindex headers and preview redirects", () => {
    execSync("MODE=preview bash scripts/cloudflare-statics.sh", { cwd: repoRoot, stdio: "pipe" });

    const headers = readFileSync(join(site, "_headers"), "utf8");
    expect(headers).toContain("X-Robots-Tag: noindex");

    const redirects = readFileSync(join(site, "_redirects"), "utf8");
    expect(redirects).toContain("/ /preview/index.html 200");
  });

  afterAll(() => {
    rmSync(site, { recursive: true, force: true });
  });
});

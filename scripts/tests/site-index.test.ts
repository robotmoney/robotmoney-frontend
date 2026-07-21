import { describe, expect, test } from "bun:test";
import { SITE_ORIGIN, SITE_REDIRECTS, SITE_ROUTES, injectSiteMeta, metaForPath } from "../../contract/src/site.js";

describe("public site index", () => {
  test("injects unique canonical metadata and section artwork", () => {
    const shell = '<head><!-- ROUTE_META_START --><title>old</title><!-- ROUTE_META_END --></head>';
    const committee = injectSiteMeta(shell, "/committee");
    const blog = injectSiteMeta(shell, "/blog/announcement");

    expect(committee).toContain("Investment Committee | Robot Money");
    expect(committee).toContain(`${SITE_ORIGIN}/assets/og/committee.png`);
    expect(blog).toContain(`${SITE_ORIGIN}/blog/announcement`);
    expect(blog).toContain(`${SITE_ORIGIN}/assets/og/blog.png`);
    expect(blog).not.toContain("<title>old</title>");
  });

  test("keeps private status pages out of search indexes", () => {
    expect(metaForPath("/committee/apply/member-123").robots).toBe("noindex,nofollow");
    expect(metaForPath("/committee").robots).toBe("index,follow");
  });

  test("preserves production legacy paths as permanent redirect entries", () => {
    expect(SITE_REDIRECTS).toMatchObject({
      "/allocation2": "/performance",
      "/articles": "/media/articles",
      "/articles/treasury-allocation": "/blog/treasury-allocation",
    });
  });

  test("indexes all eleven production editorial pages", async () => {
    const required = [
      "/blog/ai-ate-the-bull-market",
      "/blog/announcement",
      "/blog/honest-backtesting-weights",
      "/blog/peaq-partnership",
      "/blog/regime-conservative-aggressive",
      "/blog/regime-eq-vs-base",
      "/blog/treasury-allocation",
      "/regime-detection",
      "/smart-contract-risks",
      "/research/channel-divergence",
      "/research/late-cycle-signals",
    ];
    const sitemap = await Bun.file("frontend/public/sitemap.xml").text();
    for (const route of required) {
      expect(SITE_ROUTES).toContain(route);
      expect(sitemap).toContain(`<loc>${SITE_ORIGIN}${route}</loc>`);
      const view = `frontend/public/views${route}.html`;
      expect(await Bun.file(view).exists(), `${view} is missing`).toBe(true);
    }
  });
});

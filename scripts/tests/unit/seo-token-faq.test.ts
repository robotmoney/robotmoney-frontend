// The token page's FAQ (RM-156) is said twice: as static HTML in
// views/tokenomics.html, which people and the prerender read, and as the
// FAQPage in its structured data, which search engines and agents read, built
// from lib/token-faq.js. Search engines discount structured data that the page
// does not show, and an agent quoting a stale answer about a token is worse
// than no answer, so this holds the two to the same words.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMeta, researchRoutes, routeStructuredData } from "../../../frontend/public/assets/js/app/seo.js";
import { TOKEN_CONTRACT, TOKEN_FAQ } from "../../../frontend/public/assets/js/app/lib/token-faq.js";
import { ROUTES } from "../../../contract/src/routes.js";

const repoRoot = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const ORIGIN = "https://robotmoney.network";
const URL = ORIGIN + "/tokenomics";
const view = read("frontend/public/views/tokenomics.html");
const shell = read("frontend/public/index.html");
type Json = Record<string, any>;

// The text a reader sees: tags dropped, entities decoded, whitespace folded.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// One FAQ row of the view, by its id: its question and its answer.
function row(id: string): { q: string; a: string } | null {
  const m = view.match(new RegExp(`<div class="rr-disc" id="${id}"[\\s\\S]*?<button[^>]*>([\\s\\S]*?)</button>[\\s\\S]*?<div class="rr-disc__body tok__faq-a">([\\s\\S]*?)</div></div>`));
  return m ? { q: text(m[1]!), a: text(m[2]!) } : null;
}

const graph = () => (routeStructuredData("/tokenomics") as Json)["@graph"] as Json[];

describe("the token page's FAQ", () => {
  test("every question in lib/token-faq.js is a row on the page, in the same words", () => {
    for (const f of TOKEN_FAQ) {
      const r = row(f.id);
      expect(r, `#${f.id} is not a FAQ row on the page`).not.toBeNull();
      expect(r!.q, `#${f.id} question`).toBe(f.q);
      expect(r!.a, `#${f.id} answer`).toBe(f.a);
    }
  });

  test("the page has no FAQ row the structured data leaves out", () => {
    const ids = Array.from(view.matchAll(/<div class="rr-disc" id="([^"]+)"/g), (m) => m[1]);
    expect(ids).toEqual(TOKEN_FAQ.map((f) => f.id));
  });

  test("its structured data is a FAQPage of those questions, about the token", () => {
    const faq = graph().find((n) => n["@type"] === "FAQPage")!;
    expect(faq["@id"]).toBe(URL + "#faq");
    expect(faq.mainEntity.map((q: Json) => [q["@id"], q.name, q.acceptedAnswer.text])).toEqual(
      TOKEN_FAQ.map((f) => [`${URL}#${f.id}`, f.q, f.a]),
    );
    const token = graph().find((n) => n["@type"] === "Thing")!;
    expect(faq.about).toEqual({ "@id": token["@id"] });
    expect(token.identifier.value).toBe(TOKEN_CONTRACT);
    expect(token.sameAs).toContain(`https://basescan.org/token/${TOKEN_CONTRACT}`);
    // The contract address the page shows is the one it publishes.
    expect(view).toContain(TOKEN_CONTRACT);
  });

  test("the buyback Dataset downloads from the API route the page reads", () => {
    const ds = graph().find((n) => n["@type"] === "Dataset")!;
    expect(ds.distribution[0].contentUrl).toBe(ORIGIN + ROUTES.dashboards.buybacks);
  });

  test("the breadcrumb is Home, then the page under its nav name", () => {
    const crumb = graph().find((n) => n["@type"] === "BreadcrumbList")!;
    expect(crumb.itemListElement.map((i: Json) => [i.name, i.item])).toEqual([["Home", ORIGIN + "/"], ["Token", URL]]);
  });

  test("the prerendered head carries it once, and the page stays a website, outside research", () => {
    const head = renderMeta(shell, "/tokenomics");
    const blocks = Array.from(head.matchAll(/<script type="application\/ld\+json" data-route-ld>([\s\S]*?)<\/script>/g), (m) => m[1]);
    expect(blocks.length).toBe(1);
    expect(JSON.parse(blocks[0]!)).toEqual(routeStructuredData("/tokenomics")!);
    expect(head).toContain('<meta property="og:type" content="website" />');
    expect(researchRoutes()).not.toContain("/tokenomics");
  });

  test("its title fits a search result and its description is not padded from page text", () => {
    const head = renderMeta(shell, "/tokenomics");
    const title = head.match(/<title>([^<]*)<\/title>/)![1]!;
    const desc = head.match(/<meta name="description" content="([^"]*)"/)![1]!;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(desc.length).toBeGreaterThanOrEqual(110);
    expect(desc.length).toBeLessThanOrEqual(160);
  });
});

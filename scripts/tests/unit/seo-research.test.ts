// The research pages (RM-134) describe themselves to people, search engines and
// agents from one table, seo.js's META and BLOG_POSTS: the <title> and meta
// description, a schema.org @graph (a Dataset for the regime classifier, a
// TechArticle per reference or research page, a BlogPosting per post, a
// CollectionPage for the blog index, each with a BreadcrumbList), og:type, the
// sitemap's <lastmod>, and one item each in blog/feed.xml.
//
// Every one of those is invisible in a browser, so this holds them together:
// a title over 60 characters is cut in search results, a description under
// about 110 is padded by the search engine from page text, and a feed or
// sitemap that stops parsing is silently dropped by whoever reads it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  citeTitle,
  metaFor,
  renderMeta,
  researchIndex,
  researchRoutes,
  routeStructuredData,
  routeStructuredDataJson,
} from "../../../frontend/public/assets/js/app/seo.js";
import { ROUTES } from "../../../contract/src/routes.js";

const repoRoot = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

const ORIGIN = "https://robotmoney.network";
const ORG_ID = ORIGIN + "/#org";
const REVISED = "2026-09-24";
const EM_DASH = "\u2014";

// The 14 research pages and the schema.org type each one declares.
const EXPECTED: Record<string, string> = {
  "/regime": "Dataset",
  "/regime/indicators": "TechArticle",
  "/regime-detection": "TechArticle",
  "/smart-contract-risks": "TechArticle",
  "/research/channel-divergence": "TechArticle",
  "/research/late-cycle-signals": "TechArticle",
  "/blog": "CollectionPage",
  "/blog/ai-ate-the-bull-market": "BlogPosting",
  "/blog/announcement": "BlogPosting",
  "/blog/honest-backtesting-weights": "BlogPosting",
  "/blog/peaq-partnership": "BlogPosting",
  "/blog/regime-conservative-aggressive": "BlogPosting",
  "/blog/regime-eq-vs-base": "BlogPosting",
  "/blog/treasury-allocation": "BlogPosting",
};
const RESEARCH = Object.keys(EXPECTED);
const ARTICLE_TYPES = new Set(["TechArticle", "BlogPosting", "Article"]);

const sitemap = read("frontend/public/sitemap.xml");
const SITEMAP_ROUTES = Array.from(sitemap.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g), (m) => m[1] || "/");
const shell = read("frontend/public/index.html");
const headOf = (html: string) => html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? "";

type Json = Record<string, any>;
const graphOf = (ld: Json | null): Json[] => (ld && Array.isArray(ld["@graph"]) ? ld["@graph"] : []);

// ── A strict, small XML reader ─────────────────────────────────────────────
// Bun ships no XML parser and the repo carries none. This one rejects what a
// feed reader or sitemap consumer rejects: an unclosed or mismatched element,
// an unquoted or duplicated attribute, a bare "&" or "<" in text, content after
// the root. It does not validate against a schema; the tests below check the
// elements that matter by name.
type XNode = { name: string; attrs: Record<string, string>; children: XNode[]; text: string };

function parseXml(input: string): XNode {
  const src = input.replace(/^\uFEFF/, "");
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`XML: ${msg} at ${i}: ${JSON.stringify(src.slice(i, i + 40))}`);
  };
  const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
  const checkText = (t: string) => {
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t)) fail("bare &");
  };
  const decode = (t: string) =>
    t.replace(ENTITY, (_m, e: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (named[e]) return named[e]!;
      return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  const skip = (open: string, close: string) => {
    const end = src.indexOf(close, i + open.length);
    if (end < 0) fail(`unterminated ${open}`);
    i = end + close.length;
  };
  const skipMisc = () => {
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src.startsWith("<!--", i)) skip("<!--", "-->");
      else if (src.startsWith("<?", i)) skip("<?", "?>");
      else return;
    }
  };
  const NAME = /^[A-Za-z_][\w.:-]*/;
  const parseElement = (): XNode => {
    if (src[i] !== "<") fail("expected an element");
    i++;
    const name = NAME.exec(src.slice(i))?.[0] ?? fail("bad element name");
    i += name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i))![0];
      i += ws.length;
      if (src.startsWith("/>", i)) {
        i += 2;
        return { name, attrs, children: [], text: "" };
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      if (!ws) fail("attributes must be separated by whitespace");
      const a = /^([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(src.slice(i)) ?? fail("bad attribute");
      const value = a[2] ?? a[3] ?? "";
      if (a[1]! in attrs) fail(`duplicate attribute ${a[1]}`);
      checkText(value);
      attrs[a[1]!] = decode(value);
      i += a[0].length;
    }
    const children: XNode[] = [];
    let text = "";
    for (;;) {
      if (i >= src.length) fail(`unclosed <${name}>`);
      if (src.startsWith("</", i)) {
        const c = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(src.slice(i)) ?? fail("bad closing tag");
        if (c[1] !== name) fail(`</${c[1]}> closes <${name}>`);
        i += c[0].length;
        return { name, attrs, children, text };
      }
      if (src.startsWith("<!--", i)) skip("<!--", "-->");
      else if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i);
        if (end < 0) fail("unterminated CDATA");
        text += src.slice(i + 9, end);
        i = end + 3;
      } else if (src[i] === "<") children.push(parseElement());
      else {
        const end = src.indexOf("<", i);
        const raw = src.slice(i, end < 0 ? src.length : end);
        if (raw.includes("]]>")) fail("]]> in text");
        checkText(raw);
        text += decode(raw);
        i += raw.length;
      }
    }
  };

  if (src.startsWith("<?xml")) skip("<?xml", "?>");
  skipMisc();
  const root = parseElement();
  skipMisc();
  if (i !== src.length) fail("content after the root element");
  return root;
}

const kids = (n: XNode, name: string) => n.children.filter((c) => c.name === name);
const kid = (n: XNode, name: string) => kids(n, name)[0];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("the research table", () => {
  test("seo.js describes exactly the 14 research pages", () => {
    expect([...researchRoutes()].sort()).toEqual([...RESEARCH].sort());
  });

  test("every blog post in the sitemap is one of them, so a new post cannot ship without its structured data", () => {
    const posts = SITEMAP_ROUTES.filter((r) => r.startsWith("/blog/"));
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(RESEARCH, `${post} has no structured data`).toContain(post);
  });
});

describe.each(RESEARCH)("%s", (route) => {
  const m = metaFor(route);

  test("title: at most 60 characters, ends '| Robot Money', no em dash, no route", () => {
    expect(m.title.length, m.title).toBeLessThanOrEqual(60);
    expect(m.title.endsWith(" | Robot Money"), m.title).toBe(true);
    expect(m.title).not.toContain(EM_DASH);
    expect(m.title, "a route string in the title").not.toMatch(/(^|[\s(])\/[a-z]/);
  });

  test("description: 110 to 160 characters, no em dash", () => {
    expect(m.description.length, m.description).toBeGreaterThanOrEqual(110);
    expect(m.description.length, m.description).toBeLessThanOrEqual(160);
    expect(m.description).not.toContain(EM_DASH);
  });

  test("cites by its name, which the title opens with", () => {
    const name = citeTitle(route);
    expect(name.length).toBeGreaterThan(0);
    expect(m.title.startsWith(name), `${m.title} does not open with ${name}`).toBe(true);
  });

  test("its JSON-LD parses and carries the expected type and a breadcrumb", () => {
    const ld = routeStructuredData(route);
    expect(ld).not.toBeNull();
    const text = routeStructuredDataJson(route);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(ld!);
    expect(ld!["@context"]).toBe("https://schema.org");

    const graph = graphOf(ld);
    const node = graph.find((n) => n["@type"] === EXPECTED[route]);
    expect(node, `no ${EXPECTED[route]} node`).toBeDefined();
    expect(node!.url).toBe(ORIGIN + route);
    expect(JSON.stringify(ld)).not.toContain(EM_DASH);

    const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList");
    expect(crumbs, "no BreadcrumbList").toBeDefined();
    const items: Json[] = crumbs!.itemListElement;
    expect(items.map((c) => c.position)).toEqual(items.map((_, i) => i + 1));
    expect(items[0]).toMatchObject({ name: "Home", item: ORIGIN + "/" });
    expect(items[1]).toMatchObject({ name: "Research", item: ORIGIN + "/blog" });
    expect(items.at(-1)!.item).toBe(ORIGIN + route);
    for (const c of items) expect(c["@type"]).toBe("ListItem");
  });

  if (ARTICLE_TYPES.has(EXPECTED[route]!)) {
    test("the article names its author, publisher, image and dates", () => {
      const node = graphOf(routeStructuredData(route)).find((n) => n["@type"] === EXPECTED[route])!;
      expect(typeof node.headline).toBe("string");
      expect(node.headline.length).toBeLessThanOrEqual(110);
      expect(node.author["@id"]).toBe(ORG_ID);
      expect(node.publisher["@id"]).toBe(ORG_ID);
      expect(node.mainEntityOfPage["@id"]).toBe(ORIGIN + route);
      expect(node.image).toBe(ORIGIN + "/assets/og-image.png");
      expect(node.dateModified).toBe(REVISED);
      if (EXPECTED[route] === "BlogPosting") expect(node.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (node.datePublished) expect(node.datePublished <= REVISED).toBe(true);
    });
  }

  test("renderMeta writes exactly one route JSON-LD script, inside <head>, that parses", () => {
    const out = renderMeta(shell, route);
    const head = headOf(out);
    const scripts = Array.from(out.matchAll(/<script type="application\/ld\+json" data-route-ld>([\s\S]*?)<\/script>/g));
    expect(scripts.length).toBe(1);
    expect(head).toContain(scripts[0]![0]);
    expect(JSON.parse(scripts[0]![1]!)).toEqual(routeStructuredData(route)!);
    // Rendering an already rendered page does not stack a second copy.
    expect(renderMeta(out, route).split("data-route-ld").length - 1).toBe(1);
  });

  test("og:type follows the type", () => {
    const out = renderMeta(shell, route);
    const want = ARTICLE_TYPES.has(EXPECTED[route]!) ? "article" : "website";
    expect(out).toContain(`<meta property="og:type" content="${want}" />`);
  });

  test(`sitemap.xml lists it with lastmod ${REVISED}`, () => {
    expect(sitemap).toContain(`<loc>${ORIGIN}${route}</loc><lastmod>${REVISED}</lastmod>`);
  });
});

describe("titles", () => {
  test("no two sitemap pages share a title", () => {
    const seen = new Map<string, string>();
    for (const route of SITEMAP_ROUTES) {
      const t = metaFor(route).title;
      expect(seen.get(t), `${route} and ${seen.get(t)} share "${t}"`).toBeUndefined();
      seen.set(t, route);
    }
  });

  test("the regime page keeps 'Regime Classifier' in its title", () => {
    expect(metaFor("/regime").title).toContain("Regime Classifier");
  });
});

describe("structured data details", () => {
  test("the Organization the articles point at is the one the shell defines", () => {
    const blocks = Array.from(headOf(shell).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g), (m) => JSON.parse(m[1]!));
    const ids = blocks.flatMap((b: Json) => graphOf(b).map((n) => n["@id"]));
    expect(ids).toContain(ORG_ID);
  });

  test("the regime Dataset offers the public regime API as a JSON download over its whole history", () => {
    const ds = graphOf(routeStructuredData("/regime")).find((n) => n["@type"] === "Dataset")!;
    expect(ds.name).toContain("Regime Classifier");
    expect(ds.description.length).toBeGreaterThanOrEqual(50);
    expect(ds.temporalCoverage).toBe("2018-05-15/..");
    expect(ds.isAccessibleForFree).toBe(true);
    expect(ds.creator["@id"]).toBe(ORG_ID);
    expect(ds.publisher["@id"]).toBe(ORG_ID);
    const download = ds.distribution[0];
    expect(download["@type"]).toBe("DataDownload");
    expect(download.encodingFormat).toBe("application/json");
    // The contract's route on the site's origin, so a renamed route fails here.
    expect(download.contentUrl.split("?")[0]).toBe(ORIGIN + ROUTES.dashboards.regimeSnapshots);
  });

  test("the blog's CollectionPage lists every dated research page, newest first", () => {
    const page = graphOf(routeStructuredData("/blog")).find((n) => n["@type"] === "CollectionPage")!;
    const listed = page.mainEntity.itemListElement.map((e: Json) => e.url);
    expect(listed).toEqual(researchIndex().map((e) => ORIGIN + e.path));
    const dates = researchIndex().map((e) => e.meta.published!);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test("a route outside research gets no route JSON-LD and stays a website", () => {
    for (const route of ["/", "/allocation", "/docs/skill", "/swarm", "/not/a/page"]) {
      expect(routeStructuredData(route), route).toBeNull();
      const out = renderMeta(shell, route);
      expect(out.includes("data-route-ld"), route).toBe(false);
      expect(out).toContain('<meta property="og:type" content="website" />');
    }
  });

  test("a legacy address describes the page it renders", () => {
    expect(routeStructuredData("/articles/treasury-allocation")).toEqual(routeStructuredData("/blog/treasury-allocation"));
  });
});

describe("sitemap.xml", () => {
  test("parses as XML with one url per loc", () => {
    const root = parseXml(sitemap);
    expect(root.name).toBe("urlset");
    const urls = kids(root, "url");
    expect(urls.length).toBe(SITEMAP_ROUTES.length);
    for (const u of urls) expect(kid(u, "lastmod")?.text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("blog/feed.xml", () => {
  const feedText = read("frontend/public/blog/feed.xml");
  const rss = parseXml(feedText);
  const channel = kid(rss, "channel")!;
  const items = kids(channel, "item");

  test("is RSS 2.0 with a self link and the channel's title", () => {
    expect(rss.name).toBe("rss");
    expect(rss.attrs.version).toBe("2.0");
    expect(rss.attrs["xmlns:atom"]).toBe("http://www.w3.org/2005/Atom");
    expect(kid(channel, "title")?.text).toBe("Robot Money research");
    expect(kid(channel, "link")?.text).toBe(ORIGIN + "/blog");
    expect((kid(channel, "description")?.text ?? "").length).toBeGreaterThan(20);
    const self = kid(channel, "atom:link")!;
    expect(self.attrs).toMatchObject({ href: ORIGIN + "/blog/feed.xml", rel: "self", type: "application/rss+xml" });
    expect(feedText).not.toContain(EM_DASH);
  });

  test("carries one item per dated research page, with its date", () => {
    const index = researchIndex();
    expect(items.length).toBe(index.length);
    const byLink = new Map(items.map((it) => [kid(it, "link")?.text, it]));
    for (const { path, meta } of index) {
      const it = byLink.get(ORIGIN + path);
      expect(it, `no feed item for ${path}`).toBeDefined();
      const guid = kid(it!, "guid")!;
      expect(guid.text).toBe(ORIGIN + path);
      expect(guid.attrs.isPermaLink).toBe("true");
      expect((kid(it!, "title")?.text ?? "").length).toBeGreaterThan(0);
      expect((kid(it!, "description")?.text ?? "").length).toBeGreaterThan(0);
      const pubDate = kid(it!, "pubDate")!.text;
      expect(pubDate).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} (\+0000|GMT)$/);
      const d = new Date(pubDate);
      expect(d.toISOString().slice(0, 10), `${path} pubDate`).toBe(meta.published!);
      expect(d.toUTCString().slice(0, 3), `${path} weekday`).toBe(pubDate.slice(0, 3));
    }
  });

  test("lists every blog post in the sitemap", () => {
    const links = new Set(items.map((it) => kid(it, "link")?.text));
    for (const post of SITEMAP_ROUTES.filter((r) => r.startsWith("/blog/"))) {
      expect(links.has(ORIGIN + post), `${post} is not in the feed`).toBe(true);
    }
  });

  test("the shell advertises it", () => {
    expect(headOf(shell)).toContain(`<link rel="alternate" type="application/rss+xml" title="Robot Money research" href="${ORIGIN}/blog/feed.xml" />`);
  });
});

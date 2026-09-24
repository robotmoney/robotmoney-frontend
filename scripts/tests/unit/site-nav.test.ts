// The site nav (RM-124): the served markup in index.html, the sections in
// lib/site-nav.js that router.js syncNav() lights, and the vault list in
// lib/vault-data.js. Three hand-kept lists that must agree, and one promise:
// every link in the nav reaches a page that exists.
//
// Behaviour in the browser (hover, keys, the phone sheet) is
// frontend/test/browser/site-nav.spec.ts.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_SECTIONS, isCurrentLink, navSectionFor } from "../../../frontend/public/assets/js/app/lib/site-nav.js";
import { NOT_FOUND_VIEW, viewFor } from "../../../frontend/public/assets/js/app/routes.js";
import { VAULTS } from "../../../frontend/public/assets/js/app/lib/vault-data.js";

const pub = join(import.meta.dir, "../../../frontend/public");
const html = readFileSync(join(pub, "index.html"), "utf8");
const nav = html.slice(html.indexOf('<nav class="nav'), html.indexOf("</nav>"));

// One entry per group, in bar order: its key and the links inside it.
const groups = nav
  .split('<li class="nav__group')
  .slice(1)
  .map((chunk) => ({
    key: /data-nav-section="([a-z]+)"/.exec(chunk)?.[1] ?? "",
    hrefs: [...chunk.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
    chunk,
  }));

describe("navSectionFor", () => {
  test.each([
    ["/vault/rmagent", "vaults"],
    ["/vault", "vaults"],
    ["/allocation", "vaults"],
    ["/performance", "vaults"],
    ["/smart-contract-risks", "vaults"],
    ["/swarm/subjects/robotmoney-vault", "vaults"],
    ["/swarm", "swarm"],
    ["/swarm/", "swarm"],
    ["/swarm/subjects/robotmoney-allocation", "swarm"],
    ["/swarm/members/athena", "swarm"],
    ["/swarm/apply", "swarm"],
    ["/committee/members/athena", "swarm"],
    ["/regime", "research"],
    ["/regime/indicators", "research"],
    ["/regime-detection", "research"],
    ["/blog/peaq-partnership", "research"],
    ["/research/late-cycle-signals", "research"],
    ["/media/articles", "research"],
    ["/tokenomics", "token"],
    ["/skills", "docs"],
    ["/docs/investment-swarm/api-reference", "docs"],
    ["/changelog", "docs"],
  ])("%s is in %s", (path, key) => {
    expect(navSectionFor(path)).toBe(key);
  });

  test.each(["/", "/disclaimer", "/vaults", "/vaults/abc", "/regimes", "/docsx", "/admin/swarm"])(
    "%s is in no section",
    (path) => {
      expect(navSectionFor(path)).toBeNull();
    },
  );
});

describe("isCurrentLink", () => {
  test("a page address matches its own path, trailing slash or not", () => {
    expect(isCurrentLink("/swarm", "/swarm")).toBe(true);
    expect(isCurrentLink("/swarm", "/swarm/")).toBe(true);
    expect(isCurrentLink("/", "/")).toBe(true);
  });
  test("a link to a section of a page is never current", () => {
    expect(isCurrentLink("/swarm#members", "/swarm")).toBe(false);
  });
  test("a parent page is not current on its children", () => {
    expect(isCurrentLink("/regime", "/regime/indicators")).toBe(false);
  });
});

describe("the nav markup", () => {
  test("its groups are the sections, in the same order", () => {
    expect(groups.map((g) => g.key)).toEqual(NAV_SECTIONS.map((s) => s.key));
  });

  test("every group's links sit in that group's section", () => {
    for (const g of groups) {
      for (const href of g.hrefs) {
        const path = href.split("#")[0];
        if (/\.[a-z]+$/.test(path)) continue; // a file (llms.txt), not a page
        expect(`${href} -> ${navSectionFor(path)}`).toBe(`${href} -> ${g.key}`);
      }
    }
  });

  test("every link reaches a page or file that exists, and every anchor exists on it", () => {
    const hrefs = [...nav.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(20);
    for (const href of hrefs) {
      const [path, hash] = href.split("#");
      if (/\.[a-z]+$/.test(path)) {
        expect(existsSync(join(pub, path)), href).toBe(true);
        continue;
      }
      const view = viewFor(path);
      expect(view, href).not.toBe(NOT_FOUND_VIEW);
      expect(existsSync(join(pub, view)), `${href} -> ${view}`).toBe(true);
      if (hash) expect(readFileSync(join(pub, view), "utf8"), href).toContain(`id="${hash}"`);
    }
  });

  test("the vaults are the four in lib/vault-data.js, by name and token, in order", () => {
    const vaults = groups.find((g) => g.key === "vaults")!.chunk;
    const listed = [...vaults.matchAll(/href="\/vault\/([a-z]+)"><span class="nav__item-t">([^<]+)<\/span>\s*<span class="nav__item-f">([^ <]+)/g)]
      .map((m) => ({ slug: m[1], name: m[2], symbol: m[3] }));
    expect(listed).toEqual(VAULTS.map((v) => ({ slug: v.slug, name: v.name, symbol: v.symbol })));
  });

  test("a vault's name and its fact read apart without styles, for an agent reading the HTML", () => {
    expect(nav).not.toContain('</span><span class="nav__item-f">');
  });

  test("desktop and phone read one list: no second copy of the links", () => {
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("the primary action is the skill", () => {
    expect(nav).toMatch(/<a href="\/skills" class="btn-primary[^"]*nav__cta">Get the skill<\/a>/);
  });
});

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
  .slice(0, nav.indexOf('<div class="nav__ctas">'))
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
    ["/performance", "company"],
    ["/swarm/subjects/robotmoney-vault", "vaults"],
    ["/swarm", "swarm"],
    ["/swarm/", "swarm"],
    ["/swarm/subjects/robotmoney-allocation", "swarm"],
    ["/swarm/subjects/robotmoney-treasury", "company"],
    ["/swarm/members/athena", "swarm"],
    ["/swarm/apply", "swarm"],
    ["/committee/members/athena", "swarm"],
    ["/regime", "research"],
    ["/regime/indicators", "research"],
    ["/regime-detection", "research"],
    ["/blog/peaq-partnership", "research"],
    ["/research/late-cycle-signals", "research"],
    ["/smart-contract-risks", "research"],
    ["/media/articles", "company"],
    ["/tokenomics", "company"],
    ["/skills", "docs"],
    ["/deposit", "vaults"],
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
        if (!path.startsWith("/")) continue; // off the site (Telegram, X)
        if (href.includes("#") && navSectionFor(path) !== g.key) continue; // a section of another group's page (Contracts)
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

  test("the Robot Money Vault leads, and the four vaults in lib/vault-data.js hang from it", () => {
    const vaults = groups.find((g) => g.key === "vaults")!.chunk;
    const tree = vaults.slice(vaults.indexOf('href="/swarm/subjects/robotmoney-vault"'));
    expect(tree.indexOf('<ul class="nav__tree">')).toBeGreaterThan(0);
    const inTree = tree.slice(tree.indexOf('<ul class="nav__tree">'), tree.indexOf("</ul>"));
    expect([...inTree.matchAll(/href="\/vault\/([a-z]+)"/g)].map((m) => m[1])).toEqual(VAULTS.map((v) => v.slug));
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

  test("the footer lists every page the nav reaches, and nothing that goes nowhere", () => {
    const footer = html.slice(html.indexOf('<footer class="footer">'), html.indexOf("</footer>"));
    const navHrefs = [...nav.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]).filter((h) => h !== "/");
    for (const href of navHrefs) expect(footer, href).toContain(`href="${href}"`);
    expect(footer).not.toContain('href="#"');
    for (const href of [...footer.matchAll(/href="(\/[^"#]*)[^"]*"/g)].map((m) => m[1])) {
      if (/\.[a-z]+$/.test(href)) expect(existsSync(join(pub, href)), href).toBe(true);
      else expect(existsSync(join(pub, viewFor(href))), `${href} -> ${viewFor(href)}`).toBe(true);
    }
  });

  test("a vault's value has a slot on the Robot Money Vault and on each vault", () => {
    const vaults = groups.find((g) => g.key === "vaults")!.chunk;
    const slots = [...vaults.matchAll(/x-text="vaultFigure\('([a-z]+)'\)"/g)].map((m) => m[1]);
    expect(slots).toEqual(["total", ...VAULTS.map((v) => v.slug)]);
  });

  test("desktop and phone read one list: no second copy of the links", () => {
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("the primary action is to deposit, on its own page", () => {
    expect(nav).toMatch(/<a href="\/deposit" class="btn-primary[^"]*nav__cta">Deposit<\/a>/);
  });

  test("what is not built yet is named, marked, and not a link", () => {
    for (const where of [nav, html.slice(html.indexOf('<footer class="footer">'))]) {
      expect(where).not.toContain("/swarm/leaderboard");
      expect(where).toMatch(/<span class="[^"]*--soon" aria-disabled="true">(<span class="nav__item-t">)?Leaderboard(<\/span>)? <span class="rm-soon">Coming soon<\/span><\/span>/);
    }
  });

  test("llms.txt is for machines: in the footer, not in the menu", () => {
    expect(nav).not.toContain('href="/llms.txt"');
    expect(html.slice(html.indexOf('<footer class="footer">'))).toContain('href="/llms.txt"');
  });

  test("a link off the site opens in a new tab and says so", () => {
    for (const [, attrs] of nav.matchAll(/<a ([^>]*href="https?:[^"]+"[^>]*)>/g)) {
      expect(attrs).toContain('target="_blank"');
      expect(attrs).toContain('rel="noopener noreferrer"');
      expect(attrs).toContain("nav__item--out");
    }
  });
});

// RM-129: depositing has its own page, and /skills is the index of every
// skill. The deposit page keeps the section ids the old /skills page had, so
// the links that pointed into it still land.
describe("the deposit page and the skills index", () => {
  const deposit = readFileSync(join(pub, "views/deposit.html"), "utf8");
  const skills = readFileSync(join(pub, "views/skills.html"), "utf8");

  test("/deposit keeps every section the deposit skill's page had", () => {
    for (const id of ["how-it-works", "capabilities", "mechanics", "contracts", "about"]) {
      expect(deposit, id).toContain(`id="${id}"`);
    }
    expect(deposit).toContain("npx skills add robotmoney/robotmoney-skills --skill robotmoney-cli");
  });

  test("/skills lists each skill with its way in", () => {
    expect(skills).toContain('id="deposit-skill"');
    expect(skills).toContain('href="/deposit"');
    expect(skills).toContain('id="swarm-onboarding"');
    expect(skills).toContain('href="/swarm/apply"');
    expect(existsSync(join(pub, "skills/swarm-onboarding/SKILL.md"))).toBe(true);
  });

  test("nothing on the site still sends a reader to /skills for a deposit section", () => {
    const pages = [html, ...["home", "tokenomics", "vault", "deposit", "skills"].map((v) => readFileSync(join(pub, `views/${v}.html`), "utf8"))];
    for (const page of pages) expect(page).not.toMatch(/href="\/skills#/);
  });
});

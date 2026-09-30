// One arrow per link (RM-150). components.css gives every text link that
// opens a new tab a generated ↗, so a label that also types an arrow reads
// "→ ↗". The generated arrow is the one the site keeps: a new-tab text link's
// label types none. Buttons, cards, icon links, the nav's items and the
// dashboards are outside the generated arrow (the selector's own :not()s) and
// keep one typed arrow of their own.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const pub = join(import.meta.dir, "../../../frontend/public");
const css = readFileSync(join(pub, "assets/css/components.css"), "utf8");

// An arrow however a template spells it.
const ARROW = /→|↗|➝|&rarr;|&#8594;|&#x2192;|&#8599;|&#x2197;|&nearr;/i;

// Whether the generated arrow applies, as the selector decides it: not a
// button (a class containing "btn"), not .rr-cta or .nav__item, and not a
// link that holds an image, an icon, a card's block or a paragraph.
/** @param {string} attrs @param {string} body */
const generated = (attrs: string, body: string) => {
  const cls = (/\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/);
  if (cls.some((c) => c.includes("btn")) || cls.includes("rr-cta") || cls.includes("nav__item")) return false;
  return !/<(img|svg|picture|div|p)\b/i.test(body);
};

describe("a link that opens a new tab carries one arrow", () => {
  test("the site still generates the arrow this test assumes", () => {
    expect(css).toContain('a[target="_blank"]:not(:has(img, svg, picture, div, p)):not([class*="btn"]):not(.rr-cta):not(.nav__item):not([data-dash-shell] *)::after');
    expect(css).toContain('content: "\\2197"');
  });

  test("no new-tab text link types an arrow of its own", () => {
    const pages = [join(pub, "index.html"), ...[...new Glob("views/**/*.html").scanSync(pub)].map((f) => join(pub, f))]
      // The dashboards keep their own link style (the selector's [data-dash-shell]).
      .filter((f) => !relative(pub, f).startsWith("views/dash/"));
    const doubles: string[] = [];
    for (const file of pages) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
        const [, attrs, body] = m;
        if (!/\btarget="_blank"/.test(attrs) || !generated(attrs, body)) continue;
        const label = `${body} ${/\bx-text="([^"]*)"/.exec(attrs)?.[1] ?? ""}`;
        if (ARROW.test(label)) {
          const line = src.slice(0, m.index).split("\n").length;
          doubles.push(`${relative(pub, file)}:${line} ${body.replace(/\s+/g, " ").trim().slice(0, 60)}`);
        }
      }
    }
    expect(doubles).toEqual([]);
  });
});

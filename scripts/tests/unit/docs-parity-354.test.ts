// Issue #354 compliance-FAIL regression guards.
//
// PR #328 shipped four fixes (skill.md, /articles/treasury-allocation, dead
// API hosts, runbook linking) whose acceptance criteria were checked off on
// the strength of a prior worker's manual browser-rendering pass alone — no
// executed test backed any of them, and one of the four claims (the dead
// hosts) turned out to be false (see api-reference-no-dead-hosts.test.ts).
// This file covers the remaining three ACs that had zero executed coverage:
// the runbook being linked from /docs, the runbook URL being present in
// sitemap.xml, sitemap.xml itself being well-formed XML, and the
// /articles/treasury-allocation client route resolving to real content.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { viewFor } from "../../../frontend/public/assets/js/app/routes.js";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const DOCS_HTML = "frontend/public/views/docs.html";
const SITEMAP = "frontend/public/sitemap.xml";
const RUNBOOK_PATH = "/docs/investment-swarm/runbook";
const RUNBOOK_URL = `https://robotmoney.network${RUNBOOK_PATH}`;

describe("AC4: the runbook is linked from /docs and present in sitemap.xml", () => {
  const docsHtml = read(DOCS_HTML);

  test("docs.html's sidebar links the runbook", () => {
    // The sidebar list (top of the page, next to "How it works"/"Participation")
    // and the body list (the Investment Swarm section prose) both carry an
    // <a href="/docs/investment-swarm/runbook">Runbook</a> link — assert on
    // count so a future edit that drops either one is caught, not just "at
    // least one somewhere in the file".
    const hrefMatches = docsHtml.match(
      new RegExp(`<a[^>]*href="${RUNBOOK_PATH}"[^>]*>`, "g"),
    );
    expect(hrefMatches).not.toBeNull();
    expect((hrefMatches ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("sitemap.xml contains the runbook URL", () => {
    const sitemap = read(SITEMAP);
    expect(sitemap).toContain(`<loc>${RUNBOOK_URL}</loc>`);
  });
});

// xmllint is not guaranteed to be present in every CI image this repo's
// workflows run on (unit.yml provisions only bun + node), so this is a
// dependency-free well-formedness check rather than a shell-out to xmllint:
// every opening tag must have a matching closing tag in the correct order,
// self-closing/void tags are tolerated, and the declaration + root element
// must be present. This is deliberately narrower than a full XML validator,
// but it catches the class of error a hand-edited sitemap actually produces
// (an unclosed <url>, a typo'd closing tag, mismatched nesting).
function assertWellFormedXml(xml: string): void {
  expect(xml.trim().startsWith("<?xml")).toBe(true);

  const tagRe = /<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>|<\/([a-zA-Z][\w:-]*)\s*>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  let sawElement = false;

  while ((match = tagRe.exec(xml)) !== null) {
    const [, openName, , selfClosed, closeName] = match;
    if (openName) {
      sawElement = true;
      if (!selfClosed) stack.push(openName);
    } else if (closeName) {
      const expected = stack.pop();
      if (expected !== closeName) {
        throw new Error(
          `sitemap.xml is not well-formed: expected closing </${expected}> but found </${closeName}>`,
        );
      }
    }
  }

  expect(sawElement).toBe(true);
  expect(stack, `sitemap.xml is not well-formed: unclosed tag(s): ${stack.join(", ")}`).toEqual([]);
}

describe("sitemap.xml is well-formed XML", () => {
  test("every element opens and closes in matching order, with a declaration and at least one element", () => {
    assertWellFormedXml(read(SITEMAP));
  });

  test("the well-formedness check actually detects malformed XML (canary against a vacuous pass)", () => {
    expect(() => assertWellFormedXml("<?xml version=\"1.0\"?><urlset><url></urlset>")).toThrow();
    expect(() => assertWellFormedXml("<?xml version=\"1.0\"?><urlset><url></url>")).toThrow();
  });
});

describe("AC2: /articles/treasury-allocation resolves to the treasury-allocation article", () => {
  test("viewFor maps the legacy article path to the treasury-allocation blog fragment", () => {
    expect(viewFor("/articles/treasury-allocation")).toBe("/views/blog/treasury-allocation.html");
  });

  test("the resolved fragment exists on disk and is the real treasury-allocation article, not a stub", async () => {
    const file = Bun.file(join(repoRoot, "frontend/public", viewFor("/articles/treasury-allocation")));
    expect(await file.exists()).toBe(true);
    const html = await file.text();
    expect(html).toContain("Treasury Allocation for");
    expect(html).toContain("On-Chain Businesses");
  });
});

// Duplicate-selector CSS lint (review-maintainability finding 023, issue #129).
//
// views.css has twice accumulated multiple rule blocks for the SAME selector in
// the SAME media context with conflicting declarations — the later block
// silently wins per-property, so editing the earlier block is a no-op and any
// merge that drops/reorders one block changes layout with no nearby diff noise
// (the #80 regression pattern, recurred as finding 023: .cv__context-grid /
// .cv__discussion / .cv__portfolio-grid styled by two base blocks and two
// @media(min-width:768px) blocks with conflicting grid-template-columns).
//
// This lint parses every CSS file under frontend/public/assets/css/ (top-level
// rules + rules nested in @media/@supports/@container/@layer) and fails when:
//   (a) the exact same normalized selector LIST heads two rule blocks in the
//       same media context (a verbatim duplicate block), or
//   (b) the same INDIVIDUAL selector appears in two rule blocks in the same
//       media context AND those blocks declare at least one common property
//       name — i.e. one block silently overrides the other (the hazard).
// A selector appearing in two blocks with fully DISJOINT property sets is the
// benign "shared base list + per-variant additions" pattern (e.g.
// `.a, .b { gap: 1rem }` + `.b { color: red }`) and is allowed.
//
// Known limitation (documented, accepted): property overlap is matched by
// exact property NAME, so a shorthand/longhand pair (`padding` vs
// `padding-top`) across two blocks is not flagged. No dependencies — the
// parser below is a small brace-tracking state machine, self-tested against
// inline fixtures (including one that MUST fail) before it judges real files.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const cssRoot = join(repoRoot, "frontend/public/assets/css");

interface CssRule {
  /** Normalized full selector list, e.g. ".a, .b" */
  selectorList: string;
  /** Individual normalized selectors split from the list. */
  selectors: string[];
  /** Enclosing at-rule contexts joined ("" for top level), e.g. "@media (min-width: 768px)" */
  media: string;
  /** Declared property names (lowercased). */
  props: Set<string>;
  /** 1-based line of the rule's opening brace (for error messages). */
  line: number;
}

interface Finding {
  kind: "duplicate-list" | "conflicting-selector";
  selector: string;
  media: string;
  lines: number[];
  sharedProps: string[];
  message: string;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Replace comments with spaces (preserving newlines so line numbers hold). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Parse a CSS source into flat rules, tracking @media/@supports nesting. */
export function parseCssRules(css: string): CssRule[] {
  const src = stripComments(css);
  const rules: CssRule[] = [];
  const contextStack: string[] = [];
  let i = 0;
  let head = "";
  let line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") line++;
    if (ch === "{") {
      const selector = norm(head);
      head = "";
      if (/^@(media|supports|container|layer)\b/.test(selector)) {
        contextStack.push(selector);
        i++;
        continue;
      }
      if (selector.startsWith("@")) {
        // @keyframes/@font-face/@page etc: skip the whole (possibly nested) block.
        let depth = 1;
        i++;
        while (i < src.length && depth > 0) {
          if (src[i] === "\n") line++;
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
        continue;
      }
      // Plain rule: collect the declaration body up to the matching close brace.
      const ruleLine = line;
      let body = "";
      i++;
      while (i < src.length && src[i] !== "}") {
        if (src[i] === "\n") line++;
        body += src[i];
        i++;
      }
      i++; // consume "}"
      const props = new Set<string>();
      for (const decl of body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon > 0) props.add(decl.slice(0, colon).trim().toLowerCase());
      }
      const selectors = selector.split(",").map(norm).filter(Boolean);
      rules.push({
        selectorList: selectors.join(", "),
        selectors,
        media: contextStack.join(" "),
        props,
        line: ruleLine,
      });
      continue;
    }
    if (ch === "}") {
      // Close of an enclosing at-rule wrapper.
      contextStack.pop();
      head = "";
      i++;
      continue;
    }
    head += ch;
    i++;
  }
  return rules;
}

/** Lint one CSS source; returns [] when clean. */
export function lintCssDuplicates(css: string): Finding[] {
  const rules = parseCssRules(css);
  const findings: Finding[] = [];

  // (a) Identical normalized selector list in the same media context.
  const byList = new Map<string, CssRule[]>();
  for (const r of rules) {
    const key = `${r.media}||${r.selectorList}`;
    const entry = byList.get(key);
    if (entry) entry.push(r);
    else byList.set(key, [r]);
  }
  for (const rs of byList.values()) {
    if (rs.length < 2) continue;
    const { selectorList, media } = rs[0];
    findings.push({
      kind: "duplicate-list",
      selector: selectorList,
      media,
      lines: rs.map((r) => r.line),
      sharedProps: [],
      message: `selector list "${selectorList}"${media ? ` in ${media}` : ""} heads ${rs.length} rule blocks (lines ${rs.map((r) => r.line).join(", ")}) — merge them into one`,
    });
  }

  // (b) Same individual selector in >1 block (same media) with overlapping props.
  const bySelector = new Map<string, { media: string; sel: string; rs: CssRule[] }>();
  for (const r of rules) {
    for (const sel of r.selectors) {
      const key = `${r.media}||${sel}`;
      const entry = bySelector.get(key);
      if (entry) entry.rs.push(r);
      else bySelector.set(key, { media: r.media, sel, rs: [r] });
    }
  }
  for (const { media, sel, rs } of bySelector.values()) {
    if (rs.length < 2) continue;
    const shared = new Set<string>();
    for (let a = 0; a < rs.length; a++) {
      for (let b = a + 1; b < rs.length; b++) {
        for (const p of rs[a].props) if (rs[b].props.has(p)) shared.add(p);
      }
    }
    if (!shared.size) continue; // disjoint props: benign base-list + variant pattern
    findings.push({
      kind: "conflicting-selector",
      selector: sel,
      media,
      lines: rs.map((r) => r.line),
      sharedProps: [...shared].sort(),
      message: `selector "${sel}"${media ? ` in ${media}` : ""} is styled by ${rs.length} rule blocks (lines ${rs.map((r) => r.line).join(", ")}) that both declare [${[...shared].sort().join(", ")}] — the later block silently overrides the earlier one; consolidate to a single block with the winning values`,
    });
  }

  return findings;
}

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...cssFilesUnder(p));
    else if (entry.endsWith(".css")) out.push(p);
  }
  return out.sort();
}

describe("css duplicate-selector lint: self-tests (fixtures)", () => {
  // AC: the lint is self-tested with a fixture that MUST fail — proves the
  // parser+rule actually detect the hazard before we trust its green on real files.
  test("reports a duplicate base-level block with conflicting values", () => {
    const fixture = `
      .grid, .other { display: grid; grid-template-columns: 1fr; gap: 1rem; }
      .noise { color: red; }
      .grid { display: grid; gap: 1.25rem; }
    `;
    const findings = lintCssDuplicates(fixture);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("conflicting-selector");
    expect(findings[0].selector).toBe(".grid");
    expect(findings[0].sharedProps).toEqual(["display", "gap"]);
    expect(findings[0].lines.length).toBe(2);
  });

  test("reports the finding-023 shape: duplicate @media blocks overriding grid-template-columns", () => {
    const fixture = `
      @media (min-width: 768px) {
        .a, .portfolio { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (min-width: 768px) {
        .portfolio { grid-template-columns: 0.75fr 1.25fr; }
      }
    `;
    const findings = lintCssDuplicates(fixture);
    expect(findings.length).toBe(1);
    expect(findings[0].selector).toBe(".portfolio");
    expect(findings[0].media).toBe("@media (min-width: 768px)");
    expect(findings[0].sharedProps).toEqual(["grid-template-columns"]);
  });

  test("reports a verbatim repeated selector list even without shared props", () => {
    const fixture = `
      .a, .b { color: red; }
      .a, .b { background: blue; }
    `;
    const findings = lintCssDuplicates(fixture);
    expect(findings.some((f) => f.kind === "duplicate-list" && f.selector === ".a, .b")).toBe(true);
  });

  test("passes a clean fixture", () => {
    const fixture = `
      /* comment with { braces } inside */
      .a, .b { display: grid; gap: 1rem; }
      .b { color: red; } /* disjoint props: allowed variant pattern */
      @media (min-width: 768px) { .a { gap: 2rem; } }
      @keyframes spin { 0% { rotate: 0deg; } 100% { rotate: 360deg; } }
    `;
    expect(lintCssDuplicates(fixture)).toEqual([]);
  });

  test("same selector in DIFFERENT media contexts is not a duplicate", () => {
    const fixture = `
      .a { grid-template-columns: 1fr; }
      @media (min-width: 768px) { .a { grid-template-columns: repeat(2, 1fr); } }
    `;
    expect(lintCssDuplicates(fixture)).toEqual([]);
  });
});

describe("css duplicate-selector lint: real stylesheets", () => {
  const files = cssFilesUnder(cssRoot);

  test("finds the app stylesheets", () => {
    // Guard against a silent pass on an empty/moved directory.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith("views.css"))).toBe(true);
  });

  for (const file of files) {
    const rel = relative(repoRoot, file);
    test(`${rel} has no duplicate same-selector blocks`, () => {
      const findings = lintCssDuplicates(readFileSync(file, "utf8"));
      const report = findings.map((f) => `  - ${f.message}`).join("\n");
      expect(findings, `${rel}:\n${report}`).toEqual([]);
    });
  }
});

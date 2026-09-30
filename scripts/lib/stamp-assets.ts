// Cache busting for the application JavaScript (docs/technical/static-asset-cache.md, decision C3).
//
// The scripts are ES modules: main.js imports about 30 files by relative path, and those import more. A cache (the
// browser's, or Cloudflare's, which keeps `.js` for hours) serves each file by URL, so if only the entry point's URL
// changed, every file behind it would still come from the old cache and run against the new page. So EVERY import in
// the assembled site gets the same `?v=<stamp>` appended, which gives each module exactly one URL and makes every
// module URL new whenever any script changed.
//
// The stamp is the first 8 hex characters of a sha256 over the application JavaScript tree, so it changes if and only
// if some application script does: a release that touches no script keeps its URLs and its cached copies.
//
// Applied to the ASSEMBLED site only (scripts/static-assembly.sh), never to frontend/public, which the preview server
// and the browser tests serve unstamped.
//
// HOW IMPORTS ARE FOUND. Bun's own transpiler reports a file's imports (static, re-exports, side-effect and literal
// dynamic), and it ignores comments and strings. The rewrite is a textual insertion at each specifier, and it is
// checked against that report: the number of specifiers rewritten must equal the number the transpiler found, and
// taking the stamp back out must give the original bytes exactly. A mismatch fails the assembly; it never guesses.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";

/** Where the application scripts live in the assembled site. Vendor scripts (assets/js/vendor) are versioned by name. */
export const APP_JS_DIR = "assets/js/app";

export interface SourceFile {
  /** Path relative to the site root, with forward slashes. */
  rel: string;
  text: string;
}

const STAMP_PARAM = "v";

/**
 * The three places a relative specifier appears, for relative specifiers only.
 *
 * Static imports and re-exports are anchored to the START OF A STATEMENT (`^\s*import` / `^\s*export`). That is what
 * keeps a comment that quotes an import, such as alpine/views.js's "// main.js's boot import (`import { x } from
 * "./alpine/views.js"`)", from being rewritten: a comment line starts with `//`, never with `import`. A statement
 * that is not at the start of a line is not matched, and the count check in stampSource then fails the assembly
 * instead of leaving one import unstamped.
 */
const STATIC_FROM = /^(\s*(?:import|export)\b[^;"'`]*?\bfrom\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/gm;
const SIDE_EFFECT = /^(\s*import\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/gm;
const DYNAMIC = /(\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

/** The stamp for a tree: sha256 over the sorted paths and contents of its files. */
export function jsTreeStamp(files: SourceFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(f.rel);
    h.update("\0");
    h.update(f.text);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

const transpiler = new Bun.Transpiler({ loader: "js" });

/** The relative module specifiers the transpiler reports for a file. */
export function relativeImports(text: string): { path: string; kind: string }[] {
  return transpiler.scanImports(text).filter((r) => r.path.startsWith("./") || r.path.startsWith("../"));
}

/** `import(x)` where x is not a string literal: its URL cannot be known here, so it could never be stamped. */
export function nonLiteralDynamicImports(text: string): number {
  // Transpiling drops comments, so a mention of `import(` in a comment is not counted.
  const code = transpiler.transformSync(text);
  let n = 0;
  for (const m of code.matchAll(/\bimport\s*\(\s*([^)\s][^)]*)\)/g)) if (!/^["'`]/.test(m[1]!.trim())) n++;
  return n;
}

export interface StampResult {
  text: string;
  /** Specifiers rewritten. */
  count: number;
}

/** Appends `?v=<stamp>` to every relative module specifier in one file. Throws on anything it cannot do safely. */
export function stampSource(rel: string, text: string, stamp: string): StampResult {
  const reported = relativeImports(text);
  if (reported.some((r) => r.path.includes("?"))) throw new Error(`${rel}: already has a query on a module specifier; the tree is already stamped`);
  const dynamic = nonLiteralDynamicImports(text);
  if (dynamic > 0) throw new Error(`${rel}: ${dynamic} import() call(s) with a non-literal argument cannot be stamped`);

  let count = 0;
  const add = (_all: string, head: string, quote: string, spec: string) => {
    count++;
    return `${head}${quote}${spec}?${STAMP_PARAM}=${stamp}${quote}`;
  };
  // A dynamic import() is matched anywhere on a line, so a JSDoc type reference such as
  // `@typedef {{ overview: import("./vault-data.js").Overview }}` (documentation, not code) must be skipped: it is on a
  // comment line, or after a `//`.
  const addDynamic = (all: string, head: string, quote: string, spec: string, offset: number, whole: string) => {
    const lineStart = whole.lastIndexOf("\n", offset) + 1;
    const before = whole.slice(lineStart, offset);
    if (/^\s*(\*|\/\/|\/\*)/.test(before) || before.includes("//")) return all;
    return add(all, head, quote, spec);
  };
  const out = text.replace(STATIC_FROM, add).replace(SIDE_EFFECT, add).replace(DYNAMIC, addDynamic);
  if (count !== reported.length) {
    throw new Error(`${rel}: rewrote ${count} specifier(s) but the transpiler reports ${reported.length} relative import(s); refusing to guess which is right`);
  }
  // Nothing but the stamps may have changed.
  if (out.split(`?${STAMP_PARAM}=${stamp}`).join("") !== text) throw new Error(`${rel}: the rewrite changed more than the stamps`);
  return { text: out, count };
}

/** Stamps the module entry point in a page shell: `<script type="module" src="/assets/js/app/main.js">`. */
export function stampEntryHtml(html: string, stamp: string): { html: string; count: number } {
  let count = 0;
  const out = html.replace(/(<script\b[^>]*\btype="module"[^>]*\bsrc=")(\/assets\/js\/app\/[^"?]+\.js)(")/g, (_a, head: string, src: string, tail: string) => {
    count++;
    return `${head}${src}?${STAMP_PARAM}=${stamp}${tail}`;
  });
  return { html: out, count };
}

/**
 * Problems with an assembled site's scripts; empty means every import is stamped and resolves. This is what catches
 * the failure the stamp exists to prevent: one import left alone makes a module load under two URLs, so two
 * instances, and shared state in the module splits in two.
 */
export function verifyStampedTree(files: SourceFile[], indexHtml: string, stamp: string): string[] {
  const problems: string[] = [];
  const known = new Set(files.map((f) => f.rel));
  const suffix = `?${STAMP_PARAM}=${stamp}`;

  for (const f of files) {
    for (const r of relativeImports(f.text)) {
      if (!r.path.endsWith(suffix)) {
        problems.push(`${f.rel}: imports ${r.path} without the stamp ${suffix}`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(f.rel), r.path.slice(0, -suffix.length)));
      if (!known.has(target)) problems.push(`${f.rel}: imports ${r.path}, which resolves to ${target}, not a file in the tree`);
    }
    const dynamic = nonLiteralDynamicImports(f.text);
    if (dynamic > 0) problems.push(`${f.rel}: ${dynamic} import() call(s) with a non-literal argument`);
  }

  const entries = [...indexHtml.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/js\/app\/[^"]+)"/g)].map((m) => m[1]!);
  if (entries.length === 0) problems.push("index.html has no module entry point under /assets/js/app");
  for (const e of entries) {
    if (!e.endsWith(suffix)) problems.push(`index.html: the module entry ${e} is not stamped ${suffix}`);
    else if (!known.has(e.slice(1, -suffix.length))) problems.push(`index.html: the module entry ${e} is not a file in the tree`);
  }
  return problems;
}

// ── the assembled directory ──────────────────────────────────────────────────

function readTree(siteDir: string): SourceFile[] {
  const root = join(siteDir, APP_JS_DIR);
  if (!existsSync(root)) throw new Error(`${root} does not exist: nothing to stamp`);
  const out: SourceFile[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".js")) out.push({ rel: relative(siteDir, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  visit(root);
  return out;
}

export interface StampSummary {
  stamp: string;
  files: number;
  specifiers: number;
}

/**
 * Stamps an assembled site in place and verifies what it wrote, reading it back from disk. Throws if the tree is
 * already stamped, if an import cannot be stamped, or if verification finds a problem.
 */
export function stampSite(siteDir: string): StampSummary {
  const files = readTree(siteDir);
  const indexPath = join(siteDir, "index.html");
  const stamp = jsTreeStamp(files);

  // All-or-nothing: compute every rewrite first, write only if every file could be stamped. A failure half way must not
  // leave a half-stamped directory behind.
  let specifiers = 0;
  const rewritten: SourceFile[] = [];
  for (const f of files) {
    const r = stampSource(f.rel, f.text, stamp);
    specifiers += r.count;
    rewritten.push({ rel: f.rel, text: r.text });
  }
  const entry = stampEntryHtml(readFileSync(indexPath, "utf8"), stamp);
  if (entry.count === 0) throw new Error(`${indexPath}: no <script type="module" src="/assets/js/app/…"> entry point to stamp`);
  const problemsBeforeWriting = verifyStampedTree(rewritten, entry.html, stamp);
  if (problemsBeforeWriting.length > 0) throw new Error(`the stamped site would not be consistent:\n  - ${problemsBeforeWriting.slice(0, 20).join("\n  - ")}`);
  for (let i = 0; i < files.length; i++) if (rewritten[i]!.text !== files[i]!.text) writeFileSync(join(siteDir, files[i]!.rel), rewritten[i]!.text);
  writeFileSync(indexPath, entry.html);

  const problems = verifyStampedTree(readTree(siteDir), readFileSync(indexPath, "utf8"), stamp);
  if (problems.length > 0) throw new Error(`the stamped site is not consistent:\n  - ${problems.slice(0, 20).join("\n  - ")}`);
  return { stamp, files: files.length, specifiers };
}

/** Verifies an already stamped site without changing it. */
export function verifySite(siteDir: string): { stamp: string | null; problems: string[] } {
  const files = readTree(siteDir);
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  const m = html.match(/\/assets\/js\/app\/[^"]+\?v=([0-9a-f]{8})"/);
  if (!m) return { stamp: null, problems: ["index.html carries no stamped module entry point"] };
  return { stamp: m[1]!, problems: verifyStampedTree(files, html, m[1]!) };
}


// Self-contained guard for the baked frozen bundle (issue #24).
//
//   bun run scripts/check-frozen-selfcontained.ts [path/to/index.html]
//
// The frozen bundle's whole point is that a non-technical user can double-click
// it (file://) and browse every view OFFLINE. That guarantee is broken the
// moment the HTML asks the browser to auto-load a resource over the network. So
// this guard fails LOUDLY if the bundle:
//   - is absent or empty, or
//   - contains any resource-loading reference to an external http(s):// (or
//     protocol-relative //) URL — <script src>, <link href>, <img/source/
//     iframe/video/audio/track/embed src>, srcset, <object data>, <use href>,
//     or CSS url()/@import.
//
// It deliberately does NOT flag <a href="https://…"> anchors: those are
// user-initiated navigation links, not resources the page auto-fetches, so they
// do not break offline rendering.
//
// Exit 0 with a real, non-zero inspection count on a clean bundle; exit 1 with a
// per-violation report otherwise. This runs in CI (feature-correctness) after
// `bun run frozen:fixtures` — never a no-op, never a silent skip.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Violation {
  kind: string;
  url: string;
  snippet: string;
}

export interface SelfContainedResult {
  inspected: number; // resource-loading references examined (assertion count)
  violations: Violation[];
}

// Each rule matches a resource-loading construct whose URL, if external, makes
// the page hit the network. The capture group (1) is the offending URL.
const EXTERNAL = String.raw`["']?((?:https?:)?\/\/[^"'\s)>]+)`;

// HTML-tag rules run over the whole document (tag-anchored, so they cannot
// collide with inlined JavaScript).
const HTML_RULES: { kind: string; re: RegExp }[] = [
  { kind: "script[src]", re: new RegExp(String.raw`<script\b[^>]*?\bsrc\s*=\s*${EXTERNAL}`, "gi") },
  { kind: "link[href]", re: new RegExp(String.raw`<link\b[^>]*?\bhref\s*=\s*${EXTERNAL}`, "gi") },
  {
    kind: "media[src]",
    re: new RegExp(
      String.raw`<(?:img|source|iframe|video|audio|track|embed|input)\b[^>]*?\bsrc\s*=\s*${EXTERNAL}`,
      "gi",
    ),
  },
  { kind: "srcset", re: new RegExp(String.raw`\bsrcset\s*=\s*["'][^"']*?((?:https?:)?\/\/[^"'\s]+)`, "gi") },
  { kind: "object[data]", re: new RegExp(String.raw`<object\b[^>]*?\bdata\s*=\s*${EXTERNAL}`, "gi") },
  {
    kind: "use[href]",
    re: new RegExp(String.raw`<use\b[^>]*?\b(?:xlink:href|href)\s*=\s*${EXTERNAL}`, "gi"),
  },
];

// CSS rules run ONLY over extracted stylesheet text (<style> blocks + style=
// attributes) so a `new URL("https://…")` call in the inlined app JS is never
// misread as a CSS `url()` external fetch.
const CSS_RULES: { kind: string; re: RegExp }[] = [
  { kind: "css@import", re: new RegExp(String.raw`@import\s+(?:url\(\s*)?${EXTERNAL}`, "gi") },
  { kind: "css-url()", re: new RegExp(String.raw`\burl\(\s*${EXTERNAL}`, "gi") },
];

/** Concatenate every CSS region of the document (<style> bodies + style attrs). */
export function extractCss(html: string): string {
  const parts: string[] = [];
  const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleBlock.exec(html)) !== null) parts.push(m[1]);
  const styleAttr = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/gi;
  while ((m = styleAttr.exec(html)) !== null) parts.push(m[1] ?? m[2] ?? "");
  return parts.join("\n");
}

// Count of resource-loading tags/constructs present at all (external or not), so
// the guard can prove it actually inspected the document rather than trivially
// passing an empty or malformed file.
const INSPECTED_RE = new RegExp(
  String.raw`<(?:script|link|img|source|iframe|video|audio|track|embed|object|use)\b|\burl\(|@import`,
  "gi",
);

export function scanSelfContained(html: string): SelfContainedResult {
  const inspected = html.match(INSPECTED_RE)?.length ?? 0;
  const violations: Violation[] = [];
  const collect = (rules: typeof HTML_RULES, text: string): void => {
    for (const { kind, re } of rules) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        violations.push({ kind, url: m[1], snippet: m[0].slice(0, 120) });
      }
    }
  };
  collect(HTML_RULES, html);
  collect(CSS_RULES, extractCss(html));
  return { inspected, violations };
}

// A standalone .css file is scanned as raw stylesheet text (no <style> extraction).
const CSS_INSPECTED_RE = /\burl\(|@import/gi;

export function scanCssText(css: string): SelfContainedResult {
  const inspected = css.match(CSS_INSPECTED_RE)?.length ?? 0;
  const violations: Violation[] = [];
  for (const { kind, re } of CSS_RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) violations.push({ kind, url: m[1], snippet: m[0].slice(0, 120) });
  }
  return { inspected, violations };
}

export interface DirViolation extends Violation {
  file: string;
}
export interface DirResult {
  inspected: number;
  filesScanned: number;
  violations: DirViolation[];
}

/** Scan every .html and .css file under a frozen dist directory for external refs. */
export function scanFrozenDir(dir: string): DirResult {
  const out: DirResult = { inspected: 0, filesScanned: 0, violations: [] };
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]) {
    const isHtml = rel.endsWith(".html");
    const isCss = rel.endsWith(".css");
    if (!isHtml && !isCss) continue;
    const abs = join(dir, rel);
    if (!statSync(abs).isFile()) continue;
    const text = readFileSync(abs, "utf8");
    const r = isHtml ? scanSelfContained(text) : scanCssText(text);
    out.inspected += r.inspected;
    out.filesScanned += 1;
    for (const v of r.violations) out.violations.push({ ...v, file: rel });
  }
  return out;
}

function fail(msg: string): never {
  console.error(`[selfcontained] FAIL: ${msg}`);
  process.exit(1);
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..");
  const target = process.argv[2] ?? join(repoRoot, "dist", "frozen");

  if (!existsSync(target)) {
    fail(`frozen dist not found at ${target} — run \`bun run frozen:fixtures\` first`);
  }

  // A directory scans the whole dist (html + css); a single file keeps back-compat.
  let inspected: number;
  let filesScanned = 1;
  let violations: DirViolation[];
  if (statSync(target).isDirectory()) {
    if (!existsSync(join(target, "index.html"))) fail(`${target} has no index.html — is this the frozen dist?`);
    const r = scanFrozenDir(target);
    inspected = r.inspected;
    filesScanned = r.filesScanned;
    violations = r.violations;
  } else {
    if (statSync(target).size === 0) fail(`${target} is empty (0 bytes)`);
    const html = readFileSync(target, "utf8");
    if (html.trim().length === 0) fail(`${target} contains only whitespace`);
    const r = scanSelfContained(html);
    inspected = r.inspected;
    violations = r.violations.map((v) => ({ ...v, file: target }));
  }

  if (inspected === 0) fail(`${target} has no resource-loading constructs — is this the frozen dist?`);

  if (violations.length > 0) {
    console.error(`[selfcontained] FAIL: ${violations.length} external resource reference(s) under ${target}:`);
    for (const v of violations) console.error(`  - [${v.kind}] ${v.file}: ${v.url}\n      ${v.snippet}`);
    process.exit(1);
  }

  console.log(
    `[selfcontained] PASS: ${target} is self-contained — scanned ${filesScanned} file(s), inspected ${inspected} resource reference(s), 0 external`,
  );
}

if (import.meta.main) main();

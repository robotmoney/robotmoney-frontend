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
import { existsSync, readFileSync, statSync } from "node:fs";
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

function fail(msg: string): never {
  console.error(`[selfcontained] FAIL: ${msg}`);
  process.exit(1);
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..");
  const target = process.argv[2] ?? join(repoRoot, "dist", "frozen", "index.html");

  if (!existsSync(target)) {
    fail(`bundle not found at ${target} — run \`bun run frozen:fixtures\` first`);
  }
  const size = statSync(target).size;
  if (size === 0) fail(`bundle at ${target} is empty (0 bytes)`);

  const html = readFileSync(target, "utf8");
  if (html.trim().length === 0) fail(`bundle at ${target} contains only whitespace`);

  const { inspected, violations } = scanSelfContained(html);
  if (inspected === 0) {
    // A real frozen bundle inlines scripts/styles; zero resource constructs means
    // we are not actually looking at the baked SPA.
    fail(`bundle at ${target} has no resource-loading constructs — is this the baked SPA?`);
  }

  if (violations.length > 0) {
    console.error(`[selfcontained] FAIL: ${violations.length} external resource reference(s) in ${target}:`);
    for (const v of violations) console.error(`  - [${v.kind}] ${v.url}\n      ${v.snippet}`);
    process.exit(1);
  }

  console.log(
    `[selfcontained] PASS: ${target} is self-contained — inspected ${inspected} resource references, 0 external (${(size / 1_048_576).toFixed(2)} MB)`,
  );
}

if (import.meta.main) main();

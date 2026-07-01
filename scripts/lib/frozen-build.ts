// Single-file "frozen" build assembler. Turns the buildless SPA under
// frontend/public/ into ONE self-contained index.html that renders every view
// OFFLINE (file://, any static host) from a baked snapshot of the API — no
// server, no network, no build tools on the viewer's machine.
//
// Why one inlined file (the mechanism, documented once here):
//   The live SPA loads app JS as `type="module"` and fetches view fragments +
//   API JSON at runtime. On the file: scheme, module scripts and fetch() are
//   blocked by CORS (origin "null"), and absolute paths ("/views/…") don't
//   resolve. Inlining EVERYTHING into a single classic-script document removes
//   all three problems: the app JS is bundled to a classic (non-module) IIFE,
//   the views + baked API JSON + vendored libs are inlined, and a fetch shim
//   (frozen-boot.js) answers every request from the inlined data. Zero network.
//
// This module is pure assembly (no I/O side effects beyond reading source): the
// caller supplies the baked API data (RM_FROZEN). scripts/bake-frozen.ts feeds
// it live-backend data; the tests feed it committed fixtures.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

export type FrozenData = Record<string, unknown>;

// Vendored runtime libs — inlined from node_modules so nothing is fetched from a
// CDN at runtime. Order matters: p5 + Chart define globals the views consume;
// Alpine must run LAST (after the app bundle registers its `alpine:init`
// factories) so it fires that event with the factories already attached.
const VENDOR_LIBS = [
  "node_modules/p5/lib/p5.min.js",
  "node_modules/chart.js/dist/chart.umd.min.js",
  "node_modules/alpinejs/dist/cdn.min.js",
] as const;

// The CDN / module / config <script> tags the frozen build strips (replaced by
// the inlined vendor libs, app bundle, and baked config).
const STRIPPED_SCRIPT_RE =
  /\s*<script[^>]*\bsrc="(?:https:\/\/cdn\.jsdelivr\.net\/[^"]+|\/config\.js|\/assets\/js\/app\/main\.js)"[^>]*><\/script>/g;

const CSS_LINK_RE = /\s*<link rel="stylesheet" href="(\/assets\/css\/[^"]+)"\s*\/>/g;

// Google Fonts @import inside tokens.css — a network request; strip it so the
// build is fully offline (fonts fall back to the declared system stack).
const GOOGLE_FONTS_IMPORT_RE =
  /@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\)\s*;/g;

// JS line/paragraph separators — illegal unescaped in a JS string literal.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** Escape a JS source body so it can be safely inlined inside <script>…</script>. */
function scriptSafe(body: string): string {
  return body.replace(/<\/script/gi, "<\\/script");
}

/** JSON that is safe to embed as a JS object literal inside an inline <script>. */
function embedJson(value: unknown): string {
  // Escape "<" so a "</script>" inside any value cannot close the tag, plus the
  // two JS string-illegal separators.
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(LINE_SEP)
    .join("\\u2028")
    .split(PARA_SEP)
    .join("\\u2029");
}

/** Bundle the ES-module app graph to a single classic (non-module) IIFE string. */
export async function bundleAppJs(repoRoot: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, "frontend/public/assets/js/app/main.js")],
    format: "iife",
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    throw new Error(`frozen: app bundle failed:\n${result.logs.map(String).join("\n")}`);
  }
  const [out] = result.outputs;
  if (!out) throw new Error("frozen: app bundle produced no output");
  let js = await out.text();
  // Absolute asset paths don't resolve under file://; inline the one raster the
  // app references (the committee avatar / nav fallback) as a data URI.
  js = js.replaceAll("/assets/logo.svg", logoDataUri(repoRoot));
  return js;
}

/** Read every view fragment, keyed by the "/views/…​.html" path the router fetches. */
export function collectViews(repoRoot: string): Record<string, string> {
  const viewsDir = join(repoRoot, "frontend/public/views");
  const out: Record<string, string> = {};
  for (const rel of new Glob("**/*.html").scanSync({ cwd: viewsDir })) {
    out[`/views/${rel.split("\\").join("/")}`] = readFileSync(join(viewsDir, rel), "utf8");
  }
  return out;
}

/** The SVG logo as a data: URI so it renders under file:// with no network. */
export function logoDataUri(repoRoot: string): string {
  const svg = readFileSync(join(repoRoot, "frontend/public/assets/logo.svg"), "utf8");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Concatenate every stylesheet the shell links, stripping the web-font import. */
function inlineCss(repoRoot: string, hrefs: string[]): string {
  return hrefs
    .map((href) => readFileSync(join(repoRoot, "frontend/public", href.replace(/^\//, "")), "utf8"))
    .join("\n")
    .replace(GOOGLE_FONTS_IMPORT_RE, "");
}

/** Read the frozen-boot fetch/history shim source. */
function readFrozenBoot(repoRoot: string): string {
  return readFileSync(join(repoRoot, "frontend/public/assets/js/app/frozen-boot.js"), "utf8");
}

/**
 * Assemble the complete single-file frozen build as an HTML string.
 * The document order of the injected scripts encodes the boot contract:
 *   1. baked data (RM_FROZEN + RM_VIEWS)  — the offline snapshot
 *   2. frozen-boot                        — installs the fetch/history shim
 *   3. app bundle                         — registers alpine:init factories, boots router
 *   4. p5, Chart                          — globals the views draw with
 *   5. Alpine                             — starts LAST, fires alpine:init
 */
export interface FrozenMeta {
  bakedAt: string; // ISO timestamp
  source: string; // "backend" | "fixtures"
  backendUrl?: string;
}

export async function assembleFrozenHtml(opts: {
  repoRoot: string;
  frozenData: FrozenData;
  meta?: FrozenMeta;
}): Promise<string> {
  const { repoRoot, frozenData, meta } = opts;
  const shellPath = join(repoRoot, "frontend/public/index.html");
  let html = readFileSync(shellPath, "utf8");

  // 1. Inline CSS: collect the linked stylesheets in order, drop the <link>s.
  const cssHrefs: string[] = [];
  html = html.replace(CSS_LINK_RE, (_m, href: string) => {
    cssHrefs.push(href);
    return "";
  });
  const css = inlineCss(repoRoot, cssHrefs);

  // 2. Strip the CDN / module / config <script> tags — replaced by inlined code.
  html = html.replace(STRIPPED_SCRIPT_RE, "");

  // 3. Rewrite the one absolute asset reference in the shell (the nav logo).
  html = html.replaceAll("/assets/logo.svg", logoDataUri(repoRoot));

  // NOTE: every dynamic insertion below uses a REPLACER FUNCTION, never a string
  // replacement. String replacements interpret `$$`, `$&`, `$1`… specially, and
  // the inlined vendor/app/data payloads legitimately contain `$` sequences —
  // e.g. Alpine registers its magics with `` `$${name}` ``, so a string
  // replacement silently turns `$$` into `$` and every magic ($nextTick, $refs…)
  // loses its prefix. Function replacers return their value verbatim.

  // 4. Inline the collected CSS just before </head>.
  html = html.replace("</head>", () => `    <style>\n${css}\n    </style>\n  </head>`);

  // 5. Assemble the ordered boot scripts and inject them before </body>.
  const views = collectViews(repoRoot);
  const dataJs =
    `window.RM_FROZEN=${embedJson(frozenData)};` +
    `window.RM_VIEWS=${embedJson(views)};` +
    (meta ? `window.RM_FROZEN_META=${embedJson(meta)};` : "");
  if (meta) {
    html = html.replace(
      "<head>",
      () => `<head>\n    <!-- frozen build: baked ${meta.bakedAt} from ${meta.source}${meta.backendUrl ? ` (${meta.backendUrl})` : ""}. Renders offline (file://) with no server. -->`,
    );
  }
  const appJs = await bundleAppJs(repoRoot);
  const frozenBoot = readFrozenBoot(repoRoot);
  const vendor = VENDOR_LIBS.map((lib) => readFileSync(join(repoRoot, lib), "utf8"));

  const bootBlock =
    `<script>${scriptSafe(dataJs)}</script>\n` +
    `<script>${scriptSafe(frozenBoot)}</script>\n` +
    `<script>${scriptSafe(appJs)}</script>\n` +
    vendor.map((v) => `<script>${scriptSafe(v)}</script>`).join("\n") +
    "\n";

  html = html.replace("</body>", () => `${bootBlock}</body>`);
  return html;
}

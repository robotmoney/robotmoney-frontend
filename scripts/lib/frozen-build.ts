// Frozen "static distribution" writer. Turns the buildless SPA under
// frontend/public/ into a self-contained STATIC DIRECTORY (dist/frozen/) that
// any dumb static host — `python3 -m http.server`, GitHub Pages, S3, nginx —
// can serve with no backend, no database, and no build tools on the viewer's
// machine.
//
// How it stays server-less WITHOUT inlining everything into one file or hacking
// fetch/history (the file:// approach this replaced):
//   - The app is the real static SPA, copied verbatim. Module scripts, fetch,
//     and absolute paths all work because it's served over http://, not file://.
//   - A per-dist config.js sets RM_CONFIG.STATIC_DATA_BASE, so the ONE
//     networking boundary (app/lib/api.js) reads pre-generated JSON snapshots
//     under /data/… instead of a live API. No other code path changes.
//   - Vendored libs (p5/Chart/Alpine) are copied locally and the web-font
//     @import is dropped, so the dist references zero external resources
//     (enforced by scripts/check-frozen-selfcontained.ts).
//   - index.html is also emitted as 404.html so static hosts that support a
//     custom 404 (GitHub Pages) serve the SPA on a deep-link refresh.
//
// The caller supplies the baked API data (keyed by request pathname).
// scripts/bake-frozen.ts feeds it live-backend data; the tests feed fixtures.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FrozenData = Record<string, unknown>;

export interface FrozenMeta {
  bakedAt: string; // ISO timestamp
  source: string; // "backend" | "fixtures"
  backendUrl?: string;
}

// Vendored runtime libs, copied from node_modules so nothing loads from a CDN.
// `cdn` is the exact <script src> in the shipped index.html we rewrite to `out`.
const VENDOR = [
  { src: "node_modules/p5/lib/p5.min.js", out: "p5.min.js", cdn: "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js" },
  { src: "node_modules/chart.js/dist/chart.umd.min.js", out: "chart.umd.min.js", cdn: "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" },
  { src: "node_modules/alpinejs/dist/cdn.min.js", out: "alpinejs.cdn.min.js", cdn: "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" },
] as const;

const VENDOR_DIR = "assets/vendor";

// The web-font @import inside tokens.css — a network request; drop it so the
// dist is fully offline (fonts fall back to the declared system stack).
const GOOGLE_FONTS_IMPORT_RE = /@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\)\s*;/g;

/** Where the SPA reads its snapshots from, relative to the host root. */
export const STATIC_DATA_BASE = "/data";

function frozenConfigJs(meta?: FrozenMeta): string {
  const stamp = meta ? ` baked ${meta.bakedAt} from ${meta.source}${meta.backendUrl ? ` (${meta.backendUrl})` : ""}` : "";
  return (
    `// Frozen static distribution —${stamp}. Server-less: the SPA reads its data\n` +
    `// from pre-generated JSON under STATIC_DATA_BASE instead of a live API.\n` +
    `window.RM_CONFIG = { API_BASE_URL: "", STATIC_DATA_BASE: ${JSON.stringify(STATIC_DATA_BASE)}, FROZEN: true };\n`
  );
}

export interface FrozenDistResult {
  outDir: string;
  dataFiles: number;
  endpoints: string[];
}

/**
 * Write the complete static frozen distribution to `outDir`. Idempotent: the
 * directory is cleared first.
 */
export function writeFrozenDist(opts: {
  repoRoot: string;
  outDir: string;
  frozenData: FrozenData;
  meta?: FrozenMeta;
}): FrozenDistResult {
  const { repoRoot, outDir, frozenData, meta } = opts;

  // 1. Fresh copy of the real static SPA (index.html, config.js, assets, views).
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(repoRoot, "frontend/public"), outDir, { recursive: true });

  // 2. Localize the vendored libs and rewrite the CDN <script src>s in the shell.
  mkdirSync(join(outDir, VENDOR_DIR), { recursive: true });
  const indexPath = join(outDir, "index.html");
  let html = readFileSync(indexPath, "utf8");
  for (const lib of VENDOR) {
    cpSync(join(repoRoot, lib.src), join(outDir, VENDOR_DIR, lib.out));
    html = html.replaceAll(lib.cdn, `/${VENDOR_DIR}/${lib.out}`);
  }
  writeFileSync(indexPath, html);

  // 3. Drop the web-font @import so nothing is fetched from the network.
  const tokensPath = join(outDir, "assets/css/tokens.css");
  writeFileSync(tokensPath, readFileSync(tokensPath, "utf8").replace(GOOGLE_FONTS_IMPORT_RE, ""));

  // 4. Point the SPA at its static snapshots (overwrite the live config.js).
  writeFileSync(join(outDir, "config.js"), frozenConfigJs(meta));

  // 5. Emit each API snapshot as a static JSON file keyed by request pathname:
  //    "/api/dashboards/regime-snapshots" -> <out>/data/api/dashboards/regime-snapshots.json
  const dataRoot = join(outDir, STATIC_DATA_BASE.replace(/^\//, ""));
  const endpoints = Object.keys(frozenData).sort();
  for (const key of endpoints) {
    const file = join(dataRoot, `${key.replace(/^\//, "")}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(frozenData[key]));
  }

  // 6. SPA fallback for deep-link refreshes on hosts with a custom 404 page.
  writeFileSync(join(outDir, "404.html"), readFileSync(indexPath, "utf8"));

  return { outDir, dataFiles: endpoints.length, endpoints };
}
